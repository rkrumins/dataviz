"""Per-provider topology routing — a MIXED FalkorDB fleet in one deployment.

The scenario these tests pin (the real deployment shape):

    provider "standalone-1"  — 3 graphs on a plain single-host FalkorDB
    provider "sentinel-1"    — 2 graphs on an HA Sentinel instance
    provider "cluster-1"     — 4 graphs on a Redis Cluster (slots across 3 nodes)

Every graph must reach ITS instance over THAT instance's topology, from every
service — the versioning registry factory, the env/projection factory, the
reconciler, and GRAPH.LIST — not just from the ProviderManager read path. Before
this, the registry/projection factories hand-rolled a standalone
``ConnectionPool(host, port)``, so the Sentinel graphs pinned whoever was master at
boot and the Cluster graphs could only see one seed node's slots.

Also pinned: the self-heal that makes a rotation survivable — a Sentinel failover
and a Cluster node rotation both re-resolve on the next call (``ResilientGraph``),
without a process restart.

No live FalkorDB/Redis/Postgres: fake redis + falkordb modules capture what got
built, and a fake session factory serves the provider rows.
"""
import json
import sys
import types

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from backend.app.providers import falkor_graph_registry as frg
from backend.app.providers.falkordb_connection import (
    TopologyGraphClients,
    list_graph_keys_for_config,
)
from backend.common.interfaces.provider import ProviderConfigurationError


# ── the fleet ────────────────────────────────────────────────────────

STANDALONE_GRAPHS = ["gv_sa_1", "gv_sa_2", "gv_sa_3"]
SENTINEL_GRAPHS = ["gv_se_1", "gv_se_2"]
CLUSTER_GRAPHS = ["gv_cl_1", "gv_cl_2", "gv_cl_3", "gv_cl_4"]

# Which cluster node owns which graph key (mutated to simulate a rotation).
CLUSTER_OWNERS = {
    "gv_cl_1": ("cl-node-a", 7000),
    "gv_cl_2": ("cl-node-b", 7001),
    "gv_cl_3": ("cl-node-c", 7002),
    "gv_cl_4": ("cl-node-a", 7000),
}
# Who Sentinel currently reports as master (mutated to simulate a failover).
SENTINEL_MASTER = {"endpoint": ("se-master-1", 6379)}

PROVIDER_ROWS = {
    "standalone-1": dict(
        host="falkor-standalone", port=6379, extra_config=None, tls_enabled=False,
    ),
    "sentinel-1": dict(
        host="falkor-sentinel", port=6379, tls_enabled=False,
        extra_config=json.dumps({
            "falkordbConnection": {
                "mode": "sentinel",
                "sentinel": {
                    "masterName": "falkormaster",
                    "nodes": [["se-1", 26379], ["se-2", 26379], ["se-3", 26379]],
                },
            },
        }),
    ),
    "cluster-1": dict(
        host="falkor-cluster", port=6379, tls_enabled=False,
        extra_config=json.dumps({
            "falkordbConnection": {
                "mode": "cluster",
                "cluster": {"startupNodes": [["cl-node-a", 7000], ["cl-node-b", 7001]]},
                "authEnabled": False,        # this instance takes no AUTH
            },
        }),
    ),
}


class _Row:
    provider_type = "falkordb"
    is_active = True

    def __init__(self, host, port, extra_config, tls_enabled):
        self.host = host
        self.port = port
        self.extra_config = extra_config
        self.tls_enabled = tls_enabled


class _FakeSessionFactory:
    def __call__(self):
        return self

    async def __aenter__(self):
        return object()

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def fleet(monkeypatch):
    """Fake redis + falkordb modules and provider registry for the mixed fleet.

    Returns a registry of everything constructed, so each assertion can prove
    WHICH endpoint a graph's client was built against.
    """
    built = {"pools": [], "clusters": 0}

    class FakePool:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.closed = False
            built["pools"].append(self)

        @property
        def endpoint(self):
            return (self.kwargs.get("host"), self.kwargs.get("port"))

        async def aclose(self):
            self.closed = True

    class FakeGraph:
        def __init__(self, db, name):
            self.db = db
            self.name = name

        async def query(self, cypher, params=None, timeout=None):
            if self.db.fail_once:
                self.db.fail_once = False
                raise RedisConnectionError("Connection reset by peer")
            return {"endpoint": self.db.endpoint, "graph": self.name}

        async def delete(self):
            return {"endpoint": self.db.endpoint, "deleted": self.name}

    class FakeFalkorDB:
        def __init__(self, connection_pool=None):
            self.pool = connection_pool
            self.fail_once = False

        @property
        def endpoint(self):
            return self.pool.endpoint

        def select_graph(self, name):
            return FakeGraph(self, name)

        async def list_graphs(self):
            # Each node reports only the graph keys IT holds — the whole point
            # of the cluster fan-out in list_graph_keys_for_config.
            host, _port = self.pool.endpoint
            return [
                g.encode() for g, (h, _p) in CLUSTER_OWNERS.items() if h == host
            ] or [b"gv_sa_1", b"gv_sa_2", b"gv_sa_3"]

    class FakeMaster:
        def __init__(self):
            host, port = SENTINEL_MASTER["endpoint"]
            self.connection_pool = FakePool(host=host, port=port, role="sentinel-master")

    class FakeSentinel:
        def __init__(self, nodes, **kwargs):
            self.nodes = nodes

        def master_for(self, name, **kwargs):
            return FakeMaster()

    class FakeClusterNode:
        def __init__(self, host, port):
            self.host = host
            self.port = port

    class _NodesManager:
        def get_node_from_slot(self, slot):
            host, port = CLUSTER_OWNERS[slot]
            return FakeClusterNode(host, port)

    class FakeRedisCluster:
        def __init__(self, startup_nodes=None, **kwargs):
            built["clusters"] += 1
            self.nodes_manager = _NodesManager()

        async def initialize(self):
            return None

        def keyslot(self, key):
            # The fake maps a graph name straight to its owner entry.
            return key

        def get_primaries(self):
            seen = {}
            for host, port in CLUSTER_OWNERS.values():
                seen[(host, port)] = FakeClusterNode(host, port)
            return list(seen.values())

        async def aclose(self):
            return None

    class FakeRedis:
        """Backs the build-time verify PING (auth negotiation happens there)."""

        def __init__(self, connection_pool=None, **kwargs):
            self.pool = connection_pool

        async def ping(self):
            return True

    redis_pkg = types.ModuleType("redis")
    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.ConnectionPool = FakePool
    redis_asyncio.Redis = FakeRedis
    sentinel_mod = types.ModuleType("redis.asyncio.sentinel")
    sentinel_mod.Sentinel = FakeSentinel
    cluster_mod = types.ModuleType("redis.asyncio.cluster")
    cluster_mod.RedisCluster = FakeRedisCluster
    redis_cluster_mod = types.ModuleType("redis.cluster")
    redis_cluster_mod.ClusterNode = FakeClusterNode
    falkor_pkg = types.ModuleType("falkordb")
    falkor_asyncio = types.ModuleType("falkordb.asyncio")
    falkor_asyncio.FalkorDB = FakeFalkorDB

    monkeypatch.setitem(sys.modules, "redis", redis_pkg)
    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setitem(sys.modules, "redis.asyncio.sentinel", sentinel_mod)
    monkeypatch.setitem(sys.modules, "redis.asyncio.cluster", cluster_mod)
    monkeypatch.setitem(sys.modules, "redis.cluster", redis_cluster_mod)
    monkeypatch.setitem(sys.modules, "falkordb", falkor_pkg)
    monkeypatch.setitem(sys.modules, "falkordb.asyncio", falkor_asyncio)

    # Provider registry rows.
    from backend.app.db.repositories import provider_repo

    async def fake_get_provider_orm(_session, provider_id):
        spec = PROVIDER_ROWS.get(provider_id)
        return _Row(**spec) if spec else None

    async def fake_get_credentials(_session, provider_id):
        return {"username": "u", "password": "p"}

    monkeypatch.setattr(provider_repo, "get_provider_orm", fake_get_provider_orm)
    monkeypatch.setattr(provider_repo, "get_credentials", fake_get_credentials)

    # Isolated client cache per test (the module singleton is process-wide).
    clients = TopologyGraphClients()
    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.graph_clients", lambda: clients,
    )

    CLUSTER_OWNERS.update({
        "gv_cl_1": ("cl-node-a", 7000), "gv_cl_2": ("cl-node-b", 7001),
        "gv_cl_3": ("cl-node-c", 7002), "gv_cl_4": ("cl-node-a", 7000),
    })
    SENTINEL_MASTER["endpoint"] = ("se-master-1", 6379)

    built["clients"] = clients
    built["FakeFalkorDB"] = FakeFalkorDB
    return built


def _factory():
    return frg.make_registry_graph_factory(session_factory=_FakeSessionFactory())


# ── the mixed fleet routes correctly, all at once ────────────────────

@pytest.mark.asyncio
async def test_mixed_fleet_every_graph_reaches_its_own_instance(fleet):
    """3 standalone + 2 sentinel + 4 cluster graphs, live simultaneously."""
    graph = _factory()

    for name in STANDALONE_GRAPHS:
        res = await (await graph(name, "standalone-1")).query("RETURN 1")
        assert res == {"endpoint": ("falkor-standalone", 6379), "graph": name}

    for name in SENTINEL_GRAPHS:
        res = await (await graph(name, "sentinel-1")).query("RETURN 1")
        # Sentinel routes to the CURRENT master, not a boot-time pin.
        assert res == {"endpoint": ("se-master-1", 6379), "graph": name}

    for name in CLUSTER_GRAPHS:
        res = await (await graph(name, "cluster-1")).query("RETURN 1")
        # Each cluster graph is pinned to the node that OWNS its key.
        assert res == {"endpoint": CLUSTER_OWNERS[name], "graph": name}


@pytest.mark.asyncio
async def test_client_sharing_matches_topology(fleet):
    """Pools are bounded by ENDPOINTS, never by graphs.

    Standalone/Sentinel: one client per instance. Cluster: one client per OWNING
    NODE — the 4 graphs live on 3 nodes (gv_cl_1 and gv_cl_4 share cl-node-a), so
    3 clients, not 4. Keying by graph would open a pool per graph (×pool size):
    at 1000s of graphs that is tens of thousands of sockets against a 3-node
    cluster."""
    graph = _factory()
    for name in STANDALONE_GRAPHS:
        await graph(name, "standalone-1")
    for name in SENTINEL_GRAPHS:
        await graph(name, "sentinel-1")
    for name in CLUSTER_GRAPHS:
        await graph(name, "cluster-1")

    keys = fleet["clients"]._clients.keys()
    standalone = [k for k in keys if k[0][0] == "standalone"]
    sentinel = [k for k in keys if k[0][0] == "sentinel"]
    cluster = [k for k in keys if k[0][0] == "cluster"]

    assert len(standalone) == 1          # 3 graphs share one pool
    assert len(sentinel) == 1            # 2 graphs share the master's pool
    assert standalone[0][1] is None and sentinel[0][1] is None

    # 4 graphs → 3 distinct owning nodes → 3 clients.
    assert len(cluster) == 3
    assert {k[1] for k in cluster} == set(CLUSTER_OWNERS[g] for g in CLUSTER_GRAPHS)
    # The graph→node map still knows all four graphs (cheap, no sockets).
    owners = fleet["clients"]._owner
    assert len([k for k in owners if k[1] in CLUSTER_GRAPHS]) == 4


@pytest.mark.asyncio
async def test_no_cross_talk_between_providers(fleet):
    """The same graph NAME on two different providers must not share a client."""
    graph = _factory()
    a = await (await graph("gv_shared", "standalone-1")).query("RETURN 1")
    CLUSTER_OWNERS["gv_shared"] = ("cl-node-b", 7001)
    b = await (await graph("gv_shared", "cluster-1")).query("RETURN 1")
    assert a["endpoint"] == ("falkor-standalone", 6379)
    assert b["endpoint"] == ("cl-node-b", 7001)
    CLUSTER_OWNERS.pop("gv_shared")


@pytest.mark.asyncio
async def test_auth_enabled_false_sends_no_credentials(fleet):
    """The cluster row sets authEnabled=false → no AUTH leaks to it, while the
    authenticated standalone row still carries its credentials (read-path parity)."""
    graph = _factory()
    await graph("gv_cl_1", "cluster-1")
    cluster_pools = [p for p in fleet["pools"] if p.kwargs.get("host", "").startswith("cl-node")]
    assert cluster_pools and all("password" not in p.kwargs for p in cluster_pools)

    await graph("gv_sa_1", "standalone-1")
    sa_pool = next(p for p in fleet["pools"] if p.kwargs.get("host") == "falkor-standalone")
    assert sa_pool.kwargs["username"] == "u" and sa_pool.kwargs["password"] == "p"


# ── rotation / failover self-heal (no process restart) ───────────────

@pytest.mark.asyncio
async def test_cluster_node_rotation_reresolves_owner(fleet):
    """The graph's owning node is rotated: the next call fails on the dead
    client, re-resolves the topology, and lands on the promoted replica."""
    graph = _factory()
    g = await graph("gv_cl_2", "cluster-1")
    assert (await g.query("RETURN 1"))["endpoint"] == ("cl-node-b", 7001)

    # Rotation: the client pinned to the OWNING NODE dies and the slot moves.
    cached = next(
        db for (key, (db, _pool)) in fleet["clients"]._clients.items()
        if key[1] == ("cl-node-b", 7001)
    )
    cached.fail_once = True
    CLUSTER_OWNERS["gv_cl_2"] = ("cl-node-b2", 7011)      # replica promoted

    res = await g.query("RETURN 1")
    assert res == {"endpoint": ("cl-node-b2", 7011), "graph": "gv_cl_2"}
    # The dead node's client is gone (it was dead for EVERY graph it held), and
    # the graph's owner mapping was re-resolved to the promoted replica.
    assert not any(
        k[1] == ("cl-node-b", 7001) for k in fleet["clients"]._clients
    )


@pytest.mark.asyncio
async def test_sentinel_failover_follows_new_master(fleet):
    """A Sentinel failover: the cached master client drops, the client re-asks
    Sentinel, and the write lands on the NEW master (not a stale replica)."""
    graph = _factory()
    g = await graph("gv_se_1", "sentinel-1")
    assert (await g.query("RETURN 1"))["endpoint"] == ("se-master-1", 6379)

    cached = next(
        db for (key, (db, _pool)) in fleet["clients"]._clients.items()
        if key[0][0] == "sentinel"
    )
    cached.fail_once = True
    SENTINEL_MASTER["endpoint"] = ("se-master-2", 6379)   # failover

    res = await g.query("RETURN 1")
    assert res == {"endpoint": ("se-master-2", 6379), "graph": "gv_se_1"}


@pytest.mark.asyncio
async def test_query_error_is_not_retried(fleet):
    """A real query error (bad Cypher) must propagate untouched — the retry is
    only for stale clients."""
    graph = _factory()
    g = await graph("gv_sa_1", "standalone-1")

    async def boom(*a, **kw):
        raise ValueError("syntax error near RETRUN")

    g._graph.query = boom
    with pytest.raises(ValueError):
        await g.query("RETRUN 1")


# ── GRAPH.LIST must not under-report on a cluster ────────────────────

@pytest.mark.asyncio
async def test_list_graph_keys_fans_out_across_cluster_primaries(fleet):
    """Each node holds only its own slots' graph keys — a single-node
    GRAPH.LIST would silently under-report and callers would think a taken
    graph name is free."""
    cfg = await frg.resolve_provider_conn_config("cluster-1", _FakeSessionFactory())
    keys = await list_graph_keys_for_config(cfg)
    assert keys == set(CLUSTER_GRAPHS)          # union across all 3 primaries

    keys_via_registry = await frg.list_graph_keys("cluster-1", _FakeSessionFactory())
    assert keys_via_registry == set(CLUSTER_GRAPHS)


@pytest.mark.asyncio
async def test_list_graph_keys_standalone_unchanged(fleet):
    keys = await frg.list_graph_keys("standalone-1", _FakeSessionFactory())
    assert keys == {"gv_sa_1", "gv_sa_2", "gv_sa_3"}


# ── env-default instance honors FALKORDB_MODE ────────────────────────

@pytest.mark.asyncio
async def test_unrouted_graph_uses_env_topology(fleet, monkeypatch):
    """An unrouted (env-default) graph on a CLUSTER deployment routes to the
    owning node — it used to be hard-wired to a standalone pool on the seed,
    which is exactly what would have broken the production-cluster cutover."""
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    monkeypatch.setenv("FALKORDB_CLUSTER_NODES", "cl-node-a:7000,cl-node-b:7001")

    graph = _factory()
    res = await (await graph("gv_cl_3", None)).query("RETURN 1")
    assert res == {"endpoint": ("cl-node-c", 7002), "graph": "gv_cl_3"}


@pytest.mark.asyncio
async def test_projection_env_factory_shares_the_same_topology_path(fleet, monkeypatch):
    """The versioning projector's env factory (used by the standalone
    versioning-worker) must resolve topology identically."""
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    monkeypatch.setenv("FALKORDB_CLUSTER_NODES", "cl-node-a:7000")

    from backend.app.services.versioning.projection import make_falkor_graph_factory

    graph = make_falkor_graph_factory()
    res = await (await graph("gv_cl_4", None)).query("RETURN 1")
    assert res == {"endpoint": ("cl-node-a", 7000), "graph": "gv_cl_4"}


# ── pools are bounded by endpoints, not by graphs ────────────────────

@pytest.mark.asyncio
async def test_cluster_pools_do_not_scale_with_graph_count(fleet):
    """The scale invariant: 200 graphs across 3 nodes must open 3 clients, not
    200. Keying clients by graph would open a pool per graph (× FALKORDB_POOL_SIZE
    connections) — tens of thousands of sockets against a 3-node cluster at this
    platform's graph counts."""
    graph = _factory()
    nodes = [("cl-node-a", 7000), ("cl-node-b", 7001), ("cl-node-c", 7002)]
    for i in range(200):
        name = f"gv_bulk_{i}"
        CLUSTER_OWNERS[name] = nodes[i % 3]
        await graph(name, "cluster-1")

    cluster_clients = [k for k in fleet["clients"]._clients if k[0][0] == "cluster"]
    assert len(cluster_clients) == 3            # one per owning node
    assert len(fleet["clients"]._owner) >= 200  # the graph→node map is cheap

    for i in range(200):
        CLUSTER_OWNERS.pop(f"gv_bulk_{i}", None)


# ── provider edits invalidate BOTH paths ─────────────────────────────

@pytest.mark.asyncio
async def test_provider_eviction_drops_registry_config_and_clients(fleet):
    """An admin repointing a provider (new host / standalone→cluster / rotated
    credentials) must invalidate the PROJECTOR path too. Otherwise the read path
    picks up the change while the projector keeps writing to the OLD instance
    until the process restarts — silent data corruption, not a stale read.

    ProviderManager.evict_data_source is the single chokepoint (evict_provider /
    evict_workspace / evict_all all funnel through it)."""
    from backend.app.providers import falkor_graph_registry as reg

    graph = _factory()
    g = await graph("gv_sa_1", "standalone-1")
    assert (await g.query("RETURN 1"))["endpoint"] == ("falkor-standalone", 6379)
    assert "standalone-1" in reg._RESOLVED
    assert any(k[0][0] == "standalone" for k in fleet["clients"]._clients)

    # Admin repoints the provider at a different instance.
    PROVIDER_ROWS["standalone-1"]["host"] = "falkor-standalone-2"
    try:
        await reg.invalidate_provider("standalone-1")

        # Memo AND clients dropped — the next call re-reads the row.
        assert "standalone-1" not in reg._RESOLVED
        assert not any(k[0][0] == "standalone" for k in fleet["clients"]._clients)

        g2 = await graph("gv_sa_1", "standalone-1")
        assert (await g2.query("RETURN 1"))["endpoint"] == ("falkor-standalone-2", 6379)
    finally:
        PROVIDER_ROWS["standalone-1"]["host"] = "falkor-standalone"


def test_manager_eviction_invalidates_the_registry():
    """Pin the wiring: the manager's chokepoint calls the registry invalidation."""
    import inspect

    from backend.app.providers.manager import ProviderManager

    src = inspect.getsource(ProviderManager.evict_data_source)
    assert "invalidate_provider(" in src


# ── fail-loud contract preserved ─────────────────────────────────────

@pytest.mark.asyncio
async def test_unknown_pinned_provider_still_raises(fleet):
    """A pinned provider that doesn't resolve must NEVER fall back to the env
    instance (that would land its writes on the wrong FalkorDB)."""
    graph = _factory()
    with pytest.raises(ProviderConfigurationError):
        await graph("gv_x", "does-not-exist")
