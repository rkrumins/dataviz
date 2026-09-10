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


# Real `CLUSTER NODES` output, not a hand-made dict. Every field Redis
# sends is here — bus port, config epoch, link state — because the bugs
# this fixture is meant to catch live in the fields that used to be
# discarded before this module could see them.
CLUSTER_NODES_3x2 = "\n".join([
    "m1 10.0.0.1:6379@16379 myself,master - 0 0 1 connected 0-5460",
    "m2 10.0.0.2:6379@16379 master - 0 1 2 connected 5461-10922",
    "m3 10.0.0.3:6379@16379 master - 0 1 3 connected 10923-16383",
    "r1a 10.0.0.4:6379@16379 slave m1 0 1 1 connected",
    "r1b 10.0.0.5:6379@16379 slave m1 0 1 1 connected",
    "r2a 10.0.0.6:6379@16379 slave m2 0 1 2 connected",
    "r2b 10.0.0.7:6379@16379 slave m2 0 1 2 connected",
    "r3a 10.0.0.8:6379@16379 slave m3 0 1 3 connected",
    "r3b 10.0.0.9:6379@16379 slave m3 0 1 3 connected",
])

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
    """One node's answers.

    Absent from ``state['nodes']`` = refuses to connect, which is the EASY
    failure — it comes back in microseconds. A node carrying ``"hang": True``
    accepts the connection and then never answers, which is the failure that
    actually hurts: it spends the caller's whole budget, and if the sweep waits
    on it serially, one such node is enough to time the whole reading out.
    """

    def __init__(self, state, endpoint):
        self.state = state
        self.endpoint = endpoint

    def _me(self):
        node = self.state["nodes"].get(self.endpoint)
        if node is None:
            raise ConnectionError(
                f"Error 111 connecting to {self.endpoint}. Connection refused.")
        return node

    async def _maybe_hang(self):
        if self._me().get("hang"):
            await asyncio.sleep(3600)

    async def ping(self):
        self._me()
        await self._maybe_hang()
        return True

    async def info(self, *sections):
        return dict(self._me().get("info") or {})

    async def config_get(self, *names):
        me = self._me()
        return {k: v for k, v in (me.get("config") or {}).items() if k in names}

    def set_response_callback(self, command, callback):
        # The real client is told to hand back CLUSTER NODES as text rather
        # than as redis-py's dict; this fake only ever spoke text.
        self.state.setdefault("raw_callbacks", []).append(command)

    async def execute_command(self, command, *args):
        me = self._me()
        if command == "CLUSTER NODES":
            if self.state.get("cluster_nodes_refused"):
                from redis.exceptions import ResponseError
                raise ResponseError("unknown command 'CLUSTER'")
            return self.state["cluster_nodes"]
        if command == "CLUSTER INFO":
            return self.state.get("cluster_info") or (
                "cluster_state:ok\r\ncluster_known_nodes:9\r\ncluster_size:3\r\n"
            )
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
          cluster_nodes=None, cluster_nodes_refused=False, tuning=None,
          cluster_info=None):
    """Stub the two collaborators: the nodes and the database."""
    state = {
        "nodes": nodes,
        "cluster_nodes": cluster_nodes if cluster_nodes is not None else CLUSTER_NODES_3x2,
        "cluster_nodes_refused": cluster_nodes_refused,
        "cluster_info": cluster_info,
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

        def first(self):
            return self._rows[0] if self._rows else None

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
    topology._refresh_task = None
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


def _cfg(**over):
    conn = {"mode": "cluster"}
    conn.update(over)
    return load_connection_config(conn, host="seed-host", port=7000,
                                  username=None, password=None)


# A cluster in every state a real one gets into. Written as Redis writes it,
# because every bug this block exists to catch lived in a field that used to
# be discarded before the module could see it.
MESSY_CLUSTER = "\n".join([
    "aaaa1111 :6379@16379 myself,master - 0 0 7 connected 0-5460 [5461->-bbbb2222]",
    "bbbb2222 10.0.0.2:6379@16379,node2.example.com master - 0 1 9 connected 5461-10922",
    "cccc3333 10.0.0.3:6379@16379,,shard-id=ff00 master - 0 1 3 disconnected 10923-16383",
    "dddd4444 10.0.0.4:6379@16379 slave,nofailover bbbb2222 0 1 2 connected",
    "eeee5555 :0@0 master,noaddr - 0 1 0 disconnected",
    "ffff6666 :0@0 slave,noaddr,fail bbbb2222 0 1 0 disconnected",
    "9999aaaa 10.0.0.9:6379@16379 handshake - 0 1 0 disconnected",
    "7777cccc 10.0.0.7:6379@16379 master - 0 1 9 connected",
    "6666dddd 10.0.0.6:6379@16379 slave 7777cccc 0 1 9 connected",
    "5555eeee 10.0.0.5:6379@16379 slave dddd4444 0 1 2 connected",
    "8888ffff 10.0.0.8:6379@16379 slave deadbeef 0 1 1 connected",
])


def test_every_line_of_a_real_reply_becomes_exactly_one_node():
    """The reply is parsed from its text, not from redis-py's dict: that
    dict is keyed on `ip:port`, so every node the cluster has no address
    for collapses onto `":0"` and all but one are lost. Two pods losing
    their addresses at once is enough — a rolling restart will do it."""
    nodes = discovery.parse_cluster_nodes_text(
        MESSY_CLUSTER, _cfg(), seed=("seed-host", 7000))
    assert len(nodes) == 11                          # eleven lines, eleven nodes
    by_id = {n.node_id: n for n in nodes}
    assert "eeee5555" in by_id and "ffff6666" in by_id   # both no-address nodes


def test_a_flag_is_a_token_not_a_substring():
    """`"fail" in "slave,nofailover"` is true. That is how a replica held
    out of failover — standard for a cross-AZ or restoring replica — came
    to be rendered red, labelled FAIL, over a tooltip reading "the
    cluster's agreement"."""
    by_id = {n.node_id: n for n in discovery.parse_cluster_nodes_text(
        MESSY_CLUSTER, _cfg(), seed=("seed-host", 7000))}
    assert by_id["dddd4444"].gossip is None          # healthy, held out of failover
    assert by_id["ffff6666"].gossip == "fail"        # genuinely failed
    assert by_id["eeee5555"].gossip == "noaddr"
    assert by_id["9999aaaa"].gossip == "handshake"


def test_a_node_mid_meet_is_not_a_master():
    """Treating "not a slave" as "a master" gave a node still shaking hands
    a shard of its own, a place in the master count, and a full sweep of
    GRAPH.LIST and GRAPH.MEMORY against a node not yet in the cluster."""
    nodes = discovery.parse_cluster_nodes_text(
        MESSY_CLUSTER, _cfg(), seed=("seed-host", 7000))
    by_id = {n.node_id: n for n in nodes}
    assert by_id["9999aaaa"].role == "joining"

    shards, unplaced = discovery.group_shards(nodes)
    assert "9999aaaa" not in [m.node_id for m, _ in shards]
    assert "9999aaaa" in [n.node_id for n in unplaced]


def test_the_link_state_and_the_epoch_are_read():
    by_id = {n.node_id: n for n in discovery.parse_cluster_nodes_text(
        MESSY_CLUSTER, _cfg(), seed=("seed-host", 7000))}
    # A bus link can be down long before the cluster agrees on FAIL; the row
    # used to be indistinguishable from a healthy one.
    assert by_id["cccc3333"].link_state == "disconnected"
    assert by_id["bbbb2222"].link_state == "connected"
    assert (by_id["aaaa1111"].epoch, by_id["bbbb2222"].epoch) == (7, 9)


def test_a_reshard_in_flight_is_recorded():
    by_id = {n.node_id: n for n in discovery.parse_cluster_nodes_text(
        MESSY_CLUSTER, _cfg(), seed=("seed-host", 7000))}
    assert by_id["aaaa1111"].migrating == [(5461, "bbbb2222")]
    # A migrating slot is still owned until the move completes, so it stays
    # in the ranges and coverage does not dip while a reshard runs.
    assert by_id["aaaa1111"].slots == [[0, 5460]]


def test_the_announced_address_is_what_the_cluster_said():
    by_id = {n.node_id: n for n in discovery.parse_cluster_nodes_text(
        MESSY_CLUSTER, _cfg(), seed=("seed-host", 7000))}
    # The answering node announces no ip. The seed stands in so it is
    # dialable — but `announced` must still say what the cluster said, not
    # the seed's port.
    assert by_id["aaaa1111"].endpoint == "seed-host:7000"
    assert by_id["aaaa1111"].announced == "?:6379" and by_id["aaaa1111"].dialable
    # An announced hostname wins over the pod ip; the aux fields after it
    # are not mistaken for one.
    assert by_id["bbbb2222"].endpoint == "node2.example.com:6379"
    assert by_id["cccc3333"].endpoint == "10.0.0.3:6379"
    # A node with no address at all is a row with a reason, never a gap.
    assert not by_id["eeee5555"].dialable
    assert "no address" in (by_id["eeee5555"].reason or "")


def test_a_replica_is_never_hung_off_a_master_it_does_not_follow():
    """An unattributable replica used to be appended to the FIRST shard —
    the master owning slot 0, which it has nothing to do with. That claimed
    a replication relationship the cluster never described, filed its lag
    and its findings under the wrong master, and inflated that shard's
    replica count."""
    nodes = discovery.parse_cluster_nodes_text(
        MESSY_CLUSTER, _cfg(), seed=("seed-host", 7000))
    shards, unplaced = discovery.group_shards(nodes)
    by_master = {m.node_id: [r.node_id for r in reps] for m, reps in shards}

    # A chain — 5555eeee follows dddd4444, itself a replica of bbbb2222 —
    # resolves to the master at its head rather than to slot 0's master.
    assert sorted(by_master["bbbb2222"]) == ["5555eeee", "dddd4444", "ffff6666"]
    # A replica naming a master that is not in the reply at all is unplaced,
    # not adopted by whoever happens to own slot 0.
    assert "8888ffff" in [n.node_id for n in unplaced]
    assert by_master["aaaa1111"] == []
    # …while a replica whose master IS in view stays with it, failed or not.
    assert "ffff6666" in by_master["bbbb2222"]


def test_a_master_with_no_slots_is_shown_with_its_replicas_and_sorts_last():
    """It is in the cluster and owns nothing — the state behind "clear FAIL
    state for node without slots" in an operator's logs, and worth seeing
    rather than hiding."""
    nodes = discovery.parse_cluster_nodes_text(
        MESSY_CLUSTER, _cfg(), seed=("seed-host", 7000))
    shards, _unplaced = discovery.group_shards(nodes)
    order = [m.node_id for m, _ in shards]
    # The three slot owners first, in slot order; the slotless ones after.
    assert order[:3] == ["aaaa1111", "bbbb2222", "cccc3333"]
    assert set(order[3:]) == {"7777cccc", "eeee5555"}
    by_master = {m.node_id: [r.node_id for r in reps] for m, reps in shards}
    assert by_master["7777cccc"] == ["6666dddd"]


def test_two_nodes_reaching_one_address_are_reported_not_merged():
    """The endpoint is what every reading, cache entry and table row is
    keyed by, so two nodes at one address become one row shown twice with
    the same figures — and inflate every count on the page. The cross-pod
    fan-out already refuses to run in this state; a view that refuses to
    load helps nobody, so this one says so instead."""
    cfg = _cfg(addressRemap={"10.0.0.3:6379": "gw:7000", "10.0.0.7:6379": "gw:7000"})
    nodes = discovery.parse_cluster_nodes_text(MESSY_CLUSTER, cfg, seed=("seed-host", 7000))
    collisions = discovery.endpoint_collisions(nodes)
    assert sorted(collisions["gw:7000"]) == ["7777cccc", "cccc3333"]
    # …and both nodes survive as themselves.
    assert len([n for n in nodes if n.endpoint == "gw:7000"]) == 2


def test_address_remap_applies_to_replicas_too():
    """Only masters were ever dialled before, so the remap was only ever
    exercised on them; a replica behind the same remap must be dialable."""
    cfg = _cfg(addressRemap={"10.0.0.4:6379": "gw:7004"})
    nodes = discovery.parse_cluster_nodes_text(
        "r 10.0.0.4:6379@16379 slave m 0 1 1 connected", cfg)
    assert nodes[0].endpoint == "gw:7004" and nodes[0].announced == "10.0.0.4:6379"


def test_a_bare_slot_and_a_range_both_parse():
    nodes = discovery.parse_cluster_nodes_text(
        "m 10.0.0.1:6379@16379 master - 0 1 1 connected 0-5460 7000", _cfg())
    assert nodes[0].slots == [[0, 5460], [7000, 7000]]


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


def test_a_messy_cluster_is_reported_as_the_cluster_describes_it(monkeypatch):
    """End to end over a reply with every state a real cluster gets into.
    The count on the page has to equal the count in the cluster, and no node
    may appear anywhere the cluster did not put it."""
    # Only the seed answers; every other node is a row with a reason. That
    # is the point — the shape of the cluster comes from what it says about
    # itself, not from which of its nodes happen to be reachable.
    seed_only = {"10.0.0.1:6379": _cluster_nodes({})["10.0.0.1:6379"]}
    _wire(monkeypatch, nodes=seed_only, providers=[_provider()],
          cluster_nodes=MESSY_CLUSTER,
          # The cluster knows more nodes than this seed can see.
          cluster_info="cluster_state:ok\r\ncluster_known_nodes:12\r\ncluster_size:3\r\n")
    snap = _run(topology.get_topology_snapshot())
    instance = snap.instances[0]

    # Eleven lines, eleven nodes — none dropped, none invented.
    assert instance.totals.nodes_total == 11
    assert instance.known_nodes == 12 and instance.cluster_state == "ok"
    # …and the cluster's own count disagreeing with ours is said out loud
    # rather than left for someone to notice.
    assert "nodes_missing_from_view" in [f.code for f in instance.findings]

    # Five masters: three owning slots, two owning none. The node mid-MEET
    # is not one of them.
    masters = [s.master.node_id for s in instance.shards]
    assert masters[:3] == ["aaaa1111", "bbbb2222", "cccc3333"]
    assert set(masters[3:]) == {"7777cccc", "eeee5555"}
    assert "9999aaaa" not in masters

    # Every replica under the master the cluster gave it, and the two the
    # cluster placed nowhere placed nowhere.
    by_master = {s.master.node_id: sorted(r.node_id for r in s.replicas)
                 for s in instance.shards}
    assert by_master["aaaa1111"] == []
    assert by_master["bbbb2222"] == ["5555eeee", "dddd4444", "ffff6666"]
    assert by_master["7777cccc"] == ["6666dddd"]
    assert sorted(n.node_id for n in instance.unplaced_nodes) == ["8888ffff", "9999aaaa"]


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


def test_discovery_asks_the_nodes_it_last_saw_before_the_configured_seeds(monkeypatch):
    """A provider's seeds are its masters as they were on the day it was set
    up, and masters move. When all three of those pods are gone the store
    reads as unreachable while the cluster is perfectly healthy."""
    asked: list = []

    def _client(cfg, host, port, *, socket_timeout):
        asked.append(f"{host}:{port}")
        raise ConnectionError("refused")

    monkeypatch.setattr(discovery, "node_client", _client)
    cfg = load_connection_config(
        {"mode": "cluster", "cluster": {"startupNodes": ["10.0.0.1:6379"]}},
        host="10.0.0.1", port=6379, username=None, password=None,
    )
    _run(discovery.discover_cluster(cfg, 0.2, [("10.0.9.9", 6379)]))
    # The node that answered last time first; the configured seed after it,
    # and neither is asked twice.
    assert asked[:2] == ["10.0.9.9:6379", "10.0.0.1:6379"]


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


def test_a_failover_in_flight_keeps_the_shard_and_says_what_disagrees(monkeypatch):
    """The moment a master hands over: the cluster still calls it the master
    of its slots, its own INFO already says replica, and the replica that
    took over says master.

    Reading that node as a replica used to mean GRAPH.LIST was never sent to
    it, so every graph on the shard flipped to "not found on the node" — a
    page announcing data loss for a cluster that had merely failed over.
    """
    key = "g_alpha"
    owner = next(i for i, (lo, hi) in enumerate(
        [(0, 5460), (5461, 10922), (10923, 16383)])
        if lo <= topology.key_slot(key) <= hi)
    nodes = _cluster_nodes({"graphs": {MASTERS[owner]: [key]}})
    nodes[MASTERS[owner]]["info"] = _replica_info(MASTERS[owner], REPLICAS_OF[MASTERS[owner]][0])
    nodes[REPLICAS_OF[MASTERS[owner]][0]]["info"] = _master_info(
        REPLICAS_OF[MASTERS[owner]][0], replicas=[])
    _wire(monkeypatch, nodes=nodes, providers=[_provider()],
          data_sources=[(_ds("ds1", graph=key), "Workspace One")])

    snap = _run(topology.get_topology_snapshot())
    shard = snap.instances[0].shards[owner]
    promoted = REPLICAS_OF[MASTERS[owner]][0]

    # The slots are read where the cluster puts them, so the graph is there.
    assert [g.key for g in shard.graphs if g.present] == [key]

    # Both halves of the disagreement are named, on the nodes they are about.
    disagreements = {f.endpoint: f for f in shard.replication.findings
                     if f.code == "role_disagreement"}
    assert set(disagreements) == {MASTERS[owner], promoted}
    assert "calls itself a replica" in disagreements[MASTERS[owner]].text
    assert "calls itself a master" in disagreements[promoted].text

    # And the promoted node is not counted as an online replica of itself:
    # one of the two is replicating, not both.
    assert shard.replication.replicas_online == 1
    assert shard.replication.replicas_total == 2


def test_a_settled_cluster_reports_no_disagreement(monkeypatch):
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    snap = _run(topology.get_topology_snapshot())
    codes = {f.code for s in snap.instances[0].shards for f in s.replication.findings}
    assert "role_disagreement" not in codes
    assert all(s.replication.replicas_online == 2 for s in snap.instances[0].shards)


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


def test_the_environment_connection_is_never_a_store_on_this_page(monkeypatch):
    """There is no default graph store. A data source's provider_id is NOT
    NULL, so every graph this page accounts for belongs to a provider's
    store; FALKORDB_HOST is the connection the application was bootstrapped
    with. Sweeping it invented a store the operator had no way to act on,
    put a phantom node's memory in the fleet totals, and — when the address
    was left over from another environment — reported an outage on
    something nothing reads."""
    monkeypatch.setenv("FALKORDB_HOST", "10.9.9.9")
    monkeypatch.setenv("FALKORDB_PORT", "6379")
    monkeypatch.delenv("FALKORDB_MODE", raising=False)

    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()],
          data_sources=[(_ds("ds1", provider="p1", graph="g1"), "Data")])
    snap = _run(topology.get_topology_snapshot())
    assert len(snap.instances) == 1
    assert {p.id for p in snap.instances[0].providers} == {"p1"}

    # …and with no provider rows there is nothing to show. The page says so
    # with the one thing that helps: add a provider.
    topology._cache = None
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[])
    assert _run(topology.get_topology_snapshot()).instances == []


def test_a_source_with_no_provider_resolves_to_nothing_rather_than_a_guess(monkeypatch):
    """The column is NOT NULL, so this cannot happen from the catalogue —
    and if it ever did, routing the graph to whatever the environment names
    would put its lineage on the wrong store silently."""
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    snap = _run(topology.get_topology_snapshot())
    assert topology.instance_for_provider(snap, "") is None


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


def test_a_request_never_waits_for_a_sweep(monkeypatch):
    """A sweep reads every node of every store behind a lock — on a cluster
    mid-rotation, longer than any gateway holds a connection. The request
    that triggers one must not be the one that pays for it, or it dies with
    a 504 having done all the work and kept none of it."""
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    real = topology.build_snapshot

    async def _slow():
        await asyncio.sleep(5)
        return await real()

    monkeypatch.setattr(topology, "build_snapshot", _slow)

    async def scenario():
        began = time.monotonic()
        snap, refreshing = await topology.snapshot_for_request()
        elapsed = time.monotonic() - began
        task = topology._refresh_task
        if task is not None:
            task.cancel()
        return snap, refreshing, elapsed

    snap, refreshing, elapsed = _run(scenario())
    assert snap is None                              # nothing cached yet
    assert refreshing                                # …and a sweep is on its way
    assert elapsed < 1.0                             # the sweep takes five


def test_a_second_request_joins_the_sweep_rather_than_starting_another(monkeypatch):
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    calls = {"n": 0}
    real = topology.build_snapshot

    async def _counting():
        calls["n"] += 1
        await asyncio.sleep(0.05)
        return await real()

    monkeypatch.setattr(topology, "build_snapshot", _counting)

    async def scenario():
        out = await asyncio.gather(*(
            topology.snapshot_for_request() for _ in range(10)
        ))
        task = topology._refresh_task
        if task is not None:
            await task
        return out

    results = _run(scenario())
    assert calls["n"] == 1
    assert all(refreshing for _snap, refreshing in results)


def test_re_measure_holds_briefly_and_then_answers_anyway(monkeypatch):
    """The button asked for the sweep, so it may wait for it — but not past
    the gateway. Whatever is cached comes back either way."""
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()])
    real = topology.build_snapshot

    async def _slow():
        await asyncio.sleep(5)
        return await real()

    monkeypatch.setattr(topology, "build_snapshot", _slow)

    async def scenario():
        began = time.monotonic()
        snap, refreshing = await topology.snapshot_for_request(fresh=True, wait_s=0.05)
        task = topology._refresh_task
        if task is not None:
            task.cancel()
        return snap, refreshing, time.monotonic() - began

    snap, refreshing, elapsed = _run(scenario())
    assert snap is None and refreshing
    assert elapsed < 1.0


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


def test_a_rolling_restart_shows_the_last_reading_rather_than_blanks(monkeypatch):
    """Three of nine pods away at once is `kubectl rollout restart`, not an
    outage. Blanking their memory, their limits and their replication the
    moment they stop answering is how a routine restart reads as a fleet
    falling over — and it is exactly when someone is watching the page."""
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    _run(topology.get_topology_snapshot())

    rolling = REPLICAS_OF[MASTERS[0]] + [MASTERS[1]]
    for endpoint in rolling:
        nodes.pop(endpoint)
    topology._cache = None
    snap = _run(topology.get_topology_snapshot())

    by_endpoint = {n.endpoint: n for i in snap.instances for s in i.shards
                   for n in (s.master, *s.replicas)}
    for endpoint in rolling:
        node = by_endpoint[endpoint]
        # The figures stand, with their age attached…
        assert node.memory.used is not None, endpoint
        assert node.figures_age_s is not None and node.figures_age_s >= 0
        # …and the node is still, plainly, not answering.
        assert node.status == "unreachable"
        assert "refused" in (node.error or "").lower()

    # So the counts stay honest: carried-forward is not up.
    assert snap.summary.nodes_total == 9
    assert snap.summary.nodes_up == 6
    assert snap.summary.unreachable_nodes == 3

    # And when the pods come back, the figures are theirs again.
    for endpoint in rolling:
        nodes[endpoint] = _cluster_nodes({})[endpoint]
    topology._cache = None
    back = _run(topology.get_topology_snapshot())
    assert back.summary.nodes_up == 9
    assert all(n.figures_age_s is None for i in back.instances for s in i.shards
               for n in (s.master, *s.replicas))


def test_a_node_that_was_down_last_sweep_is_not_waited_on_again(monkeypatch):
    """Nine pods rolling means several dead dials per sweep, each spending a
    full connect budget — so the sweep is slowest exactly when the cluster
    is changing. A node that did not answer last time gets a short retry:
    one that is back answers a PING well inside it."""
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    budgets: list = []
    real = discovery.read_node

    async def _record(cfg, node, *, budget, **kw):
        budgets.append((node.endpoint, budget))
        return await real(cfg, node, budget=budget, **kw)

    monkeypatch.setattr(discovery, "read_node", _record)

    nodes.pop(MASTERS[1])
    _run(topology.get_topology_snapshot())
    first = dict(budgets)
    assert first[MASTERS[1]] == first[MASTERS[0]]      # unknown: full budget

    budgets.clear()
    topology._cache = None
    _run(topology.get_topology_snapshot())
    second = dict(budgets)
    assert second[MASTERS[1]] == topology._DOWN_NODE_BUDGET_S
    assert second[MASTERS[0]] == first[MASTERS[0]]     # the live ones, unchanged


def test_figures_older_than_the_carry_forward_window_are_not_shown(monkeypatch):
    """Past a few minutes a node's last numbers say nothing useful about
    what it holds now, so they stop standing in for it."""
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])
    _run(topology.get_topology_snapshot())

    for key in topology._prev_nodes.values():
        if key.get("readingAt") is not None:
            key["readingAt"] -= topology._CARRY_FORWARD_MAX_S + 1
    nodes.pop(MASTERS[1])
    topology._cache = None
    snap = _run(topology.get_topology_snapshot())

    stale_node = next(s.master for i in snap.instances for s in i.shards
                      if s.master.endpoint == MASTERS[1])
    assert stale_node.status == "unreachable"
    assert stale_node.figures_age_s is None
    assert stale_node.memory.used is None


# ── one bad node in nine ─────────────────────────────────────────────────
#
# The operator's standard: a single sick node must never make the page
# useless. Each of these kills exactly ONE of the nine and asserts the other
# eight are still reported, with the fleet counts honest about the loss.


def test_one_refusing_replica_costs_one_row_and_nothing_else(monkeypatch):
    nodes = _cluster_nodes({})
    dead = REPLICAS_OF[MASTERS[0]][0]
    nodes.pop(dead)
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])

    snap = _run(topology.get_topology_snapshot())
    inst = snap.instances[0]
    assert inst.totals.nodes_total == 9 and inst.totals.nodes_up == 8
    assert len(inst.shards) == 3                       # every shard still drawn
    assert all(s.master.status == "up" for s in inst.shards)
    row = next(r for s in inst.shards for r in s.replicas if r.endpoint == dead)
    assert row.status == "unreachable" and "refused" in (row.error or "").lower()
    # Its shard still reports the other replica as online, not zero.
    assert inst.shards[0].replication.replicas_online == 1


def test_a_dead_master_does_not_take_the_other_two_shards_with_it(monkeypatch):
    """The failure the page exists for. One master of three is gone: its own
    shard degrades, and the other six nodes must read exactly as before."""
    nodes = _cluster_nodes({})
    nodes.pop(MASTERS[1])
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])

    snap = _run(topology.get_topology_snapshot())
    inst = snap.instances[0]
    assert inst.totals.nodes_total == 9 and inst.totals.nodes_up == 8
    assert len(inst.shards) == 3

    hurt = next(s for s in inst.shards if s.master.endpoint == MASTERS[1])
    assert hurt.master.status == "unreachable"
    # Its replicas are still there to be promoted, and still measured.
    assert len(hurt.replicas) == 2
    assert all(r.status == "up" and r.memory.used is not None for r in hurt.replicas)

    for healthy in (s for s in inst.shards if s.master.endpoint != MASTERS[1]):
        assert healthy.master.status == "up"
        assert healthy.master.memory.used is not None
        assert healthy.replication.replicas_online == 2
        assert healthy.capacity is not None, "a dead peer nulled a healthy shard's budget"


def test_a_hanging_node_does_not_hold_the_other_eight(monkeypatch):
    """A node that ACCEPTS the connection and then never answers is the
    failure that actually hurts — it spends the caller's whole budget rather
    than failing fast. Read serially, one of these times the whole reading
    out; the other eight must still arrive."""
    nodes = _cluster_nodes({})
    nodes[REPLICAS_OF[MASTERS[2]][1]]["hang"] = True
    _wire(monkeypatch, nodes=nodes, providers=[_provider()])

    started = time.monotonic()
    snap = _run(topology.get_topology_snapshot())
    elapsed = time.monotonic() - started

    inst = snap.instances[0]
    assert inst.totals.nodes_total == 9
    assert inst.totals.nodes_up == 8, "the hanging node was counted as up"
    assert elapsed < topology._SWEEP_DEADLINE_CAP_S, (
        f"one hanging node held the sweep for {elapsed:.1f}s")
    # Everything else is fully measured, not merely listed.
    up = [n for s in inst.shards for n in (s.master, *s.replicas) if n.status == "up"]
    assert len(up) == 8 and all(n.memory.used is not None for n in up)


def test_a_whole_provider_that_is_gone_does_not_blank_the_one_beside_it(monkeypatch):
    """Two stores, one unreachable. The fleet view is the surface an operator
    opens DURING an incident; it cannot be all-or-nothing."""
    nodes = _cluster_nodes({})
    _wire(monkeypatch, nodes=nodes, providers=[
        _provider("p1", "Alive"),
        _provider("p2", "Gone", seeds=("10.9.9.9:6379",), host="10.9.9.9"),
    ])

    snap = _run(topology.get_topology_snapshot())
    by_name = {i.providers[0].name: i for i in snap.instances}
    assert set(by_name) == {"Alive", "Gone"}
    assert by_name["Alive"].reachable and by_name["Alive"].totals.nodes_up == 9
    assert not by_name["Gone"].reachable
    assert by_name["Gone"].error, "an unreachable store must say why"
    # The healthy store's figures are its own, not the fleet's average.
    assert snap.summary.nodes_up == 9


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

    monkeypatch.setattr(topology, "_assemble_nodes", _boom)
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


# ── one physical store, however many rows point at it ────────────────────


def test_two_providers_on_one_cluster_keep_both_their_graphs(monkeypatch):
    """Two rows can list disjoint seeds of the same cluster. They fold onto
    one card — and the graphs of BOTH must survive the fold, or the second
    provider's sources read as orphans nobody claims on a store that is
    holding them perfectly well."""
    nodes = _cluster_nodes({"graphs": {MASTERS[0]: [], MASTERS[1]: [], MASTERS[2]: []}})
    for master in MASTERS:
        nodes[master]["graphs"] = ["g_from_p1", "g_from_p2"]
    _wire(
        monkeypatch, nodes=nodes,
        providers=[_provider("p1", "Falkor A", seeds=("10.0.0.1:6379",)),
                   _provider("p2", "Falkor B", seeds=("10.0.0.2:6379",), host="10.0.0.2")],
        data_sources=[(_ds("ds1", provider="p1", graph="g_from_p1"), "Data"),
                      (_ds("ds2", provider="p2", graph="g_from_p2"), "Data")],
    )
    snap = _run(topology.get_topology_snapshot())
    assert len(snap.instances) == 1                      # one store, not two
    instance = snap.instances[0]
    assert {p.id for p in instance.providers} == {"p1", "p2"}

    rows = {g.key: g for s in instance.shards for g in s.graphs}
    assert rows["g_from_p1"].role == "source"
    assert rows["g_from_p2"].role == "source"            # not "unregistered"
    assert [d.id for d in rows["g_from_p2"].data_sources] == ["ds2"]
    assert instance.totals.unregistered_graphs == 0
    # Each row asked the nodes to measure its OWN graphs; the fold keeps
    # both answers, or the second provider's sources are sized by estimate
    # on a store that measured them.
    assert rows["g_from_p1"].measured_bytes and rows["g_from_p2"].measured_bytes

    # …and each provider's own view resolves to that one store.
    for pid in ("p1", "p2"):
        assert topology.instance_for_provider(snap, pid) is not None


def test_one_node_named_two_ways_is_not_counted_twice(monkeypatch):
    """A standalone store reached as a DNS name by one row and an address by
    another is ONE server. Two cards would double its memory in the fleet
    total and report twice as many nodes as the deployment has."""
    same_run = "run-shared-node"
    nodes = {
        "falkordb:6379": {
            "info": _master_info("falkordb:6379", run_id=same_run),
            "graphs": ["g1"], "graph_config": {}, "ping": True,
        },
        "10.0.0.1:6379": {
            "info": _master_info("10.0.0.1:6379", run_id=same_run),
            "graphs": ["g1"], "graph_config": {}, "ping": True,
        },
    }
    _wire(
        monkeypatch, nodes=nodes,
        providers=[_provider("p1", "By name", mode="standalone", host="falkordb"),
                   _provider("p2", "By address", mode="standalone", host="10.0.0.1")],
        data_sources=[(_ds("ds1", provider="p1", graph="g1"), "Data")],
    )
    snap = _run(topology.get_topology_snapshot())
    assert len(snap.instances) == 1
    assert {p.id for p in snap.instances[0].providers} == {"p1", "p2"}
    assert snap.summary.nodes_total == 1
    assert snap.summary.used_memory == 10 * GB          # not 20


def test_no_default_store_is_invented_where_every_source_has_a_provider(monkeypatch):
    """FALKORDB_HOST is the connection the app was bootstrapped with. Where
    every source routes through a provider row, it is not a store anyone
    uses — and a card for it invents a "default graph store" the operator
    does not have, adds its memory to the fleet, and reports an outage on
    something nobody reads when the address is stale."""
    monkeypatch.setenv("FALKORDB_HOST", "10.9.9.9")
    monkeypatch.setenv("FALKORDB_PORT", "6379")
    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    _wire(monkeypatch, nodes=_cluster_nodes({}), providers=[_provider()],
          data_sources=[(_ds("ds1", provider="p1", graph="g1"), "Data")])
    snap = _run(topology.get_topology_snapshot())
    assert len(snap.instances) == 1
    assert {p.id for p in snap.instances[0].providers} == {"p1"}
