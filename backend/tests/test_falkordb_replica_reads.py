"""Read-only queries served by a shard's in-sync replicas.

On a cluster with two replicas per shard, the master took every write AND
answered every read — two thirds of the hardware idle while the master's
query threads were the bottleneck for a hundred people opening canvases at
once. A read-only Cypher can be answered by a replica that is in step.

The danger is a stale answer, so the router is deliberately timid: the
provider must allow it, the replica must be online and inside the lag
threshold, this process must not have written to that graph recently, and a
replica that just failed is skipped. Anything the router is unsure of goes
to the master. These tests pin each of those, because a read routed wrongly
is a correctness bug that looks like a caching bug.
"""
from __future__ import annotations

import asyncio
import time
import types

import pytest

from backend.app.providers import falkordb_provider as fp
from backend.app.providers.falkordb_provider import FalkorDBProvider


def _run(coro):
    return asyncio.run(coro)


class _Node:
    def __init__(self, host, port=6379):
        self.host, self.port = host, port

    def __repr__(self):
        return f"{self.host}:{self.port}"


MASTER = _Node("10.0.0.1")
R1 = _Node("10.0.1.1")
R2 = _Node("10.0.2.1")


class _Conn:
    """A cluster connection whose slot map has one master and two replicas."""

    def __init__(self, *, replicas=(R1, R2), info=None):
        self.nodes_manager = types.SimpleNamespace(
            slots_cache={7: [MASTER, *replicas]},
            get_node_from_slot=lambda slot: MASTER,
        )
        self._info = info if info is not None else {
            "role": "master", "connected_slaves": 2, "master_repl_offset": 100,
            "slave0": {"ip": "10.0.1.1", "port": "6379", "state": "online", "offset": 100, "lag": 0},
            "slave1": {"ip": "10.0.2.1", "port": "6379", "state": "online", "offset": 100, "lag": 0},
        }
        self.calls = []

    def keyslot(self, key):
        return 7

    async def initialize(self):
        return None

    async def execute_command(self, command, *args, target_nodes=None):
        self.calls.append((command, args, target_nodes))
        if command == "INFO":
            return self._info
        return "OK"


class _Graph:
    """A FalkorDB graph object, in the shape the router copies: it binds its
    client's ``execute_command`` at construction."""

    def __init__(self, client, name="g1"):
        self.name = name
        self.client = client
        self.execute_command = client.execute_command

    async def query(self, cypher, params=None, timeout=None):
        await self.execute_command("GRAPH.QUERY", self.name, cypher)
        return types.SimpleNamespace(result_set=[])

    async def ro_query(self, cypher, params=None, timeout=None):
        # Where a read LANDED is what these tests are about, and the client
        # records the node its sender addressed — so the query goes through
        # execute_command exactly as the real one does.
        await self.execute_command("GRAPH.RO_QUERY", self.name, cypher)
        return types.SimpleNamespace(result_set=[])


def _provider(conn, *, mode="cluster", read_from_replicas="auto"):
    p = object.__new__(FalkorDBProvider)
    p._graph_name = "g1"
    p._conn_cfg = types.SimpleNamespace(mode=mode, read_from_replicas=read_from_replicas)
    p._db = types.SimpleNamespace(connection=conn)
    p._proj_db = types.SimpleNamespace(connection=conn)
    p._graph = _Graph(conn)
    p._proj_graph = _Graph(conn, name="g1_proj")
    p._projection_mode = "in_source"
    p._replica_reads = p._master_reads = p._replica_fallbacks = 0
    return p


# ── the gates ────────────────────────────────────────────────────────────


def test_a_read_goes_to_a_replica_when_every_gate_is_open():
    p = _provider(_Conn())
    node = _run(p._replica_for("g1"))
    assert node in (R1, R2)


def test_the_two_replicas_take_turns():
    """One replica taking every read of a shard is the master problem again,
    one node over."""
    p = _provider(_Conn())
    seen = {str(_run(p._replica_for("g1"))) for _ in range(4)}
    assert seen == {"10.0.1.1:6379", "10.0.2.1:6379"}


def test_a_provider_pinned_to_its_master_never_routes():
    p = _provider(_Conn(), read_from_replicas="never")
    assert _run(p._replica_for("g1")) is None


def test_standalone_and_sentinel_never_route():
    """There is no replica in the client's slot map to route to, and the
    sentinel client follows failover inside its own pool."""
    for mode in ("standalone", "sentinel"):
        p = _provider(_Conn(), mode=mode)
        assert _run(p._replica_for("g1")) is None


def test_a_replica_that_is_behind_does_not_answer():
    """Behind is measured in BYTES OWED, not in the `lag` seconds INFO
    reports. A replica acknowledges the stream about once a second whatever
    it has actually applied, so `lag` reads 0 for one that is a gigabyte
    behind — under a rebuild, exactly when a stale answer would be served."""
    behind = 200 * 1024 * 1024
    conn = _Conn(info={
        "role": "master", "connected_slaves": 2,
        "master_repl_offset": behind,
        # Promptly acknowledged (lag 0) and hopelessly behind, both at once.
        "slave0": {"ip": "10.0.1.1", "port": "6379", "state": "online", "offset": 0, "lag": 0},
        "slave1": {"ip": "10.0.2.1", "port": "6379", "state": "online", "offset": 0, "lag": 0},
    })
    p = _provider(conn)
    assert _run(p._replica_for("g1")) is None


def test_one_replica_keeping_up_does_not_speak_for_its_sibling():
    """A verdict for the whole shard would hand the lagging replica the
    reads the healthy one qualified for."""
    conn = _Conn(info={
        "role": "master", "connected_slaves": 2,
        "master_repl_offset": 100 * 1024 * 1024,
        "slave0": {"ip": "10.0.1.1", "port": "6379", "state": "online",
                   "offset": 100 * 1024 * 1024, "lag": 0},
        "slave1": {"ip": "10.0.2.1", "port": "6379", "state": "online", "offset": 0, "lag": 0},
    })
    p = _provider(conn)
    for _ in range(6):
        assert str(_run(p._replica_for("g1"))) == "10.0.1.1:6379"


def test_a_replica_whose_offset_is_unknown_does_not_answer():
    """Nothing to measure means nothing to trust; the master answers."""
    conn = _Conn(info={
        "role": "master", "connected_slaves": 1,
        "slave0": {"ip": "10.0.1.1", "port": "6379", "state": "online", "lag": 0},
    })
    assert _run(_provider(conn)._replica_for("g1")) is None


def test_a_replica_that_is_not_online_does_not_answer():
    conn = _Conn(info={
        "role": "master", "connected_slaves": 1, "master_repl_offset": 0,
        "slave0": {"ip": "10.0.1.1", "port": "6379", "state": "wait_bgsave", "offset": 0, "lag": 0},
    })
    p = _provider(conn)
    assert _run(p._replica_for("g1")) is None


def test_a_shard_with_no_replicas_reads_from_its_master():
    p = _provider(_Conn(replicas=()))
    assert _run(p._replica_for("g1")) is None


def test_this_processs_own_writes_pin_the_graph_to_its_master():
    """A caller must always see what it just wrote. Reading a replica a
    second behind would show it the graph as it was before."""
    p = _provider(_Conn())
    assert _run(p._replica_for("g1")) is not None
    p._note_local_write()
    assert _run(p._replica_for("g1")) is None
    # …and the window ends on its own.
    p._wrote_at["g1"] = time.monotonic() - fp._REPLICA_READ_SETTLE_S - 1
    assert _run(p._replica_for("g1")) is not None
    assert fp._REPLICA_READ_SETTLE_S >= 10


def test_a_replica_that_failed_a_read_is_skipped_for_a_while():
    p = _provider(_Conn())
    p._penalise_replica(R1, ConnectionError("refused"))
    for _ in range(4):
        assert str(_run(p._replica_for("g1"))) == "10.0.2.1:6379"
    # Both penalised: back to the master.
    p._penalise_replica(R2, ConnectionError("refused"))
    assert _run(p._replica_for("g1")) is None
    assert fp._REPLICA_PENALTY_S >= 10


def test_replication_is_sampled_not_asked_per_read():
    """One INFO per shard per window answers for every read of every graph
    on it — otherwise the routing costs more than it saves."""
    conn = _Conn()
    p = _provider(conn)
    for _ in range(20):
        _run(p._replica_for("g1"))
    assert sum(1 for c in conn.calls if c[0] == "INFO") == 1


def test_a_write_pins_the_graph_it_actually_wrote():
    """The projection graph is its OWN key on its own shard in dedicated
    mode. Stamping the source key instead pins the one graph the write never
    touched and leaves the just-rewritten one free to be served by a replica
    that has not applied it — a half-built overlay that reads as a caching
    bug."""
    p = _provider(_Conn())
    p._projection_mode = "dedicated"
    p._proj_graph = _Graph(_Conn(), name="g1_proj")
    p._WRITE_TIMEOUT = 5.0
    p._write_semaphore = asyncio.Semaphore(1)
    p._query_semaphore = asyncio.Semaphore(1)
    p._check_quiesce_gate = lambda: None
    p._db_timeout_ms = lambda t: 1000
    p._record_write_latency = lambda s: None
    p._run_guarded = lambda call: call()

    _run(p._proj_query("CREATE ()"))
    assert p._in_settle_window("g1_proj")
    assert not p._in_settle_window("g1")

    # …and a write to the source graph pins the source graph.
    p._guarded_timed = lambda call, **kw: call()
    _run(p._query("CREATE ()"))
    assert p._in_settle_window("g1")


def test_only_a_fault_the_replica_caused_sends_the_read_to_the_master():
    """A query the store refused for its size fails the same way on the
    master. Re-running it there doubles the load the routing exists to shed,
    and benching the replica takes a healthy node out of rotation for
    something it had nothing to do with."""
    from redis.exceptions import ResponseError

    from backend.common.adapters import ProviderFailingOver

    refused = ResponseError("Query's mem consumption exceeded capacity")
    assert not fp._replica_at_fault(refused)
    assert not fp._replica_at_fault(ProviderFailingOver("p", "restarting"))
    assert not fp._replica_at_fault(asyncio.TimeoutError())
    # These the master genuinely answers.
    assert fp._replica_at_fault(ConnectionError("Error 111 connecting: Connection refused"))


def test_work_that_must_see_its_own_writes_pins_itself_to_the_master():
    p = _provider(_Conn())
    with fp.read_from_master_only():
        assert _run(p._replica_for("g1")) is None
    assert _run(p._replica_for("g1")) is not None


def test_the_rebuild_pins_every_read_it_makes():
    import inspect

    from backend.app.providers.falkordb_materialize import AggregationPipeline

    src = inspect.getsource(AggregationPipeline.run)
    assert "read_from_master_only" in src


# ── the plumbing ─────────────────────────────────────────────────────────


def test_a_pinned_graph_addresses_one_node_and_shares_everything_else():
    conn = _Conn()
    p = _provider(conn)
    pinned = p._pinned_to(p._graph, R1)
    assert pinned is not p._graph
    assert pinned.name == p._graph.name and pinned.client is p._graph.client
    _run(pinned.execute_command("GRAPH.RO_QUERY", "g1", "RETURN 1"))
    assert conn.calls[-1][2] is R1
    # The original is untouched: a write must never inherit a replica.
    _run(p._graph.execute_command("GRAPH.QUERY", "g1", "CREATE ()"))
    assert conn.calls[-1][2] is None


def test_the_cluster_client_does_the_readonly_handshake():
    """Without it a replica answers MOVED to every targeted read — the
    feature would silently fall back to the master on every request."""
    import inspect

    from backend.app.providers import falkordb_connection as fc

    src = inspect.getsource(fc.build_cluster_conn)
    assert "load_balancing_strategy" in src
    # And it must NOT be a routing change: no GRAPH command is in redis-py's
    # read table, so writes and untargeted reads still go to the primary.
    from redis.cluster import READ_COMMANDS
    assert not [c for c in READ_COMMANDS if "GRAPH" in c.upper()]


def test_the_provider_setting_defaults_to_auto_and_only_never_pins():
    from backend.app.providers.falkordb_connection import _read_from_replicas

    assert _read_from_replicas(None) == "auto"
    assert _read_from_replicas("auto") == "auto"
    assert _read_from_replicas("typo") == "auto"          # a typo must not pin a fleet
    for pinned in ("never", "NEVER", "master", "off", "false"):
        assert _read_from_replicas(pinned) == "never"


def test_the_counters_say_how_reads_were_served():
    p = _provider(_Conn())
    p._replica_reads, p._master_reads, p._replica_fallbacks = 7, 3, 1
    assert p.read_routing_counters() == {
        "replicaReads": 7, "masterReads": 3, "replicaFallbacks": 1,
    }
