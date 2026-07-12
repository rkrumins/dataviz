"""Cluster-mode self-heal when the graph's OWNING node rotates silently.

A GKE rotation of a cluster shard's master usually goes dark (pod
rescheduled, NEW address) rather than answering MOVED — the classic
redirect-driven rebuild never fires. Two behaviors close that hole and are
pinned here:

1. ``_run_guarded``: in cluster mode, once a plain redial has also failed
   (second transient retry onward), escalate to
   ``_rebuild_graph_client_for_failover`` — a fresh topology resolve that
   finds the promoted replica. First retry stays the cheap redial (absorbs
   same-node blips without pool churn); standalone mode never rebuilds.
2. ``preflight``: in cluster mode, resolve and probe the node that OWNS
   this graph instead of only a startup node — otherwise a healthy entry
   node masks a dead owner and the warmup loop never drives the recovery
   eviction. Falls back to the first startup node when discovery fails.

No live cluster required — controlled fakes drive both paths.
"""
import asyncio
from unittest.mock import AsyncMock

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from backend.app.providers.falkordb_connection import FalkorDBConnConfig
from backend.app.providers.falkordb_provider import FalkorDBProvider


def _cluster_provider():
    p = FalkorDBProvider(host="entry", graph_name="g")
    p._conn_cfg = FalkorDBConnConfig(
        mode="cluster", cluster_nodes=[("entry", 7000)],
    )
    p._conn_generation = 0
    return p


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Skip the real backoff sleeps so the suite runs in milliseconds."""
    monkeypatch.setattr(
        "backend.app.providers.falkordb_provider.asyncio.sleep", AsyncMock()
    )


def _instrument(p, monkeypatch):
    counts = {"ensure": 0, "rebuild": 0}

    async def fake_ensure():
        counts["ensure"] += 1

    async def fake_rebuild(gen):
        counts["rebuild"] += 1

    monkeypatch.setattr(p, "_ensure_connected", fake_ensure)
    monkeypatch.setattr(p, "_rebuild_graph_client_for_failover", fake_rebuild)
    return counts


# ── 1. _run_guarded: silent owner death re-resolves topology ─────────

@pytest.mark.asyncio
async def test_cluster_silent_node_death_reresolves_topology(monkeypatch):
    """Dark pinned node (no MOVED, just connection failures): the first
    retry redials, the second escalates to a topology rebuild and the call
    then succeeds against the promoted replica."""
    p = _cluster_provider()
    counts = _instrument(p, monkeypatch)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        if calls["n"] <= 2:
            raise RedisConnectionError("Timeout connecting to server")
        return "ok"

    assert await p._run_guarded(call) == "ok"
    assert calls["n"] == 3
    assert counts["ensure"] == 1    # retry 1: cheap same-address redial
    assert counts["rebuild"] == 1   # retry 2: full topology re-resolve


@pytest.mark.asyncio
async def test_cluster_dark_node_keeps_rebuilding_until_budget(monkeypatch):
    """Whole shard still failing over: every post-redial retry re-resolves,
    and the final failure still propagates (breaker opens; the half-open
    probe repeats this sequence and recovers once failover completes)."""
    p = _cluster_provider()
    counts = _instrument(p, monkeypatch)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        raise RedisConnectionError("Timeout connecting to server")

    with pytest.raises(RedisConnectionError):
        await p._run_guarded(call)
    assert calls["n"] == 4          # initial + 3 bounded retries
    assert counts["ensure"] == 1
    assert counts["rebuild"] == 2   # retries 2 and 3


@pytest.mark.asyncio
async def test_standalone_transient_errors_never_rebuild(monkeypatch):
    """Standalone keeps the existing semantics: redial-only (the host is
    stable DNS; there is no topology to re-resolve)."""
    p = FalkorDBProvider(host="x", graph_name="g")
    counts = _instrument(p, monkeypatch)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        if calls["n"] <= 2:
            raise RedisConnectionError("Connection reset by peer")
        return "ok"

    assert await p._run_guarded(call) == "ok"
    assert counts["ensure"] == 2
    assert counts["rebuild"] == 0


@pytest.mark.asyncio
async def test_cluster_lost_handle_uses_reconnect_not_rebuild(monkeypatch):
    """A handle nulled mid-flight (manager eviction) reconnects via
    _ensure_connected — that path already rebuilds from scratch and must
    not double-resolve."""
    p = _cluster_provider()
    counts = _instrument(p, monkeypatch)

    calls = {"n": 0}

    async def call():
        calls["n"] += 1
        if calls["n"] <= 2:
            raise AttributeError("'NoneType' object has no attribute 'query'")
        return "ok"

    assert await p._run_guarded(call) == "ok"
    assert counts["ensure"] == 2
    assert counts["rebuild"] == 0


# ── 2. preflight: probe the owning node, not just an entry node ──────

@pytest.mark.asyncio
async def test_cluster_preflight_probes_owning_node(monkeypatch):
    p = _cluster_provider()

    async def fake_resolve(cfg, graph_name, socket_timeout):
        assert graph_name == "g"
        return ("owner-node", 7002)

    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.resolve_cluster_node_for_key",
        fake_resolve,
    )

    probed = {}

    async def fake_ping(host, port, **kwargs):
        probed["target"] = (host, port)
        probed["deadline"] = kwargs.get("deadline_s")
        return "PREFLIGHT_OK"

    monkeypatch.setattr(
        "backend.common.interfaces.preflight.redis_ping_preflight", fake_ping,
    )

    assert await p.preflight(deadline_s=1.5) == "PREFLIGHT_OK"
    assert probed["target"] == ("owner-node", 7002)
    # The ping budget shrinks by the (instant fake) discovery time but
    # never collapses below the floor.
    assert 0.3 <= probed["deadline"] <= 1.5


@pytest.mark.asyncio
async def test_cluster_preflight_falls_back_to_startup_node(monkeypatch):
    """Discovery failure (all startup nodes dark / topology mid-failover)
    degrades to the old behavior — probe the first startup node — rather
    than raising out of a probe that promises never to raise."""
    p = _cluster_provider()

    async def fake_resolve(cfg, graph_name, socket_timeout):
        raise RedisConnectionError("cluster down")

    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.resolve_cluster_node_for_key",
        fake_resolve,
    )

    probed = {}

    async def fake_ping(host, port, **kwargs):
        probed["target"] = (host, port)
        return "PREFLIGHT_OK"

    monkeypatch.setattr(
        "backend.common.interfaces.preflight.redis_ping_preflight", fake_ping,
    )

    assert await p.preflight(deadline_s=1.5) == "PREFLIGHT_OK"
    assert probed["target"] == ("entry", 7000)


@pytest.mark.asyncio
async def test_cluster_preflight_discovery_is_deadline_bounded(monkeypatch):
    """A hung topology discovery (black-holed startup node) cannot stall
    the probe past its budget — wait_for cancels it and the probe falls
    back to the startup node."""
    p = _cluster_provider()

    async def hung_resolve(cfg, graph_name, socket_timeout):
        # Event().wait() genuinely hangs until wait_for cancels it (the
        # autouse _no_sleep fixture neuters asyncio.sleep, so sleep-based
        # hangs would return instantly and not exercise the deadline).
        await asyncio.Event().wait()

    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.resolve_cluster_node_for_key",
        hung_resolve,
    )

    probed = {}

    async def fake_ping(host, port, **kwargs):
        probed["target"] = (host, port)
        return "PREFLIGHT_OK"

    monkeypatch.setattr(
        "backend.common.interfaces.preflight.redis_ping_preflight", fake_ping,
    )

    assert await p.preflight(deadline_s=1.5) == "PREFLIGHT_OK"
    assert probed["target"] == ("entry", 7000)


@pytest.mark.asyncio
async def test_sentinel_preflight_probes_the_master_not_the_sentinel(monkeypatch):
    """A Sentinel daemon answers PONG while the master it watches is DEAD. Probing
    it would report the provider healthy through a whole master outage — and,
    because warmup never observes a failure, the false→true recovery eviction
    would never fire. Probe the master Sentinel names instead."""
    p = FalkorDBProvider(host="ignored", graph_name="g")
    p._conn_cfg = FalkorDBConnConfig(
        mode="sentinel", sentinel_master="mymaster",
        sentinel_nodes=[("sentinel-1", 26379), ("sentinel-2", 26379)],
    )

    async def fake_discover(cfg, socket_timeout):
        assert cfg.sentinel_master == "mymaster"
        return ("master-node", 6379)

    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.resolve_sentinel_master",
        fake_discover,
    )

    probed = {}

    async def fake_ping(host, port, **kwargs):
        probed["target"] = (host, port)
        return "PREFLIGHT_OK"

    monkeypatch.setattr(
        "backend.common.interfaces.preflight.redis_ping_preflight", fake_ping,
    )

    assert await p.preflight(deadline_s=1.5) == "PREFLIGHT_OK"
    assert probed["target"] == ("master-node", 6379)     # NOT sentinel-1:26379


@pytest.mark.asyncio
async def test_sentinel_preflight_falls_back_when_discovery_fails(monkeypatch):
    """Quorum unreachable / mid-failover: degrade to probing the first Sentinel
    rather than raising out of a probe that promises never to raise."""
    p = FalkorDBProvider(host="ignored", graph_name="g")
    p._conn_cfg = FalkorDBConnConfig(
        mode="sentinel", sentinel_master="mymaster",
        sentinel_nodes=[("sentinel-1", 26379)],
    )

    async def boom(cfg, socket_timeout):
        raise RedisConnectionError("no quorum")

    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.resolve_sentinel_master", boom,
    )

    probed = {}

    async def fake_ping(host, port, **kwargs):
        probed["target"] = (host, port)
        return "PREFLIGHT_OK"

    monkeypatch.setattr(
        "backend.common.interfaces.preflight.redis_ping_preflight", fake_ping,
    )

    assert await p.preflight(deadline_s=1.5) == "PREFLIGHT_OK"
    assert probed["target"] == ("sentinel-1", 26379)


@pytest.mark.asyncio
async def test_standalone_preflight_unchanged(monkeypatch):
    """Standalone probes the configured host directly — no discovery."""
    p = FalkorDBProvider(host="plainhost", graph_name="g")

    probed = {}

    async def fake_ping(host, port, **kwargs):
        probed["target"] = (host, port)
        return "PREFLIGHT_OK"

    monkeypatch.setattr(
        "backend.common.interfaces.preflight.redis_ping_preflight", fake_ping,
    )

    assert await p.preflight(deadline_s=1.5) == "PREFLIGHT_OK"
    assert probed["target"][0] == "plainhost"
