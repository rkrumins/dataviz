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


# ── a demoted master is a redirect, not a failure ───────────────────────
#
# Redis answers a write on a replica with `-READONLY`, and in sentinel and
# standalone that IS what a failover looks like from the client's side: the
# pool is still pointed at the node that was the master when it connected,
# and that node has been demoted. Cluster mode never sees it — it gets
# MOVED first, which the branch above already handles — so the case was
# invisible in the only mode the tests exercised.
#
# `ReadOnlyError` is a `ResponseError`, not a `ConnectionError`, so nothing
# in the transient ladder caught it: the write failed hard, at the one
# moment re-resolving would have fixed it. redis-py re-runs
# `discover_master` on reconnect, so a rebuild lands on the node that was
# just promoted.


class _ReadOnlyError(Exception):
    """Stands in for redis.exceptions.ReadOnlyError (matched by name, as the
    cluster routing errors are, so the classifier needs no redis import)."""

    def __init__(self, msg="READONLY You can't write against a read only replica."):
        super().__init__(msg)


_ReadOnlyError.__name__ = "ReadOnlyError"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["sentinel", "standalone", "cluster"])
async def test_a_readonly_reply_re_resolves_the_master_and_retries(monkeypatch, mode):
    """In EVERY mode: the node says it is a replica, so stop talking to it
    and find the one that is not."""
    p = _provider()

    class _Cfg:
        pass

    _Cfg.mode = mode
    p._conn_cfg = _Cfg()
    p._conn_generation = 0

    rebuilds = {"n": 0}

    async def fake_rebuild(gen):
        rebuilds["n"] += 1

    monkeypatch.setattr(p, "_rebuild_graph_client_for_failover", fake_rebuild)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _ReadOnlyError()
        return "ok"

    assert await p._run_guarded(call) == "ok"
    assert calls["n"] == 2
    assert rebuilds["n"] == 1


@pytest.mark.asyncio
async def test_a_node_that_stays_readonly_eventually_gives_up(monkeypatch):
    """Retrying forever would hold the caller's whole budget against a node
    that is never going to be the master again."""
    p = _provider()

    class _Cfg:
        mode = "sentinel"

    p._conn_cfg = _Cfg()
    p._conn_generation = 0

    async def fake_rebuild(gen):
        return None

    monkeypatch.setattr(p, "_rebuild_graph_client_for_failover", fake_rebuild)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        raise _ReadOnlyError()

    with pytest.raises(Exception):
        await p._run_guarded(call)
    assert calls["n"] > 1, "never retried at all"
    assert calls["n"] <= 5, f"retried {calls['n']} times — unbounded"
