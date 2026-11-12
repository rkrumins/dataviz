"""Putting a past revision together stays within bounds — no database.

A web process keeps past revisions' deltas within a budget of their own
(``GRAPHVER_REVISION_CACHE_ENTRIES``): a new revision evicts only older revisions, a draft's or a
fork's delta evicts revisions first, and the newest is kept whatever its size. A new revision is
put together on one of ``GRAPHVER_REVISION_BUILDS_MAX`` turns; a reader waits up to
``GRAPHVER_REVISION_BUILD_WAIT_MS`` for one and is then told to try again (503 ``revision_busy``,
Retry-After), while a reader of a revision already being put together joins it without a turn. A
failed build gives its turn back; drafts take none. Both refusals map to HTTP app-wide.
"""
import asyncio

import pytest

from backend.app.providers import draft_overlay_provider as dop
from backend.app.services.versioning import config as vconfig
from backend.app.services.versioning.errors import HTTP_MAPPED, RevisionBusy, StateTooLarge


class _Delta:
    """What the cache reads of a delta: its size, and no patch set to extend."""

    def __init__(self, size):
        self.size = size
        self.raw = None


def _rev(k, head=9):
    return ("g", f"main@{k}", ("rev", k, head), ("CONTAINS",))


def _draft(branch):
    return ("g", branch, ("v", 1, 1, "open"), ("CONTAINS",))


def _of(size):
    async def build():
        return _Delta(size)
    return build


def _fill(cache, *items):
    async def run():
        for key, size in items:
            await cache.get(key, _of(size))
        return list(cache._items)
    return asyncio.run(run())


def test_revisions_keep_to_their_budget_and_never_evict_a_draft():
    cache = dop._DeltaCache(max_entries=100, max_revision_entries=50)
    held = _fill(cache, (_draft("d1"), 40), (_rev(1), 30), (_rev(2), 30))
    assert held == [_draft("d1"), _rev(2)]
    assert (cache._held, cache._revision_held) == (70, 30)


def test_a_drafts_delta_evicts_revisions_first():
    cache = dop._DeltaCache(max_entries=100, max_revision_entries=100)
    held = _fill(cache, (_draft("d1"), 30), (_rev(1), 30), (_rev(2), 30), (_draft("d2"), 30))
    assert held == [_draft("d1"), _rev(2), _draft("d2")]      # the least recently read revision
    assert (cache._held, cache._revision_held) == (90, 30)


def test_the_newest_revision_is_kept_whatever_its_size():
    cache = dop._DeltaCache(max_entries=100, max_revision_entries=10)
    assert _fill(cache, (_rev(1), 5), (_rev(2), 500)) == [_rev(2)]


@pytest.fixture()
def one_turn(monkeypatch):
    monkeypatch.setattr(vconfig, "REVISION_BUILDS_MAX", 1)
    monkeypatch.setattr(vconfig, "REVISION_BUILD_WAIT_MS", 50)


def test_a_new_revision_waits_for_a_turn_and_is_told_to_retry(one_turn):
    cache = dop._DeltaCache()

    async def run():
        gate = asyncio.Event()

        async def slow():
            await gate.wait()
            return _Delta(1)
        first = asyncio.ensure_future(cache.get(_rev(1), slow))
        for _ in range(3):
            await asyncio.sleep(0)                  # it takes the only turn
        follower = asyncio.ensure_future(cache.get(_rev(1), slow))   # joins: needs no turn
        with pytest.raises(RevisionBusy) as busy:
            await cache.get(_rev(2), _of(2))       # waits out the wait, then is refused
        gate.set()
        assert (await first) is (await follower)
        assert (await cache.get(_rev(2), _of(2))).size == 2     # the turn came back
        return busy.value

    exc = asyncio.run(run())
    assert exc.status_code == 503 and exc.headers == {"Retry-After": "2"}
    assert exc.detail["type"] == "revision_busy" and exc.detail["reason"] == "builds_saturated"
    assert exc.detail["retryable"] is True


def test_a_failed_build_gives_its_turn_back_and_a_draft_takes_none(one_turn):
    cache = dop._DeltaCache()

    async def run():
        async def broken():
            raise RuntimeError("the database went away")
        with pytest.raises(RuntimeError):
            await cache.get(_rev(1), broken)
        gate = asyncio.Event()

        async def slow():
            await gate.wait()
            return _Delta(1)
        held = asyncio.ensure_future(cache.get(_rev(2), slow))   # the turn, after the failure
        for _ in range(3):
            await asyncio.sleep(0)
        assert (await cache.get(_draft("d1"), _of(3))).size == 3      # no turn to wait for
        gate.set()
        return await held

    assert asyncio.run(run()).size == 1


def test_both_refusals_answer_as_http_everywhere():
    assert RevisionBusy in HTTP_MAPPED and StateTooLarge in HTTP_MAPPED
    exc = StateTooLarge(50_001, 50_000)
    assert exc.status_code == 409
    assert exc.detail["type"] == "state_too_large" and exc.detail["limit"] == 50_000
