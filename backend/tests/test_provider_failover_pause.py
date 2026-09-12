"""A shard being replaced is a pause for the people using it, not an outage.

What every user of a graph saw while one of its nodes restarted: "Provider
XYZ unavailable: Circuit open; will probe downstream again in ~28s". Three
refused reads opened the breaker, and it then answered EVERY reader with
that text for its whole reset window — long after the promoted replica was
serving. The text names no node, reads like a defect in the application,
and a canvas that had perfectly good cached data showed an error instead.

A node coming back is now its own signal: the breaker never opens on it,
one read pays for the discovery and the rest are answered from a short
memo, the canvas keeps the last good document with a reason, and the
rebuild treats it as a wait rather than a lost attempt.
"""
from __future__ import annotations

import asyncio
import time
import types

import pytest

from backend.common.adapters import (
    CircuitBreakerProxy,
    ProviderFailingOver,
    ProviderLoading,
    ProviderUnavailable,
)
from backend.app.providers.falkordb_provider import (
    FalkorDBProvider,
    _FAILING_OVER_MEMO_S,
    _pressure_kind,
    _refused_endpoint,
)


def _run(coro):
    return asyncio.run(coro)


# The class redis-py actually raises — the builtin of the same name is not
# what a refused connect arrives as, and the retry ladder matches by type.
from redis.exceptions import ConnectionError as RedisConnectionError

REFUSED = RedisConnectionError(
    "Error 111 connecting to 10.0.0.3:6379. Connection refused."
)


class _Target:
    """A provider double for the breaker proxy."""

    def __init__(self, exc):
        self.calls = 0
        self.exc = exc

    @property
    def name(self):
        return "Target"

    async def get_stats(self):
        self.calls += 1
        if self.exc is not None:
            raise self.exc
        return {"nodes": 1}

    async def close(self):
        return None


# ── the breaker ──────────────────────────────────────────────────────────


async def test_a_node_failing_over_never_opens_the_breaker():
    proxy = CircuitBreakerProxy(
        _Target(ProviderFailingOver("g", "node 10.0.0.3:6379 is failing over",
                                    endpoint="10.0.0.3:6379")),
        name="test", fail_max=3,
    )
    for _ in range(10):
        with pytest.raises(ProviderFailingOver):
            await proxy.get_stats()
    # Ten in a row, and the next reader still gets a real attempt — where
    # three used to buy everyone 30s of "Circuit open".
    assert proxy.breaker_state == "closed"


async def test_a_store_that_is_genuinely_gone_still_opens_it():
    """The breaker's job is unchanged for everything else."""
    target = _Target(REFUSED)
    proxy = CircuitBreakerProxy(target, name="test", fail_max=3)
    for _ in range(3):
        with pytest.raises(ProviderUnavailable):
            await proxy.get_stats()
    assert proxy.breaker_state == "open"
    t0 = time.monotonic()
    with pytest.raises(ProviderUnavailable):
        await proxy.get_stats()
    assert (time.monotonic() - t0) * 1000 < 5           # fast-fail, no I/O
    assert target.calls == 3                            # nothing dialled it again


def test_the_failover_signal_carries_the_node_and_a_short_retry():
    exc = ProviderFailingOver("g", "restarting", endpoint="10.0.0.3:6379")
    assert exc.endpoint == "10.0.0.3:6379"
    assert exc.retry_after_seconds == 3                  # seconds, not half a minute
    assert isinstance(exc, ProviderUnavailable)          # existing handlers still match
    # And the pipeline reads it as the kind of pressure you wait out.
    assert _pressure_kind(exc) == "connection"
    assert _pressure_kind(ProviderLoading("g", "loading")) is None


def test_the_endpoint_is_read_out_of_what_redis_actually_says():
    assert _refused_endpoint(REFUSED) == "10.0.0.3:6379"
    wrapped = RuntimeError("wrapped")
    wrapped.__cause__ = RedisConnectionError(
        "Error 111 connecting to falkordb-2.falkordb.svc:6379. Connection refused."
    )
    assert _refused_endpoint(wrapped) == "falkordb-2.falkordb.svc:6379"
    assert _refused_endpoint(ValueError("nothing here")) is None


# ── the read path ────────────────────────────────────────────────────────


def _provider(*, mode="cluster"):
    p = object.__new__(FalkorDBProvider)
    p._graph_name = "g1"
    p._host, p._port = "10.0.0.3", 6379
    p._conn_cfg = types.SimpleNamespace(mode=mode, host="10.0.0.3", port=6379)
    p._inflight = 0
    p._conn_generation = 0
    p._failing_over_until = 0.0
    p._failing_over_endpoint = None

    async def _rebuild(_gen):
        p.rebuilds = getattr(p, "rebuilds", 0) + 1

    async def _ensure():
        p.redials = getattr(p, "redials", 0) + 1

    p._rebuild_graph_client_for_failover = _rebuild
    p._ensure_connected = _ensure
    return p


def test_a_read_gives_up_after_one_re_resolve_instead_of_holding_a_slot():
    """A person waiting on a canvas is not served by seventeen seconds of
    retries: the query semaphore has a hundred of them behind it."""
    p = _provider()
    calls = []
    slept = []

    async def _call():
        calls.append(1)
        raise REFUSED

    async def _sleep(s):
        slept.append(s)

    original = asyncio.sleep
    asyncio.sleep = _sleep
    try:
        with pytest.raises(ProviderFailingOver) as exc:
            _run(p._run_guarded(_call, read_only=True))
    finally:
        asyncio.sleep = original

    assert len(calls) == 2                       # the read, then one re-resolve
    assert p.rebuilds == 1                       # which asked the cluster, not the corpse
    assert sum(slept) <= 1.0                     # under a second, not the write window
    assert exc.value.endpoint == "10.0.0.3:6379"
    assert exc.value.retry_after_seconds == 3


def test_the_next_readers_are_answered_without_dialling_a_dead_node():
    """The point of the memo: a hundred concurrent readers of one graph do
    not open a hundred sockets to a node that is not there."""
    p = _provider()
    calls = []

    async def _call():
        calls.append(1)
        raise REFUSED

    async def _sleep(_s):
        return None

    original = asyncio.sleep
    asyncio.sleep = _sleep
    try:
        with pytest.raises(ProviderFailingOver):
            _run(p._run_guarded(_call, read_only=True))
        first = len(calls)
        for _ in range(20):
            with pytest.raises(ProviderFailingOver) as exc:
                _run(p._run_guarded(_call, read_only=True))
        assert len(calls) == first               # not one more socket
        assert exc.value.endpoint == "10.0.0.3:6379"

        # It expires on its own — a memo that outlived the failover would be
        # its own outage. The next read after the window dials again.
        assert 0 < _FAILING_OVER_MEMO_S <= 5
        p._failing_over_until = time.monotonic() - 0.01
        with pytest.raises(ProviderFailingOver):
            _run(p._run_guarded(_call, read_only=True))
        assert len(calls) > first

        # And a write never consults it: the rebuild is the one caller that
        # should keep trying, and when the node answers the memo is dropped
        # for every reader at once.
        p._failing_over_until = time.monotonic() + _FAILING_OVER_MEMO_S

        async def _ok():
            return "rows"

        assert _run(p._run_guarded(_ok)) == "rows"
        assert p._failing_over_until == 0.0
    finally:
        asyncio.sleep = original


def test_a_write_still_waits_out_the_whole_failover_window():
    """Writes are not user-facing and cannot be re-issued cheaply, so the
    rebuild's own wait — the one that covers cluster-node-timeout plus an
    election — is not cut short by the read-side fail-fast."""
    from backend.app.providers.falkordb_provider import _REFUSED_RETRY_BACKOFFS

    p = _provider()
    calls = []
    slept = []

    async def _call():
        calls.append(1)
        raise REFUSED

    async def _sleep(s):
        slept.append(s)

    original = asyncio.sleep
    asyncio.sleep = _sleep
    try:
        with pytest.raises(ProviderFailingOver):
            _run(p._run_guarded(_call))
    finally:
        asyncio.sleep = original

    assert len(calls) == len(_REFUSED_RETRY_BACKOFFS) + 1
    assert sum(slept) == sum(_REFUSED_RETRY_BACKOFFS) >= 15.0
    # ...and what comes out is still the wait-for-it signal, so the pipeline
    # holds its checkpoint instead of the breaker counting a dead pod.
    assert _pressure_kind(ProviderFailingOver("g", "x")) == "connection"


def test_a_read_in_standalone_mode_is_untouched():
    """There is no promoted replica to find: the old transient behaviour is
    the right one, and the failover signal would be a lie."""
    p = _provider(mode="standalone")
    calls = []

    async def _call():
        calls.append(1)
        raise REFUSED

    async def _sleep(_s):
        return None

    original = asyncio.sleep
    asyncio.sleep = _sleep
    try:
        with pytest.raises(RedisConnectionError):
            _run(p._run_guarded(_call, read_only=True))
    finally:
        asyncio.sleep = original
    assert len(calls) == 4                       # the plain transient schedule
    assert getattr(p, "rebuilds", 0) == 0        # nothing to re-resolve


# ── what the ladders must NOT do with it ─────────────────────────────────


def test_the_read_ladders_do_not_narrow_against_an_absent_node():
    import inspect

    from backend.app.providers import falkordb_provider as fp

    cells = inspect.getsource(fp.FalkorDBProvider.get_aggregated_edges_between)
    assert 'if kind == "connection":' in cells
    ladder = inspect.getsource(fp.FalkorDBProvider._read_with_ladder)
    assert 'if kind is None or kind == "connection":' in ladder


# ── the HTTP contract ────────────────────────────────────────────────────


def test_the_response_names_the_node_and_asks_for_a_retry_in_seconds():
    import inspect

    from backend.app import main

    src = inspect.getsource(main._provider_failing_over_handler)
    assert '"PROVIDER_FAILING_OVER"' in src
    assert '"endpoint": exc.endpoint' in src
    assert 'str(exc.retry_after_seconds)' in src

    # And the generic one stops showing breaker internals as the reason.
    unavailable = inspect.getsource(main._provider_unavailable_handler)
    assert '"technical": exc.reason' in unavailable
    assert "retrying automatically" in unavailable


def test_the_canvas_says_why_the_answer_is_the_old_one():
    """The cache already stood in for an unreachable provider; what it never
    did was say so, and "stale" with no reason reads as neglected data."""
    import inspect
    import types

    from backend.app.api.v1.endpoints import graph as graph_ep

    served = types.SimpleNamespace(stale=False, stale_reason=None)
    response = types.SimpleNamespace(headers={"X-Cache-Status": "stale-fallback"})
    graph_ep.label_failover(response, served, {"endpoint": "10.0.0.3:6379"})
    assert served.stale is True and served.stale_reason == "failing_over"
    assert response.headers["Retry-After"] == "3"
    assert response.headers["X-Provider-Failing-Over"] == "10.0.0.3:6379"

    # A failover the retries absorbed changed nothing on screen: no banner.
    fresh = types.SimpleNamespace(stale=False, stale_reason=None)
    live = types.SimpleNamespace(headers={})
    graph_ep.label_failover(live, fresh, {"endpoint": "10.0.0.3:6379"})
    assert fresh.stale is False and "Retry-After" not in live.headers

    # An answer that was already stale for its own reason keeps it.
    older = types.SimpleNamespace(stale=True, stale_reason="source_changed")
    graph_ep.label_failover(
        types.SimpleNamespace(headers={"X-Cache-Status": "stale-fallback"}),
        older, {"endpoint": "x"},
    )
    assert older.stale_reason == "source_changed"

    # And all three routes that serve a canvas are wired to it.
    from backend.app.api.v1.endpoints import canvas as canvas_ep

    for src in (
        inspect.getsource(graph_ep.get_aggregated_edges),
        inspect.getsource(canvas_ep.canvas_bootstrap),
        inspect.getsource(canvas_ep.canvas_expand),
    ):
        assert "watch_for_failover(" in src and "label_failover(" in src


def test_the_worker_waits_out_a_failover_without_spending_an_attempt():
    import inspect

    from backend.app.services.aggregation.worker import (
        _FAILOVER_PARKS_MAX, AggregationWorker,
    )

    src = inspect.getsource(AggregationWorker._materialize_with_retries)
    park = src.index("except ProviderFailingOver as e:")
    counting = src.index("except ProviderUnavailable as e:")
    assert park < counting                       # matched before the counting clause
    assert "failover_parks += 1" in src
    assert _FAILOVER_PARKS_MAX >= 5              # and bounded: forever is a failure


# ── one dead shard is not a dead cluster ─────────────────────────────────


def test_a_shard_whose_reconnect_fails_does_not_open_the_breaker_for_the_others():
    """The breaker is per PROVIDER, and on a cluster a provider is every
    shard. Raising the raw reconnect error counted one shard being replaced
    against a breaker that, once open, refuses every graph on every OTHER
    shard — the healthy two thirds of a fleet stopped answering because a
    third was gone. The two branches either side already report a refused
    cluster node as a failover; a reconnect that could not reach it is the
    same fact, learned one step later."""
    p = _provider(mode="cluster")

    async def _rebuild_fails(_gen):
        raise REFUSED

    p._rebuild_graph_client_for_failover = _rebuild_fails
    p._ensure_connected = _rebuild_fails

    async def _call():
        raise REFUSED

    original = asyncio.sleep
    asyncio.sleep = lambda s: _noop()
    try:
        with pytest.raises(ProviderFailingOver) as exc:
            _run(p._run_guarded(_call))
    finally:
        asyncio.sleep = original
    assert exc.value.endpoint == "10.0.0.3:6379"


async def _noop():
    return None


def test_a_reconnect_that_fails_on_credentials_still_opens_it():
    """The narrowing that keeps the change honest: a reconnect refused for a
    password is a real provider fault, the breaker is the right place for
    it, and dressing it as a failover would have every caller politely
    retrying a credential."""
    p = _provider(mode="cluster")

    import redis.exceptions as _redis_exc

    async def _rebuild_fails(_gen):
        raise _redis_exc.AuthenticationError("NOAUTH Authentication required")

    p._rebuild_graph_client_for_failover = _rebuild_fails
    p._ensure_connected = _rebuild_fails

    async def _call():
        raise REFUSED

    original = asyncio.sleep
    asyncio.sleep = lambda s: _noop()
    try:
        with pytest.raises(_redis_exc.AuthenticationError):
            _run(p._run_guarded(_call))
    finally:
        asyncio.sleep = original


def test_a_standalone_store_that_cannot_be_reconnected_still_opens_it():
    """Outside a cluster the provider IS the one node, so a host that cannot
    be reached is a dead provider and the breaker is exactly right."""
    p = _provider(mode="standalone")

    async def _ensure_fails():
        raise ConnectionError("Connection reset by peer")

    p._ensure_connected = _ensure_fails

    async def _call():
        raise ConnectionError("Connection reset by peer")

    original = asyncio.sleep
    asyncio.sleep = lambda s: _noop()
    try:
        with pytest.raises(ConnectionError) as exc:
            _run(p._run_guarded(_call))
    finally:
        asyncio.sleep = original
    assert not isinstance(exc.value, ProviderFailingOver)
