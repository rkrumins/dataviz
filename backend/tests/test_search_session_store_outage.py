"""The cache Redis that keeps search sessions failing is the cache's outage,
not the graph's.

A raw Redis error from it reached the provider's breaker as a graph-store
outage — the same redis exception FalkorDB raises — and one cache blip
refused every graph read on the source for the breaker's reset window. And a
commit that failed kept the session's lease to its expiry, so every request
after it only waited — and with the cache gone, giving it back fails too.
"""
from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from backend.app.main import _session_store_unavailable_handler, app
from backend.app.providers.falkordb_search import engine as engine_mod
from backend.app.providers.falkordb_search.plan import Unit
from backend.app.providers.falkordb_search.session import (
    MemorySessionStore,
    RedisSessionStore,
    Session,
)
from backend.app.services.deep_search import SessionStoreUnavailable, get_deep_search_settings
from backend.common.adapters.circuit import CircuitBreakerProxy, ProviderUnavailable


class _DownRedis:
    """A Redis client every call of which fails, as one that went away does."""

    def __getattr__(self, name):
        async def fail(*args, **kwargs):
            raise RedisConnectionError("Error 111 connecting to cache:6379. Connection refused.")
        return fail

    def pipeline(self, transaction=True):
        raise RedisConnectionError("Error 111 connecting to cache:6379. Connection refused.")


@pytest.mark.parametrize("call", [
    lambda s: s.load("s1"),
    lambda s: s.save(Session("s1", "q", "1", None, 0, [], [], 0), None, 60),
    lambda s: s.lease("s1", 1000),
    lambda s: s.release("s1", "t"),
    lambda s: s.read_tallies("s1", ["urn:a"]),
    lambda s: s.top_tallies("s1", 5),
])
async def test_a_cache_that_fails_is_the_session_stores_outage(call):
    with pytest.raises(SessionStoreUnavailable, match="did not answer"):
        await call(RedisSessionStore(_DownRedis(), "ns"))


class _Provider:
    def __init__(self, exc) -> None:
        self.exc, self.calls = exc, 0

    @property
    def name(self) -> str:
        return "p"

    async def deep_search_session(self, *_args, **_kwargs):
        self.calls += 1
        raise self.exc


async def test_the_cache_failing_does_not_open_the_graphs_breaker():
    target = _Provider(SessionStoreUnavailable("the cache keeping search sessions did not answer"))
    proxy = CircuitBreakerProxy(target, name="p", fail_max=1)
    for _ in range(3):
        with pytest.raises(SessionStoreUnavailable):
            await proxy.deep_search_session()
    assert proxy.breaker_state == "closed"
    assert target.calls == 3, "every call still reaches the provider"


async def test_as_the_raw_redis_error_it_used_to_open_it():
    """Why it needs its own exception: the store's error, raw, is the very
    one the breaker counts for FalkorDB."""
    target = _Provider(RedisConnectionError("Error 111 connecting to cache:6379."))
    proxy = CircuitBreakerProxy(target, name="p", fail_max=1)
    with pytest.raises(ProviderUnavailable):
        await proxy.deep_search_session()
    assert proxy.breaker_state == "open"


async def test_it_is_answered_as_a_pause_to_wait_out():
    assert app.exception_handlers[SessionStoreUnavailable] is _session_store_unavailable_handler
    request = SimpleNamespace(url=SimpleNamespace(path="/api/v1/ws-1/graph/search/advanced"))
    response = await _session_store_unavailable_handler(
        request, SessionStoreUnavailable("the cache keeping search sessions did not answer"))
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "2"
    detail = json.loads(response.body)["detail"]
    assert detail["code"] == "SEARCH_STORE_UNAVAILABLE"
    assert "progress" in detail["reason"]


async def test_a_commit_that_fails_still_gives_the_lease_back():
    store = MemorySessionStore()
    session = Session("s1", "q", "1", None, 0, [Unit("range", "A", size=1)], [], 1)
    await store.save(session, None, 60)

    async def broken_save(*args, **kwargs):
        raise SessionStoreUnavailable("the cache keeping search sessions did not answer")

    class _Work:
        async def begin(self, store_):
            pass

        async def unit(self, unit, timeout_s):
            return 1

        def fold(self, unit, result):
            pass

        def commit(self):
            return {}

    store.save = broken_save
    with pytest.raises(SessionStoreUnavailable):
        await engine_mod._advance(session, False, store, _Work(), time.monotonic() + 1,
                                  get_deep_search_settings())
    assert await store.lease("s1", 1000) is not None, "the next request may take it"


async def test_a_lease_the_cache_could_not_take_back_is_given_back_when_it_answers(monkeypatch):
    monkeypatch.setattr(engine_mod, "_RELEASE_RETRY_S", 0.01)
    store = MemorySessionStore()
    session = Session("s1", "q", "1", None, 0, [Unit("range", "A", size=1)], [], 1)
    await store.save(session, None, 60)
    gone = SessionStoreUnavailable("the cache keeping search sessions did not answer")

    async def broken_save(*args, **kwargs):
        raise gone

    release, refused = store.release, []

    async def release_once_back(sid, token):
        if len(refused) < 2:            # the cache still away, twice
            refused.append(token)
            raise gone
        await release(sid, token)

    class _Work:
        async def begin(self, store_):
            pass

        async def unit(self, unit, timeout_s):
            return 1

        def fold(self, unit, result):
            pass

        def commit(self):
            return {}

    store.save, store.release = broken_save, release_once_back
    with pytest.raises(SessionStoreUnavailable):
        await engine_mod._advance(session, False, store, _Work(), time.monotonic() + 1,
                                  get_deep_search_settings())
    assert await store.lease("s1", 1000) is None, "still held while the cache is away"
    for _ in range(100):
        if not engine_mod._RELEASING:
            break
        await asyncio.sleep(0.01)
    assert len(refused) == 2
    assert await store.lease("s1", 1000) is not None, "given back once the cache answered"


async def test_a_late_give_back_never_takes_another_requests_lease(monkeypatch):
    monkeypatch.setattr(engine_mod, "_RELEASE_RETRY_S", 0.01)
    store = MemorySessionStore()
    mine = await store.lease("s1", 1)          # lapses at once
    await asyncio.sleep(0.01)
    theirs = await store.lease("s1", 60_000)
    assert theirs is not None
    engine_mod._release_later(store, "s1", mine, 1.0)
    for _ in range(100):
        if not engine_mod._RELEASING:
            break
        await asyncio.sleep(0.01)
    assert await store.lease("s1", 1000) is None, "the other request still holds it"
