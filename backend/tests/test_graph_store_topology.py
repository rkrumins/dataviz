"""The graph store's topology: every node, or the reason it is missing.

These tests pin the promise the page is built on — a nine-node cluster
shows nine nodes. Before this service two separate paths each showed a
subset (the probe enumerated only the environment's primaries; the rollup
capacity sweep only nodes that owned a rollup graph), replicas were
invisible, and a node no one had a graph on did not exist.

So the assertions here are mostly about ABSENCE being impossible: a node
that refuses, a node that times out, a node the cluster announces with no
address, a graph registered but missing, a store that cannot be reached at
all — each one is a row with a reason, never a gap.
"""
from __future__ import annotations

import asyncio
import time
import types

import pytest

from backend.app.providers.falkordb_connection import load_connection_config
from backend.app.services.graph_store import discovery, info_parse, topology

GB = 1024 ** 3


def _run(coro):
    return asyncio.run(coro)


# ── fakes ────────────────────────────────────────────────────────────────


CLUSTER_NODES_3x2 = {
    "10.0.0.1:6379": {
        "node_id": "m1", "hostname": "", "flags": "myself,master", "master_id": "-",
        "slots": [["0", "5460"]], "migrations": [], "connected": True,
    },
    "10.0.0.2:6379": {
        "node_id": "m2", "hostname": "", "flags": "master", "master_id": "-",
        "slots": [["5461", "10922"]], "migrations": [], "connected": True,
    },
    "10.0.0.3:6379": {
        "node_id": "m3", "hostname": "", "flags": "master", "master_id": "-",
        "slots": [["10923", "16383"]], "migrations": [], "connected": True,
    },
    "10.0.0.4:6379": {
        "node_id": "r1a", "hostname": "", "flags": "slave", "master_id": "m1",
        "slots": [], "migrations": [], "connected": True,
    },
    "10.0.0.5:6379": {
        "node_id": "r1b", "hostname": "", "flags": "slave", "master_id": "m1",
        "slots": [], "migrations": [], "connected": True,
    },
    "10.0.0.6:6379": {
        "node_id": "r2a", "hostname": "", "flags": "slave", "master_id": "m2",
        "slots": [], "migrations": [], "connected": True,
    },
    "10.0.0.7:6379": {
        "node_id": "r2b", "hostname": "", "flags": "slave", "master_id": "m2",
        "slots": [], "migrations": [], "connected": True,
    },
    "10.0.0.8:6379": {
        "node_id": "r3a", "hostname": "", "flags": "slave", "master_id": "m3",
        "slots": [], "migrations": [], "connected": True,
    },
    "10.0.0.9:6379": {
        "node_id": "r3b", "hostname": "", "flags": "slave", "master_id": "m3",
        "slots": [], "migrations": [], "connected": True,
    },
}

MASTERS = ["10.0.0.1:6379", "10.0.0.2:6379", "10.0.0.3:6379"]
REPLICAS_OF = {
    "10.0.0.1:6379": ["10.0.0.4:6379", "10.0.0.5:6379"],
    "10.0.0.2:6379": ["10.0.0.6:6379", "10.0.0.7:6379"],
    "10.0.0.3:6379": ["10.0.0.8:6379", "10.0.0.9:6379"],
}


def _master_info(endpoint, *, used=10 * GB, maxmemory=40 * GB, replicas=(),
                 offset=1000, run_id=None, sync_full=0):
    info = {
        "role": "master", "connected_slaves": len(replicas),
        "master_repl_offset": offset,
        "used_memory": used, "used_memory_rss": used, "used_memory_peak": used,
        "maxmemory": maxmemory, "maxmemory_policy": "noeviction",
        "mem_fragmentation_ratio": 1.1, "mem_clients_slaves": 1024,
        "mem_replication_backlog": 256 * 1024 ** 2,
        "redis_version": "7.2.0", "uptime_in_seconds": 100_000,
        "run_id": run_id or f"run-{endpoint}", "connected_clients": 4,
        "instantaneous_ops_per_sec": 12, "loading": 0,
        "sync_full": sync_full, "sync_partial_ok": 0, "sync_partial_err": 0,
    }
    for i, (rep_endpoint, lag) in enumerate(replicas):
        host, _, port = rep_endpoint.rpartition(":")
        info[f"slave{i}"] = {
            "ip": host, "port": port, "state": "online",
            "offset": offset - lag, "lag": 0,
        }
    return info


def _replica_info(endpoint, master, *, lag=0, link="up", used=9 * GB, run_id=None):
    host, _, port = master.rpartition(":")
    return {
        "role": "slave", "master_host": host, "master_port": port,
        "master_link_status": link, "master_sync_in_progress": 0,
        "master_repl_offset": 1000, "slave_repl_offset": 1000 - lag,
        "master_last_io_seconds_ago": 0,
        "used_memory": used, "maxmemory": 40 * GB, "maxmemory_policy": "noeviction",
        "redis_version": "7.2.0", "uptime_in_seconds": 100_000,
        "run_id": run_id or f"run-{endpoint}", "loading": 0,
        "sync_full": 0, "sync_partial_err": 0,
    }


class _FakeNode:
    """One node's answers. Absent from ``state['nodes']`` = refuses to connect."""

    def __init__(self, state, endpoint):
        self.state = state
        self.endpoint = endpoint

    def _me(self):
        node = self.state["nodes"].get(self.endpoint)
        if node is None:
            raise ConnectionError(
                f"Error 111 connecting to {self.endpoint}. Connection refused.")
        return node

    async def ping(self):
        self._me()
        return True

    async def info(self, *sections):
        return dict(self._me().get("info") or {})

    async def config_get(self, *names):
        me = self._me()
        return {k: v for k, v in (me.get("config") or {}).items() if k in names}

    async def execute_command(self, command, *args):
        me = self._me()
        if command == "CLUSTER NODES":
            if self.state.get("cluster_nodes_refused"):
                from redis.exceptions import ResponseError
                raise ResponseError("unknown command 'CLUSTER'")
            return self.state["cluster_nodes"]
        if command == "GRAPH.LIST":
            return list(me.get("graphs") or [])
        if command == "GRAPH.CONFIG":
            return [[k, v] for k, v in (me.get("graph_config") or {}).items()]
        if command == "GRAPH.MEMORY":
            self.state.setdefault("measured_calls", []).append((self.endpoint, args[1]))
            behaviour = me.get("graph_memory", "ok")
            if behaviour == "unsupported":
                from redis.exceptions import ResponseError
                raise ResponseError("unknown command 'GRAPH.MEMORY'")
            if behaviour == "slow":
                await asyncio.sleep(5)
            return [["total_graph_sz_mb", "12.5"], ["indices_sz_mb", "2.5"]]
        raise AssertionError(f"unexpected command {command}")

    async def aclose(self):
        return None


def _wire(monkeypatch, *, nodes, providers, data_sources=(), workspaces=None,
          cluster_nodes=None, cluster_nodes_refused=False, tuning=None):
    """Stub the two collaborators: the nodes and the database."""
    state = {
        "nodes": nodes,
        "cluster_nodes": cluster_nodes if cluster_nodes is not None else CLUSTER_NODES_3x2,
        "cluster_nodes_refused": cluster_nodes_refused,
    }

    def _client(cfg, host, port, *, socket_timeout):
        return _FakeNode(state, f"{host}:{port}")

    monkeypatch.setattr(discovery, "node_client", _client)

    class _Result:
        def __init__(self, rows, scalar=False):
            self._rows = rows
            self._scalar = scalar

        def scalars(self):
            return types.SimpleNamespace(all=lambda: list(self._rows))

        def all(self):
            return list(self._rows)

    class _Session:
        def __init__(self):
            self.calls = 0

        async def execute(self, query):
            self.calls += 1
            return _Result(providers if self.calls == 1 else list(data_sources))

        async def get(self, orm, key):
            return types.SimpleNamespace(tuning_json=tuning) if tuning else None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(topology, "_session_factory", lambda: (lambda: _Session()))
    topology._cache = None
    topology._prev_nodes = {}
    topology._last_error = None
    topology._retry_not_before = 0.0
    return state


def _provider(pid="p1", name="Falkor", *, mode="cluster", seeds=("10.0.0.1:6379",),
              host="10.0.0.1", port=6379):
    conn = {"mode": mode}
    if mode == "cluster":
        conn["cluster"] = {"startupNodes": list(seeds)}
    import json
    return types.SimpleNamespace(
        id=pid, name=name, provider_type="falkordb", host=host, port=port,
        is_active=True, tls_enabled=False, credentials=None,
        extra_config=json.dumps({"falkordbConnection": conn}), created_at="2026-01-01",
    )


def _ds(ds_id, *, provider="p1", graph="g1", workspace="ws1", edges=1000,
        mode=None, dedicated=None, status="ready", label=None):
    return types.SimpleNamespace(
        id=ds_id, label=label or ds_id.upper(), workspace_id=workspace,
        catalog_item_id=f"cat_{ds_id}", provider_id=provider, graph_name=graph,
        projection_mode=mode, dedicated_graph_name=dedicated,
        aggregation_status=status, aggregation_edge_count=edges, deleted_at=None,
    )


def _cluster_nodes(state):
    """Every node of the 3×(1+2) fixture, healthy, with graphs on the masters."""
    nodes = {}
    for i, master in enumerate(MASTERS):
        replicas = [(r, 0) for r in REPLICAS_OF[master]]
        nodes[master] = {
            "info": _master_info(master, replicas=replicas),
            "graphs": state.get("graphs", {}).get(master, []),
            "graph_config": {"QUERY_MEM_CAPACITY": 512 * 1024 ** 2,
                             "TIMEOUT_MAX": 180000, "TIMEOUT_DEFAULT": 30000,
                             "THREAD_COUNT": 6, "EFFECTS_THRESHOLD": 300},
            "config": {"repl-backlog-size": "256mb",
                       "client-output-buffer-limit":
                           "normal 0 0 0 slave 268435456 67108864 60 pubsub 0 0 0",
                       "cluster-node-timeout": "5000"},
        }
        for replica in REPLICAS_OF[master]:
            nodes[replica] = {
                "info": _replica_info(replica, master),
                "config": {},
            }
    return nodes


# ── parsing ──────────────────────────────────────────────────────────────


def test_cluster_nodes_parsing_keeps_every_node_dialable_or_not():
    """The address a node announces can be a hostname, an ip, or ``?`` for
    the node answering us. Each case resolves to something dialable, or to
    a node explicitly marked undialable — never to a node that is gone."""
    cfg = load_connection_config({"mode": "cluster"}, host="seed", port=6379,
                                username=None, password=None)
    parsed = {
        "10.0.0.1:6379": {"node_id": "m1", "hostname": "shard-0.svc", "flags": "master",
                          "master_id": "-", "slots": [["0", "5460"]]},
        "?:6379": {"node_id": "m2", "hostname": "", "flags": "myself,master",
                   "master_id": "-", "slots": [["5461", "16383"]]},
        "10.0.0.9:6379": {"node_id": "r1", "hostname": "", "flags": "slave,fail?",
                          "master_id": "m1", "slots": []},
        "10.0.0.8:6379": {"node_id": "x", "hostname": "", "flags": "master,fail",
                          "master_id": "-", "slots": [["9999"]]},
    }
    nodes = discovery.parse_cluster_nodes_reply(parsed, cfg, seed=("seed-host", 7000))
    by_id = {n.node_id: n for n in nodes}
    # An announced hostname wins over the ip: the ip is a pod address.
    assert by_id["m1"].endpoint == "shard-0.svc:6379"
    # The node answering us announces "?" — the seed we are talking through is
    # by definition reachable.
    assert by_id["m2"].endpoint == "seed-host:7000" and by_id["m2"].dialable
    assert by_id["r1"].role == "replica" and by_id["r1"].gossip == "pfail"
    assert by_id["x"].gossip == "fail" and by_id["x"].slots == [[9999, 9999]]

    shards = discovery.group_shards(nodes)
    assert [m.node_id for m, _ in shards] == ["m1", "m2", "x"]      # by first slot
    assert [r.node_id for r in shards[0][1]] == ["r1"]


def test_a_node_without_an_announced_address_is_reported_not_dropped():
    cfg = load_connection_config({"mode": "cluster"}, host="seed", port=6379,
                                username=None, password=None)
    nodes = discovery.parse_cluster_nodes_reply(
        {"?:6379": {"node_id": "lost", "hostname": "", "flags": "slave",
                    "master_id": "m1", "slots": []}}, cfg,
    )
    assert len(nodes) == 1
    assert not nodes[0].dialable
    assert "no address" in (nodes[0].reason or "")


def test_address_remap_applies_to_replicas_too():
    """Only masters were ever dialled before, so the remap was only ever
    exercised on them; a replica behind the same remap must be dialable."""
    cfg = load_connection_config(
        {"mode": "cluster", "addressRemap": {"10.0.0.4:6379": "gw:7004"}},
        host="seed", port=6379, username=None, password=None,
    )
    nodes = discovery.parse_cluster_nodes_reply(
        {"10.0.0.4:6379": {"node_id": "r", "hostname": "", "flags": "slave",
                           "master_id": "m", "slots": []}}, cfg,
    )
    assert nodes[0].endpoint == "gw:7004" and nodes[0].announced == "10.0.0.4:6379"


def test_info_replication_gives_lag_per_replica_and_on_the_replica():
    master = info_parse.replication_stats(_master_info(
        "m", replicas=[("10.0.0.4:6379", 2048), ("10.0.0.5:6379", 0)],
    ))
    assert master["role"] == "master" and master["connectedReplicas"] == 2
    assert [r["lagBytes"] for r in master["replicas"]] == [2048, 0]
    replica = info_parse.replication_stats(_replica_info("r", "10.0.0.1:6379", lag=4096))
    assert replica["role"] == "replica" and replica["lagBytes"] == 4096
    assert replica["masterEndpoint"] == "10.0.0.1:6379"


def test_replica_output_buffer_and_sizes_are_read_from_config():
    config = {"client-output-buffer-limit":
              "normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60",
              "repl-backlog-size": "1gb"}
    assert info_parse.replica_output_buffer_hard_limit(config) == 256 * 1024 ** 2
    assert info_parse.parse_memory_bytes(config["repl-backlog-size"]) == GB
    assert info_parse.replica_output_buffer_hard_limit({}) is None


def test_graph_memory_reply_becomes_bytes_whatever_the_shape():
    total, detail = discovery.parse_graph_memory_reply(
        [["total_graph_sz_mb", "12.5"], ["indices_sz_mb", "2.5"]])
    assert total == int(12.5 * 1024 ** 2) and detail["indices_sz_mb"] == int(2.5 * 1024 ** 2)
    # No total field: the parts add up rather than reporting nothing.
    total, _ = discovery.parse_graph_memory_reply({"label_matrices_sz_mb": "1"})
    assert total == 1024 ** 2
    assert discovery.parse_graph_memory_reply("nonsense") == (None, {})


# ── the sweep ────────────────────────────────────────────────────────────


def test_every_node_of_a_nine_node_cluster_is_reported_with_its_role(monkeypatch):
    """The headline promise: 3 masters + 6 replicas = 9 rows, each with
    memory, replication and the graphs on it."""
    nodes = _cluster_nodes({"graphs": {MASTERS[0]: ["g1"], MASTERS[1]: ["g2"]}})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()],
          data_sources=[(_ds("ds1", graph="g1"), "Workspace One")])

    snap = _run(topology.get_topology_snapshot())

    assert snap.summary.masters == 3 and snap.summary.replicas == 6
    assert snap.summary.nodes_total == 9 and snap.summary.nodes_up == 9
    instance = snap.instances[0]
    assert instance.mode == "cluster" and instance.discovered_via == "clusterNodes"
    assert instance.slots_covered == 16384 and instance.slots_missing is None
    assert [s.slot_ranges for s in instance.shards] == [
        [[0, 5460]], [[5461, 10922]], [[10923, 16383]],
    ]
    for shard in instance.shards:
        assert shard.master.role == "master" and shard.master.status == "up"
        assert shard.master.memory.used == 10 * GB and shard.master.memory.used_pct == 25.0
        assert len(shard.replicas) == 2
        assert all(r.role == "replica" and r.status == "up" for r in shard.replicas)
        assert shard.replication.replicas_total == 2
        assert shard.replication.replicas_online == 2
    # The node's own ceilings ride along, so the limits dialog can reach it.
    assert instance.shards[0].master.limits.query_mem_capacity == 512 * 1024 ** 2
    assert instance.shards[0].master.limits.thread_count == 6


def test_an_unreachable_node_is_a_row_with_a_reason_never_a_gap(monkeypatch):
    nodes = _cluster_nodes({})
    del nodes["10.0.0.5:6379"]                    # a replica refuses connections
    del nodes[MASTERS[2]]                         # and a whole master is down
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])

    snap = _run(topology.get_topology_snapshot())

    assert snap.summary.nodes_total == 9 and snap.summary.nodes_up == 7
    assert snap.summary.unreachable_nodes == 2
    every = {n.endpoint: n for s in snap.instances[0].shards
             for n in (s.master, *s.replicas)}
    assert set(every) == set(MASTERS) | {r for v in REPLICAS_OF.values() for r in v}
    assert every["10.0.0.5:6379"].status == "unreachable"
    assert "Connection refused" in (every["10.0.0.5:6379"].error or "")
    assert every[MASTERS[2]].status == "unreachable"
    # A master that cannot be read cannot govern a write budget either.
    third = snap.instances[0].shards[2]
    assert third.capacity is not None and not third.capacity.measurable


def test_a_slow_node_is_reported_after_the_deadline_not_dropped(monkeypatch):
    nodes = _cluster_nodes({})

    async def _slow_info(*a, **kw):
        await asyncio.sleep(5)

    nodes["10.0.0.6:6379"] = {"info": {}, "config": {}, "slow": True}
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    monkeypatch.setenv("GRAPH_STORE_TOPOLOGY_DEADLINE_S", "1")

    real_read = discovery.read_node

    async def _read(cfg, node, **kw):
        if node.endpoint == "10.0.0.6:6379":
            await asyncio.sleep(5)
        return await real_read(cfg, node, **kw)

    monkeypatch.setattr(discovery, "read_node", _read)
    snap = _run(topology.get_topology_snapshot())

    every = {n.endpoint: n for s in snap.instances[0].shards
             for n in (s.master, *s.replicas)}
    assert every["10.0.0.6:6379"].status == "unreachable"
    assert every["10.0.0.6:6379"].error == "not read before the deadline"
    assert len(every) == 9


def test_the_slot_map_is_the_fallback_when_cluster_nodes_is_refused(monkeypatch):
    """An ACL that refuses CLUSTER NODES must not blank the page: roles and
    slots still come from the map redis-py builds."""
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()], cluster_nodes_refused=True)

    class _FakeClusterNode:
        def __init__(self, host, port):
            self.host, self.port = host, port

    class _FakeCluster:
        def __init__(self, *a, **kw):
            self.nodes_manager = types.SimpleNamespace(slots_cache={})
            ranges = [(0, 5460), (5461, 10922), (10923, 16383)]
            for master, (lo, hi) in zip(MASTERS, ranges):
                host, _, port = master.rpartition(":")
                primary = _FakeClusterNode(host, int(port))
                reps = [_FakeClusterNode(r.rpartition(":")[0], 6379)
                        for r in REPLICAS_OF[master]]
                for slot in range(lo, hi + 1):
                    self.nodes_manager.slots_cache[slot] = [primary, *reps]

        async def initialize(self):
            return None

        async def aclose(self):
            return None

    import redis.asyncio.cluster as rc
    monkeypatch.setattr(rc, "RedisCluster", _FakeCluster)
    snap = _run(topology.get_topology_snapshot())

    instance = snap.instances[0]
    assert instance.discovered_via == "clusterSlots"
    assert instance.totals.masters == 3 and instance.totals.replicas == 6
    assert instance.shards[0].slot_ranges == [[0, 5460]]


def test_a_store_that_cannot_be_reached_at_all_says_so(monkeypatch):
    _wire(monkeypatch, nodes={}, providers=[_provider()])
    snap = _run(topology.get_topology_snapshot())
    instance = snap.instances[0]
    assert not instance.reachable and instance.shards == []
    assert "Connection refused" in (instance.error or "")


def test_sentinel_and_standalone_find_their_replicas_from_info(monkeypatch):
    """Outside cluster mode INFO replication is the only way to see a
    replica at all — before this they were invisible in every mode."""
    nodes = {
        "10.0.0.1:6379": {
            "info": _master_info("10.0.0.1:6379", replicas=[("10.0.0.4:6379", 0)]),
            "graphs": ["g1"], "graph_config": {}, "config": {},
        },
        "10.0.0.4:6379": {"info": _replica_info("10.0.0.4:6379", "10.0.0.1:6379"),
                          "config": {}},
    }
    _wire(monkeypatch, nodes=nodes,
          providers=[_provider(mode="standalone", host="10.0.0.1")])
    snap = _run(topology.get_topology_snapshot())
    instance = snap.instances[0]
    assert instance.mode == "standalone" and instance.discovered_via == "info"
    assert len(instance.shards) == 1 and len(instance.shards[0].replicas) == 1
    assert instance.shards[0].replicas[0].endpoint == "10.0.0.4:6379"


# ── graphs and placement ─────────────────────────────────────────────────


def test_graphs_are_placed_by_keyslot_with_their_data_sources(monkeypatch):
    """Placement is arithmetic, not a round trip: the key's slot decides
    the shard, so every surface can answer 'where does this live' from the
    cached snapshot."""
    key = "g_alpha"
    slot = topology.key_slot(key)
    owner = next(i for i, (lo, hi) in enumerate(
        [(0, 5460), (5461, 10922), (10923, 16383)]) if lo <= slot <= hi)
    nodes = _cluster_nodes({"graphs": {MASTERS[owner]: [key, "stray_graph"]}})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()],
          data_sources=[(_ds("ds1", graph=key, edges=2000), "Workspace One")])

    snap = _run(topology.get_topology_snapshot())
    instance = snap.instances[0]
    shard = instance.shards[owner]
    rows = {g.key: g for g in shard.graphs}
    assert rows[key].slot == slot and rows[key].present
    assert rows[key].role == "source"
    assert [d.id for d in rows[key].data_sources] == ["ds1"]
    assert rows[key].data_sources[0].workspace_name == "Workspace One"
    assert rows[key].estimated_bytes == 2000 * 512
    # A graph on the node that no data source claims is still shown — an
    # orphan is exactly what an operator wants to find.
    assert rows["stray_graph"].role == "unregistered"
    assert shard.unregistered_count == 1

    placement = topology.placement_for_graph(snap, "p1", key)
    assert placement.shard_index == owner and placement.present
    assert placement.slot == slot
    assert placement.master.endpoint == MASTERS[owner]
    assert len(placement.replicas) == 2 and placement.siblings == 1


def test_a_graph_below_the_display_cap_is_still_found_on_its_node(monkeypatch):
    """The cap bounds what the PAGE renders. Answering placement from the
    capped list turns every graph past the cut into "not found on the node"
    — indistinguishable from a graph the node really does not hold, and
    said to an ordinary user on their own data source's profile, about a
    graph that is sitting there working."""
    monkeypatch.setattr(topology, "MAX_GRAPH_ROWS_PER_SHARD", 1)
    key, bigger = "z_modest", "a_large"
    slot = topology.key_slot(key)
    owner = next(i for i, (lo, hi) in enumerate(
        [(0, 5460), (5461, 10922), (10923, 16383)]) if lo <= slot <= hi)
    # Two graphs on the shard, and only one row fits: this one is below the
    # cut, so it is not among the rows the page gets.
    nodes = _cluster_nodes({"graphs": {MASTERS[owner]: [key, bigger]}})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()],
          data_sources=[(_ds("ds1", graph=key, edges=10), "Workspace One"),
                        (_ds("ds2", graph=bigger, edges=10_000_000), "Workspace One")])

    snap = _run(topology.get_topology_snapshot())
    shard = snap.instances[0].shards[owner]
    assert shard.graphs_truncated and [g.key for g in shard.graphs] == [bigger]

    placement = topology.placement_for_graph(snap, "p1", key)
    assert placement.present                         # it IS on the node
    assert placement.edge_count == 10
    assert placement.siblings == 1                   # counted from the total


def test_a_registered_graph_missing_from_its_node_is_shown_as_missing(monkeypatch):
    nodes = _cluster_nodes({})                     # no GRAPH.LIST entries at all
    _wire(monkeypatch, nodes=nodes, providers=[_provider()],
          data_sources=[(_ds("ds1", graph="never_built"), "Workspace One")])
    snap = _run(topology.get_topology_snapshot())
    rows = [g for s in snap.instances[0].shards for g in s.graphs]
    assert [(g.key, g.present) for g in rows] == [("never_built", False)]


def test_a_dedicated_projection_is_placed_on_its_own_slot(monkeypatch):
    """The projection graph hashes independently: it can land on another
    shard than its source, and that surprise is the point of showing it."""
    ds = _ds("ds1", graph="src", mode="dedicated", dedicated="src_proj")
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()],
          data_sources=[(ds, "Workspace One")])
    snap = _run(topology.get_topology_snapshot())

    keys = {g.key: g for s in snap.instances[0].shards for g in s.graphs}
    assert set(keys) == {"src", "src_proj"}
    assert keys["src"].role == "source" and keys["src_proj"].role == "projection"
    assert keys["src"].slot == topology.key_slot("src")
    assert keys["src_proj"].slot == topology.key_slot("src_proj")
    assert topology.placement_keys_for(ds) == [("source", "src"), ("projection", "src_proj")]


def test_graph_sizes_are_measured_when_the_server_has_the_command(monkeypatch):
    nodes = _cluster_nodes({"graphs": {MASTERS[0]: ["g1"]}})
    slot_owner = MASTERS[topology.key_slot("g1") // 5461]
    nodes = _cluster_nodes({"graphs": {slot_owner: ["g1"]}})
    state = _wire(monkeypatch, nodes=nodes, providers=[_provider()],
                  data_sources=[(_ds("ds1", graph="g1"), "W")])
    snap = _run(topology.get_topology_snapshot())
    row = next(g for s in snap.instances[0].shards for g in s.graphs if g.key == "g1")
    assert row.measured_bytes == int(12.5 * 1024 ** 2)
    assert row.measured_detail["indices_sz_mb"] == int(2.5 * 1024 ** 2)
    assert ("g1" in [k for _e, k in state["measured_calls"]])


def test_a_server_without_graph_memory_falls_back_to_the_estimate(monkeypatch):
    slot_owner = MASTERS[topology.key_slot("g1") // 5461]
    nodes = _cluster_nodes({"graphs": {slot_owner: ["g1"]}})
    nodes[slot_owner]["graph_memory"] = "unsupported"
    _wire(monkeypatch, nodes=nodes, providers=[_provider()],
          data_sources=[(_ds("ds1", graph="g1", edges=100), "W")])
    snap = _run(topology.get_topology_snapshot())
    row = next(g for s in snap.instances[0].shards for g in s.graphs if g.key == "g1")
    assert row.measured_bytes is None and row.estimated_bytes == 100 * 512
    master = next(s.master for s in snap.instances[0].shards
                  if s.master.endpoint == slot_owner)
    assert master.graph_memory == "unsupported"
    # The rest of the node's reading is untouched by the missing command.
    assert master.status == "up" and master.memory.used == 10 * GB


# ── findings ─────────────────────────────────────────────────────────────


def test_replicas_re_running_every_write_is_called_out_with_its_fix(monkeypatch):
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    snap = _run(topology.get_topology_snapshot())
    codes = {f.code for s in snap.instances[0].shards for f in s.replication.findings}
    assert "effects_threshold_high" in codes
    finding = next(f for f in snap.instances[0].shards[0].replication.findings
                   if f.code == "effects_threshold_high")
    assert "300" in finding.text and "change log" in (finding.fix or "")
    assert finding.endpoint == MASTERS[0]
    # And the buffer that overflows into a resync under a rebuild.
    assert "output_buffer_small" in codes


def test_a_lagging_or_disconnected_replica_is_named(monkeypatch):
    nodes = _cluster_nodes({})
    nodes[MASTERS[0]]["info"] = _master_info(
        MASTERS[0], replicas=[("10.0.0.4:6379", 200 * 1024 ** 2), ("10.0.0.5:6379", 0)])
    nodes["10.0.0.4:6379"]["info"] = _replica_info(
        "10.0.0.4:6379", MASTERS[0], lag=200 * 1024 ** 2)
    nodes["10.0.0.5:6379"]["info"] = _replica_info(
        "10.0.0.5:6379", MASTERS[0], link="down")
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])

    snap = _run(topology.get_topology_snapshot())
    shard = snap.instances[0].shards[0]
    codes = {f.code for f in shard.replication.findings}
    assert "replica_behind" in codes and "replica_link_down" in codes
    assert shard.replication.max_lag_bytes == 200 * 1024 ** 2
    assert shard.replication.replicas_online == 1
    behind = next(f for f in shard.replication.findings if f.code == "replica_behind")
    assert "10.0.0.4:6379" in behind.text and "200.0 MB" in behind.text


def test_a_restart_and_a_resync_between_two_readings_are_reported(monkeypatch):
    """The evidence a restarted shard leaves: a new run id, and a resync
    count that grew. Nothing else in the product could say this happened."""
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    _run(topology.get_topology_snapshot())

    nodes[MASTERS[0]]["info"] = _master_info(
        MASTERS[0], replicas=[(r, 0) for r in REPLICAS_OF[MASTERS[0]]],
        run_id="run-after-restart", sync_full=2)
    topology._cache = None
    snap = _run(topology.get_topology_snapshot())

    shard = snap.instances[0].shards[0]
    assert shard.master.server.restarted_since_last is True
    codes = {f.code for f in shard.replication.findings}
    assert "node_restarted" in codes and "full_resync_storm" in codes
    restart = next(f for f in shard.replication.findings if f.code == "node_restarted")
    assert "lastState.terminated.reason" in (restart.fix or "")


# ── instances ────────────────────────────────────────────────────────────


def test_two_providers_on_one_cluster_are_one_instance(monkeypatch):
    """Two rows listing different seeds of the same cluster: one store, one
    card, every figure counted once."""
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[
        _provider("p1", "Alpha", seeds=("10.0.0.1:6379",)),
        _provider("p2", "Beta", seeds=("10.0.0.2:6379",), host="10.0.0.2"),
    ])
    snap = _run(topology.get_topology_snapshot())
    assert len(snap.instances) == 1
    assert sorted(p.id for p in snap.instances[0].providers) == ["p1", "p2"]
    assert snap.summary.masters == 3 and snap.summary.providers == 2
    assert topology.instance_for_provider(snap, "p2") is snap.instances[0]


def test_inactive_and_non_falkordb_providers_are_left_alone(monkeypatch):
    other = _provider("p2", "Neo")
    other.provider_type = "neo4j"
    inactive = _provider("p3", "Old")
    inactive.is_active = False
    _wire(monkeypatch, nodes=_cluster_nodes({}),
          providers=[_provider(), other, inactive])
    snap = _run(topology.get_topology_snapshot())
    assert [p.id for i in snap.instances for p in i.providers] == ["p1"]


def test_the_environment_default_instance_appears_only_when_configured(monkeypatch):
    monkeypatch.delenv("FALKORDB_HOST", raising=False)
    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    assert len(_run(topology.get_topology_snapshot()).instances) == 1

    monkeypatch.setenv("FALKORDB_HOST", "10.0.0.1")
    monkeypatch.setenv("FALKORDB_PORT", "6379")
    topology._cache = None
    snap = _run(topology.get_topology_snapshot())
    assert len(snap.instances) == 2
    assert any(i.env_default for i in snap.instances)


def test_the_order_never_depends_on_utilisation(monkeypatch):
    """Rows that reorder between refreshes read as rows that changed —
    which is how the old capacity card looked broken while it was fine."""
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    first = _run(topology.get_topology_snapshot())
    order = [s.master.endpoint for s in first.instances[0].shards]

    nodes[MASTERS[2]]["info"] = _master_info(
        MASTERS[2], used=39 * GB,
        replicas=[(r, 0) for r in REPLICAS_OF[MASTERS[2]]])
    topology._cache = None
    second = _run(topology.get_topology_snapshot())
    assert [s.master.endpoint for s in second.instances[0].shards] == order


# ── the cache ────────────────────────────────────────────────────────────


def test_the_snapshot_is_cached_and_fresh_bypasses_the_ttl(monkeypatch):
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    calls = {"n": 0}
    real = topology.build_snapshot

    async def _counting():
        calls["n"] += 1
        return await real()

    monkeypatch.setattr(topology, "build_snapshot", _counting)

    _run(topology.get_topology_snapshot())
    _run(topology.get_topology_snapshot())
    assert calls["n"] == 1
    _run(topology.get_topology_snapshot(fresh=True))
    assert calls["n"] == 2
    topology.invalidate_topology_cache()
    _run(topology.get_topology_snapshot())
    assert calls["n"] == 3


def test_a_failed_refresh_keeps_serving_the_last_good_reading(monkeypatch):
    """A blank page tells the operator less than a slightly old one — and
    a refresh that fails must never replace figures that worked."""
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    good = _run(topology.get_topology_snapshot())
    assert good.summary.nodes_total == 9 and not good.stale

    async def _boom():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(topology, "build_snapshot", _boom)
    stale = _run(topology.get_topology_snapshot(fresh=True))
    assert stale.stale and stale.summary.nodes_total == 9
    assert stale.last_error == "database unavailable"
    assert stale.cache_age_ms >= 0


def test_with_no_snapshot_at_all_the_failure_is_raised(monkeypatch):
    _wire(monkeypatch, nodes={}, providers=[])

    async def _boom():
        raise RuntimeError("nothing to serve")

    monkeypatch.setattr(topology, "build_snapshot", _boom)
    with pytest.raises(RuntimeError, match="nothing to serve"):
        _run(topology.get_topology_snapshot())


def test_a_failed_sweep_is_not_re_run_by_every_viewer(monkeypatch):
    """The lock alone does not prevent a stampede — it queues one. With the
    TTL still expired after a failure, every arriving caller waits out
    everybody ahead of it and then runs its own full sweep, and a failing
    sweep is the slow kind: a cluster mid-failover spends its whole
    deadline. The thirtieth viewer would wait minutes."""
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    good = _run(topology.get_topology_snapshot())
    assert good.summary.nodes_total == 9
    topology._cache = (time.monotonic() - 999, topology._cache[1])   # aged out

    calls = {"n": 0}

    async def _failing():
        calls["n"] += 1
        await asyncio.sleep(0.01)
        raise RuntimeError("the store is down")

    monkeypatch.setattr(topology, "build_snapshot", _failing)

    async def scenario():
        return await asyncio.gather(*(
            topology.get_topology_snapshot() for _ in range(25)
        ))

    snaps = _run(scenario())
    assert calls["n"] == 1
    # …and every one of them gets the last good reading, marked for what it is.
    assert all(s.stale and "the store is down" in (s.last_error or "") for s in snaps)
    assert all(s.summary.nodes_total == 9 for s in snaps)


def test_a_room_of_re_measures_costs_one_sweep(monkeypatch):
    """``fresh`` skips the TTL, not a sweep somebody else just finished."""
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    calls = {"n": 0}
    real = topology.build_snapshot

    async def _counting():
        calls["n"] += 1
        await asyncio.sleep(0.02)
        return await real()

    monkeypatch.setattr(topology, "build_snapshot", _counting)

    async def scenario():
        return await asyncio.gather(*(
            topology.get_topology_snapshot(fresh=True) for _ in range(10)
        ))

    snaps = _run(scenario())
    assert calls["n"] == 1
    assert all(s.summary.nodes_total == 9 for s in snaps)


def test_the_sweep_deadline_scales_with_the_fleet():
    """Nodes are read a wave at a time. A fixed fleet-wide deadline lets the
    first waves spend it and leaves the later ones nothing — and since the
    order is fixed, it is the SAME tail nodes every sweep that come back
    unread, so a healthy node reads as permanently unreachable."""
    one_wave = topology._sweep_deadline_s(topology._NODE_CONCURRENCY)
    assert topology._sweep_deadline_s(topology._NODE_CONCURRENCY + 1) > one_wave
    assert topology._sweep_deadline_s(50) > topology._sweep_deadline_s(20)
    # …but one sweep may never hold the build lock indefinitely.
    assert topology._sweep_deadline_s(10_000) == topology._SWEEP_DEADLINE_CAP_S


def test_restart_evidence_survives_a_sweep_that_fails_half_way(monkeypatch):
    """The previous sweep's run ids are the only thing that tells a
    restarted node from a slow one. Emptying them up front means any error
    before they are refilled leaves nothing to compare against, and the two
    critical findings go quiet for cycles — during exactly the instability
    that makes sweeps fail."""
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    _run(topology.get_topology_snapshot())
    remembered = dict(topology._prev_nodes)
    assert remembered

    def _boom(*a, **kw):
        raise RuntimeError("a node vanished mid-assembly")

    monkeypatch.setattr(topology, "_assemble_instance", _boom)
    topology._cache = None
    with pytest.raises(RuntimeError, match="mid-assembly"):
        _run(topology.get_topology_snapshot())
    assert topology._prev_nodes == remembered


def test_one_sweep_serves_concurrent_viewers(monkeypatch):
    """A hundred viewers must cost one sweep, not a hundred."""
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    calls = {"n": 0}
    real = topology.build_snapshot

    async def _counting():
        calls["n"] += 1
        await asyncio.sleep(0.02)
        return await real()

    monkeypatch.setattr(topology, "build_snapshot", _counting)

    async def scenario():
        return await asyncio.gather(*(
            topology.get_topology_snapshot() for _ in range(25)
        ))

    snaps = _run(scenario())
    assert calls["n"] == 1
    assert all(s.summary.nodes_total == 9 for s in snaps)
