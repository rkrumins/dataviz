"""The warmer's contract: readers never build, and a broken warmer never breaks
the dashboard.

These are the two properties that matter at scale. The first is why it exists;
the second is why it is safe to add — a precompute that can take the page down
when it fails is a worse trade than the stall it removes.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from backend.app.db.repositories import analytics_repo
from backend.app.services import analytics_cache, analytics_warmer

pytestmark = pytest.mark.asyncio

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clean_cache():
    analytics_cache.clear()
    yield
    analytics_cache.clear()


async def test_a_warm_pass_fills_the_keys_readers_look_up(db_session, monkeypatch):
    """The whole point, stated as one assertion.

    The warmer and the reader must agree on the key. They share
    ``document_key`` precisely so they cannot drift, and this fails loudly if
    someone ever gives one of them its own copy.
    """
    # Redis is not up in tests; `put` still populates the in-process tier, so
    # assert against that rather than against the Redis return value.
    await analytics_warmer.warm_once(db_session, ttl=900)

    for days in analytics_warmer.WARM_WINDOWS:
        for surface in ("summary", "workspaces"):
            key = analytics_cache.document_key(surface, {"days": days})
            assert analytics_cache._memory_get(key) is not None, (
                f"{surface}/{days}d was not warmed into the key readers use"
            )


async def test_a_warmed_reader_does_not_build(db_session, monkeypatch):
    """A read after a warm pass costs nothing — that is the stall this removes."""
    await analytics_warmer.warm_once(db_session, ttl=900)

    built = False

    async def _should_not_run():
        nonlocal built
        built = True
        return {"rebuilt": True}

    key = analytics_cache.document_key("summary", {"days": 30})
    doc = await analytics_cache.cached(key, _should_not_run)
    assert built is False, "a warmed key still rebuilt on read"
    assert "totals" in doc


async def test_one_window_failing_does_not_abandon_the_pass(db_session, monkeypatch):
    """A window that raises leaves its old entry alone and the others land.

    Dropping the whole pass would send every reader back to read-through at
    once — the exact stampede the warmer exists to prevent, triggered by the
    warmer itself.
    """
    real = analytics_repo.platform_summary
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if kwargs.get("days") == 30:
            raise RuntimeError("boom")
        return await real(*args, **kwargs)

    monkeypatch.setattr(analytics_repo, "platform_summary", flaky)
    await analytics_warmer.warm_once(db_session, ttl=900)

    assert analytics_cache._memory_get(
        analytics_cache.document_key("summary", {"days": 30})) is None
    # Every other window still landed.
    assert analytics_cache._memory_get(
        analytics_cache.document_key("summary", {"days": 7})) is not None
    assert analytics_cache._memory_get(
        analytics_cache.document_key("workspaces", {"days": 30})) is not None


async def test_the_loop_survives_a_failing_pass(db_session, monkeypatch):
    """A warmer that dies on one exception stops warming forever, silently."""
    passes = {"n": 0}

    async def explode(session, *, ttl=None):
        passes["n"] += 1
        raise RuntimeError("nope")

    monkeypatch.setattr(analytics_warmer, "warm_once", explode)

    class _Factory:
        def __call__(self):
            return self

        async def __aenter__(self):
            return None

        async def __aexit__(self, *exc):
            return False

    shutdown = asyncio.Event()
    task = asyncio.create_task(
        analytics_warmer.run_warmer(_Factory(), shutdown, interval=0.05))
    await asyncio.sleep(0.2)
    shutdown.set()
    await asyncio.wait_for(task, timeout=2)

    assert passes["n"] >= 2, "the loop stopped after its first failure"


def test_the_interval_cannot_be_configured_into_a_load_generator(monkeypatch):
    """Each pass is ~25 grouped queries per window; a 1s interval is not a
    faster dashboard, it is the load the warmer was added to remove."""
    monkeypatch.setenv("ANALYTICS_WARM_INTERVAL_SECONDS", "1")
    assert analytics_warmer.interval_seconds() == 30.0

    monkeypatch.setenv("ANALYTICS_WARM_INTERVAL_SECONDS", "nonsense")
    assert analytics_warmer.interval_seconds() == analytics_warmer._DEFAULT_INTERVAL_SECONDS

    monkeypatch.setenv("ANALYTICS_WARM_INTERVAL_SECONDS", "600")
    assert analytics_warmer.interval_seconds() == 600.0
