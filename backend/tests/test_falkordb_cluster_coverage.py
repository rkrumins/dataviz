"""A dead shard must not take down graphs that live on the healthy ones.

``redis.asyncio.cluster.RedisCluster`` defaults ``require_full_coverage=True``
(the SYNC client does not — the asymmetry is the trap). Our shards run
``--cluster-require-full-coverage no`` precisely so surviving shards keep
serving through an outage:

    docs/INFRASTRUCTURE_SCALING_250M.md — "a dead shard must not take down
    reads on the other two"
    docs/FALKORDB_DR_RUNBOOK.md — "Restore one shard at a time; the other
    two keep serving"

Left at the library default, ``NodesManager.initialize()`` raises
``RedisClusterException("All slots are not covered...")`` whenever one shard is
down, so EVERY graph client build fails — including graphs whose slots live on
healthy shards. That makes the DR runbook's one-shard-at-a-time restore a full
graph-tier outage.

The data plane must therefore pass ``require_full_coverage=False`` explicitly.
The primaries fan-out is the deliberate EXCEPTION: ``GRAPH.LIST`` unions across
shards, so partial coverage there would silently under-report graphs (observed
live: 3 of 6 graphs returned, an entire shard's worth missing).
"""
import sys
import types

import pytest

import backend.app.providers.falkordb_connection as fc


@pytest.fixture
def captured_clusters(monkeypatch):
    """Replace RedisCluster with a capture shim; return the kwargs list."""
    seen: list = []

    class CapturingCluster:
        def __init__(self, startup_nodes=None, **kwargs):
            seen.append(kwargs)
            self.nodes_manager = types.SimpleNamespace(
                get_node_from_slot=lambda slot: types.SimpleNamespace(
                    host="shard-1", port=6379,
                ),
                slots_cache={},
            )

        async def initialize(self):
            return None

        def keyslot(self, key):
            return 1234

        def get_primaries(self):
            return [types.SimpleNamespace(host="shard-1", port=6379)]

        async def aclose(self):
            return None

    cluster_mod = types.ModuleType("redis.asyncio.cluster")
    cluster_mod.RedisCluster = CapturingCluster
    monkeypatch.setitem(sys.modules, "redis.asyncio.cluster", cluster_mod)
    return seen


def _cluster_cfg():
    return fc.FalkorDBConnConfig(
        mode="cluster",
        host="shard-0",
        port=6379,
        cluster_nodes=[("shard-0", 6379), ("shard-1", 6379), ("shard-2", 6379)],
    )


def test_data_plane_client_tolerates_a_dead_shard(captured_clusters):
    """build_cluster_conn is the client every graph query runs through."""
    fc.build_cluster_conn(_cluster_cfg(), "shard-1", 6379, {})

    assert captured_clusters, "expected a RedisCluster to be constructed"
    assert captured_clusters[-1].get("require_full_coverage") is False


@pytest.mark.asyncio
async def test_owner_resolution_tolerates_a_dead_shard(captured_clusters):
    """Slot discovery must survive it too — resolving the owner of a graph on a
    HEALTHY shard cannot depend on every other shard being up."""
    host, port = await fc._resolve_cluster_node_once(_cluster_cfg(), "some_graph", 5.0)

    assert (host, port) == ("shard-1", 6379)
    assert captured_clusters[-1].get("require_full_coverage") is False


@pytest.mark.asyncio
async def test_primaries_fanout_still_demands_full_coverage(captured_clusters):
    """The deliberate exception — do NOT let a sweep flip this one to False.

    GRAPH.LIST unions across every primary, so a partial slot map silently
    under-reports graphs rather than failing. Here, raising IS the correct
    behaviour.
    """
    try:
        await fc._cluster_primary_nodes_once(_cluster_cfg(), 5.0)
    except Exception:
        # The fake's empty slots_cache may trip the coverage belt; the kwarg
        # is what this test pins, and it is recorded at construction.
        pass

    assert captured_clusters[-1].get("require_full_coverage") is True
