"""One replica builds a cold document; the others wait for its result.

The single-flight in front of every build is per process, so without a claim
every replica that missed a cold key built it at once — after a deploy, and
at midnight for every activity fold — and the cost of a cold document grew
with the size of the fleet. Pinned here: a replica that finds a build claimed
waits for its result instead of building; it builds itself when the claim
ends without one; it gives up with a retry hint rather than waiting past its
request; a claim is released however its build ends; and without Redis every
replica simply builds for itself, as before.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from backend.app.common.bulkhead import Busy
from backend.app.services import analytics_cache
from backend.app.services.aggregation import redis_client

pytestmark = pytest.mark.asyncio

KEY = "activity:fold:test"
CLAIM = f"{analytics_cache._PREFIX}{KEY}:building"


class _Redis:
    """Just what the cache asks of Redis."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.data:
            return None
        self.data[key] = value
        return True

    async def delete(self, key):
        self.data.pop(key, None)


@pytest.fixture
def redis(monkeypatch):
    fake = _Redis()
    monkeypatch.setattr(redis_client, "get_redis", lambda: fake)
    monkeypatch.setattr(analytics_cache, "_redis_down_until", 0.0)
    monkeypatch.setattr(analytics_cache, "_PEER_POLL_SECONDS", 0.01)
    analytics_cache.clear()
    yield fake
    analytics_cache.clear()


def _never_built():
    async def build():
        raise AssertionError("built a document another replica was building")
    return build


async def test_a_claimed_build_is_awaited_not_repeated(redis):
    redis.data[CLAIM] = "1"  # another replica is building it

    async def _other_replica_finishes():
        await asyncio.sleep(0.05)
        redis.data[analytics_cache._PREFIX + KEY] = json.dumps({"by": "peer"})
        del redis.data[CLAIM]

    peer = asyncio.create_task(_other_replica_finishes())
    assert await analytics_cache.cached(KEY, _never_built(), memory=False) == {"by": "peer"}
    await peer


async def test_a_claim_that_ends_without_a_result_is_taken_over(redis):
    redis.data[CLAIM] = "1"

    async def _other_replica_fails():
        await asyncio.sleep(0.05)
        del redis.data[CLAIM]

    async def build():
        return {"by": "me"}

    peer = asyncio.create_task(_other_replica_fails())
    assert await analytics_cache.cached(KEY, build, memory=False) == {"by": "me"}
    await peer
    assert CLAIM not in redis.data
    assert json.loads(redis.data[analytics_cache._PREFIX + KEY]) == {"by": "me"}


async def test_a_build_that_takes_too_long_sends_the_reader_back_later(redis, monkeypatch):
    """Inside the request's own timeout: a 429 to retry, not a 504."""
    monkeypatch.setattr(analytics_cache, "_PEER_WAIT_SECONDS", 0.05)
    redis.data[CLAIM] = "1"
    with pytest.raises(Busy) as refused:
        await analytics_cache.cached(KEY, _never_built(), memory=False)
    assert refused.value.retry_after_seconds > 0
    assert redis.data[CLAIM] == "1", "another replica's claim is not this one's to release"


async def test_a_claim_is_released_however_its_build_ends(redis):
    async def fails():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        await analytics_cache.cached(KEY, fails, memory=False)
    assert CLAIM not in redis.data

    async def build():
        return {"ok": True}

    assert await analytics_cache.cached(KEY, build, memory=False) == {"ok": True}
    assert CLAIM not in redis.data


async def test_without_redis_every_replica_builds_for_itself(monkeypatch):
    def _down():
        raise ConnectionError("redis is down")

    monkeypatch.setattr(redis_client, "get_redis", _down)
    monkeypatch.setattr(analytics_cache, "_redis_down_until", 0.0)
    analytics_cache.clear()
    built = 0

    async def build():
        nonlocal built
        built += 1
        return {"ok": True}

    assert await analytics_cache.cached(KEY, build, memory=False) == {"ok": True}
    assert built == 1
