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

from backend.app.providers.falkordb_provider import (
    FalkorDBProvider, _is_role_changed_error,
)


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


# The SAME demotion, reaching a client that was mid-QUERY rather than
# mid-write — and the spelling a rebuild actually meets.
#
# FalkorDB runs GRAPH.* on a module thread pool and BLOCKS the client for the
# duration, so a long query is a blocked client in Redis's own sense. Redis
# force-unblocks a blocked client when the instance changes role, and the
# reply is `-UNBLOCKED force unblock from blocking operation, instance state
# changed (master -> replica?)`. There is no redis-py class for it: it
# arrives as a bare ResponseError, so the name match could not see it and the
# branch above — the one that fixes this in under a second — was skipped for
# exactly the case it exists for.
#
# What it cost: the error escaped to the worker's generic handler, which
# spends a job retry. A retry re-runs EXTRACT and COMPUTE from zero
# (`falkordb_materialize`: "EXTRACT + COMPUTE always re-run"), and the attempt
# budget only resets when processed_edges advances past its high-water mark —
# which a from-zero re-run never does. So a routine shard rotation turned an
# hour of work into three of them and then a failed job.


class _Unblocked(Exception):
    """A bare ResponseError, as redis-py delivers -UNBLOCKED."""

    def __init__(self):
        super().__init__(
            "UNBLOCKED force unblock from blocking operation, "
            "instance state changed (master -> replica?)"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["sentinel", "standalone", "cluster"])
async def test_an_unblocked_reply_is_a_demotion_and_is_retried(monkeypatch, mode):
    p = _provider()

    class _Cfg:
        pass

    _Cfg.mode = mode
    p._conn_cfg = _Cfg()
    p._conn_generation = 0

    rebuilds = {"n": 0}

    async def _rebuild(gen):
        rebuilds["n"] += 1

    monkeypatch.setattr(p, "_rebuild_graph_client_for_failover", _rebuild)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _Unblocked()
        return "ok"

    assert await p._run_guarded(call) == "ok"
    assert calls["n"] == 2
    assert rebuilds["n"] == 1


def test_the_unblocked_match_stays_narrow():
    """Matched on the verb, not on "instance state changed", so it cannot
    swallow an unrelated error. Nothing in this repo issues CLIENT UNBLOCK,
    so there is no legitimate -UNBLOCKED for this to absorb."""
    assert _is_role_changed_error(_Unblocked())
    assert _is_role_changed_error(
        RuntimeError("unblocked force unblock from blocking operation"))
    for other in [
        RuntimeError("instance state changed"),
        RuntimeError("blocked client"),
        RuntimeError("NOREPLICAS Not enough good replicas to write."),
        RuntimeError("LOADING FalkorDB is loading the dataset in memory"),
    ]:
        assert not _is_role_changed_error(other), other


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

    # And it gives up AS a failover, not as the raw error. A caller that gets
    # the raw one cannot tell a promotion in progress from a query that is
    # simply wrong — and for a rebuild that difference is the whole job:
    # ProviderFailingOver parks it with its checkpoint, an unclassified error
    # spends a retry, and a retry re-runs extract and compute from zero.
    from backend.common.adapters import ProviderFailingOver

    with pytest.raises(ProviderFailingOver):
        await p._run_guarded(call)
    assert calls["n"] > 1, "never retried at all"
    assert calls["n"] <= 5, f"retried {calls['n']} times — unbounded"


@pytest.mark.asyncio
async def test_a_demotion_waits_as_long_as_a_refused_connection_does(monkeypatch):
    """The budget has to outlast the event. A cluster does not DECLARE a
    failover until ``cluster-node-timeout`` — 15s on the shipped overlay —
    and then holds an election, while the transient ladder is 1.75s spent
    back to back with no wait at all. All three retries landed on the same
    demoted node before the promotion any of them was waiting for."""
    import backend.app.providers.falkordb_provider as prov
    from backend.common.adapters import ProviderFailingOver

    p = _provider()

    class _Cfg:
        mode = "cluster"

    p._conn_cfg = _Cfg()
    p._conn_generation = 0

    async def fake_rebuild(gen):
        return None

    monkeypatch.setattr(p, "_rebuild_graph_client_for_failover", fake_rebuild)

    slept: list = []

    async def _record(delay):
        slept.append(delay)

    monkeypatch.setattr(prov.asyncio, "sleep", _record)

    async def call():
        raise _Unblocked()

    with pytest.raises(ProviderFailingOver):
        await p._run_guarded(call)

    assert slept == list(prov._REFUSED_RETRY_BACKOFFS)
    assert sum(slept) > 15.0, "shorter than cluster-node-timeout"


@pytest.mark.asyncio
async def test_a_read_leaves_after_one_re_resolve(monkeypatch):
    """A read does not get the long wait. ``_retry_wall_clock`` budgets a
    read for the TRANSIENT window only, so an escalated ladder would be cut
    short by the deadline and surface as asyncio.TimeoutError — which nothing
    reads as a failover. One re-resolve, then say what it is."""
    import backend.app.providers.falkordb_provider as prov
    from backend.common.adapters import ProviderFailingOver

    p = _provider()

    class _Cfg:
        mode = "cluster"

    p._conn_cfg = _Cfg()
    p._conn_generation = 0

    async def fake_rebuild(gen):
        return None

    monkeypatch.setattr(p, "_rebuild_graph_client_for_failover", fake_rebuild)

    slept: list = []

    async def _record(delay):
        slept.append(delay)

    monkeypatch.setattr(prov.asyncio, "sleep", _record)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        raise _Unblocked()

    with pytest.raises(ProviderFailingOver):
        await p._run_guarded(call, read_only=True)

    assert calls["n"] == prov._READ_REFUSED_RETRIES + 1
    assert sum(slept) < 2.0, "a read waited out a failover"


@pytest.mark.asyncio
async def test_a_pinned_read_does_not_wait_out_a_failover(monkeypatch):
    """A pinned read was addressed to a replica the router chose, and its
    caller holds a master to fall back on. Spending 17.5s here would make a
    logged-in user wait out a promotion to reach a node that could have
    answered at once — so it keeps the fast schedule and raises the
    underlying error, which is what benches the replica."""
    import backend.app.providers.falkordb_provider as prov
    from backend.common.adapters import ProviderFailingOver

    p = _provider()

    class _Cfg:
        mode = "cluster"

    p._conn_cfg = _Cfg()
    p._conn_generation = 0
    monkeypatch.setattr(prov.asyncio, "sleep", AsyncMock())

    async def call():
        raise _Unblocked()

    with pytest.raises(Exception) as info:
        await p._run_guarded(call, read_only=True, pinned=True)
    assert not isinstance(info.value, ProviderFailingOver)
