"""Unit tests for FalkorDBProvider._run_guarded transient-failure retries.

These do NOT need a live FalkorDB — they construct a provider and drive
``_run_guarded`` with a fake ``call`` that raises controlled exceptions.
The behaviour under test (Follow-up 6): a transient redis connection drop
(e.g. 'Connection reset by peer') is transparently retried with a short
backoff in ALL modes so the circuit breaker stays closed on blips, while a
non-transient query error and the per-op ``asyncio.TimeoutError`` propagate
immediately.
"""
import asyncio
from unittest.mock import AsyncMock

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from backend.app.providers.falkordb_provider import FalkorDBProvider


def _provider():
    p = FalkorDBProvider(host="x", graph_name="g")
    # A live handle: the retry path's _ensure_connected() must be the
    # documented no-op ("redis-py self-heals the pool"), not a real dial of
    # the fake host — reconnect failure aborts the retry budget by design.
    p._graph = object()
    return p


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Skip the real backoff sleeps so the suite runs in milliseconds."""
    monkeypatch.setattr(
        "backend.app.providers.falkordb_provider.asyncio.sleep", AsyncMock()
    )


@pytest.mark.asyncio
async def test_retries_transient_connection_error_then_succeeds():
    p = _provider()
    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RedisConnectionError("Connection reset by peer")
        return "ok"

    assert await p._run_guarded(call) == "ok"
    assert calls["n"] == 2  # one transparent retry


@pytest.mark.asyncio
async def test_gives_up_after_max_transient_retries():
    p = _provider()
    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        raise RedisConnectionError("Connection reset by peer")

    with pytest.raises(RedisConnectionError):
        await p._run_guarded(call)
    # initial attempt + 3 bounded retries
    assert calls["n"] == 4


@pytest.mark.asyncio
async def test_non_transient_error_propagates_without_retry():
    p = _provider()
    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        raise ValueError("bad cypher")

    with pytest.raises(ValueError):
        await p._run_guarded(call)
    assert calls["n"] == 1  # no retry on a real query error


@pytest.mark.asyncio
async def test_asyncio_timeout_is_not_retried():
    """``asyncio.TimeoutError`` is the per-op deadline, NOT a transient redis
    drop — retrying it would multiply a genuine slow-query timeout. It shares
    the class name "TimeoutError" with the redis exception, so this guards the
    isinstance-based (not name-based) classification."""
    p = _provider()
    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        raise asyncio.TimeoutError()

    with pytest.raises(asyncio.TimeoutError):
        await p._run_guarded(call)
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_cluster_routing_error_rebuilds_client_then_retries(monkeypatch):
    p = _provider()

    class _Cfg:
        mode = "cluster"

    p._conn_cfg = _Cfg()
    p._conn_generation = 0

    rebuilds = {"n": 0}

    async def fake_rebuild(gen):
        rebuilds["n"] += 1

    monkeypatch.setattr(p, "_rebuild_graph_client_for_failover", fake_rebuild)

    class MovedError(Exception):
        pass

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        if calls["n"] == 1:
            raise MovedError("MOVED 1234 host:6379")
        return "ok"

    assert await p._run_guarded(call) == "ok"
    assert calls["n"] == 2
    assert rebuilds["n"] == 1  # rebuilt the single-node client once


@pytest.mark.asyncio
async def test_null_handle_error_reconnects_then_retries(monkeypatch):
    """A graph handle nulled mid-flight (manager evicted+closed the instance
    during a job) surfaces as ``'NoneType' object has no attribute 'query'``.
    _run_guarded must reconnect (rebuild the handle) and retry rather than
    failing the job (Follow-up 9)."""
    p = _provider()
    reconnects = {"n": 0}

    async def fake_ensure():
        reconnects["n"] += 1

    monkeypatch.setattr(p, "_ensure_connected", fake_ensure)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        if calls["n"] == 1:
            raise AttributeError("'NoneType' object has no attribute 'query'")
        return "ok"

    assert await p._run_guarded(call) == "ok"
    assert calls["n"] == 2          # one retry
    assert reconnects["n"] == 1     # rebuilt the nulled handle before retrying


@pytest.mark.asyncio
async def test_unrelated_attribute_error_is_not_retried():
    """A generic AttributeError (not a nulled graph-handle deref) still
    propagates immediately — we only self-heal the NoneType.query signature."""
    p = _provider()
    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        raise AttributeError("'Foo' object has no attribute 'bar'")

    with pytest.raises(AttributeError):
        await p._run_guarded(call)
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_inflight_counter_tracks_guarded_ops():
    """The in-flight counter (used by the manager to defer eviction-close)
    is incremented during a guarded op and restored to 0 after."""
    p = _provider()
    seen = {"during": None}

    async def call():
        seen["during"] = p.inflight_ops()
        return "ok"

    assert p.inflight_ops() == 0
    await p._run_guarded(call)
    assert seen["during"] == 1
    assert p.inflight_ops() == 0
