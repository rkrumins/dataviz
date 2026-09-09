"""Replication backpressure: the rebuild goes at the replicas' pace.

The failure this prevents is specific and was reproducible: a rebuild of a
densely connected graph wrote batches as fast as the master accepted them,
every replica RE-RAN each batch on its main thread (FalkorDB replicates a
write below EFFECTS_THRESHOLD by re-running it, with no timeout), the
replicas stopped answering their health probes, Kubernetes restarted the
pods, and the run died with a refused connection to that shard.

So the pipeline now asks the node how many replicas have acknowledged the
writes so far, and holds when they are behind. These tests pin both halves:
the provider primitives that ask the RIGHT node, and the gate that turns
the answer into pacing rather than into a failure.
"""
from __future__ import annotations

import asyncio
import time
import types

import pytest

import test_falkordb_materialize as base
from backend.app.providers import falkordb_materialize as mat
from backend.app.providers.falkordb_provider import FalkorDBProvider


def _run(coro):
    return asyncio.run(coro)


# ── the provider primitives ──────────────────────────────────────────────


class _Node:
    def __init__(self, name="10.0.0.1:6379"):
        self.host, self.port = name.rpartition(":")[0], int(name.rpartition(":")[2])


class _Conn:
    """A cluster connection that records what was asked of which node."""

    def __init__(self, *, info=None, wait=2, fail=None):
        self.calls = []
        self._info = info or {}
        self._wait = wait
        self._fail = fail
        self.nodes_manager = types.SimpleNamespace(
            slots_cache={0: [_Node()]},
            get_node_from_slot=lambda slot: _Node(),
        )

    def keyslot(self, key):
        return 0

    async def initialize(self):
        return None

    async def execute_command(self, command, *args, target_nodes=None):
        self.calls.append((command, args, target_nodes))
        if self._fail is not None:
            raise self._fail
        if command == "INFO":
            return self._info
        if command == "WAIT":
            return self._wait
        raise AssertionError(command)

    async def info(self, *sections):
        self.calls.append(("INFO", sections, None))
        return self._info


def _provider(conn, *, mode="cluster", projection="in_source"):
    p = object.__new__(FalkorDBProvider)
    p._graph_name = "g1"
    p._projection_mode = projection
    p._db = types.SimpleNamespace(connection=conn)
    p._proj_db = types.SimpleNamespace(connection=conn)
    p._conn_cfg = types.SimpleNamespace(mode=mode)
    return p


_MASTER_INFO = {
    "role": "master", "connected_slaves": 2, "master_repl_offset": 5000,
    "slave0": {"ip": "10.0.0.4", "port": "6379", "state": "online",
               "offset": 4000, "lag": 0},
    "slave1": {"ip": "10.0.0.5", "port": "6379", "state": "online",
               "offset": 5000, "lag": 0},
}


def test_replication_state_asks_the_node_that_owns_the_rollup_graph():
    conn = _Conn(info=_MASTER_INFO)
    state = _run(_provider(conn).replication_state())
    assert state["connectedReplicas"] == 2
    assert [r["lagBytes"] for r in state["replicas"]] == [1000, 0]
    command, args, target = conn.calls[0]
    assert command == "INFO" and args[0] == "replication"
    assert target is not None                      # routed to the owner, not "a" node


def test_the_projection_graph_is_the_node_that_matters_in_dedicated_mode():
    """Rollups land on the projection graph, which hashes independently —
    waiting on the source graph's replicas would pace against the wrong
    node entirely."""
    p = _provider(_Conn(info=_MASTER_INFO), projection="dedicated")
    assert p._rollup_graph_key() == "g1_proj"
    assert _provider(_Conn(info=_MASTER_INFO))._rollup_graph_key() == "g1"


def test_wait_for_replicas_returns_how_many_acknowledged():
    conn = _Conn(wait=2)
    assert _run(_provider(conn).wait_for_replicas(min_replicas=2, timeout_ms=1500)) == 2
    command, args, target = conn.calls[-1]
    assert command == "WAIT" and args == (2, 1500) and target is not None


def test_both_primitives_fail_open_rather_than_break_a_run():
    """A governor that can fail a rebuild is worse than no governor."""
    broken = _Conn(fail=ConnectionError("Error 111 connecting. Connection refused."))
    assert _run(_provider(broken).replication_state()) == {}
    assert _run(_provider(broken).wait_for_replicas()) is None
    # No client at all (a provider that never connected).
    p = _provider(None)
    p._db = types.SimpleNamespace(connection=None)
    p._proj_db = None
    assert _run(p.replication_state()) == {}
    assert _run(p.wait_for_replicas()) is None


def test_outside_cluster_mode_the_only_node_is_asked_directly():
    conn = _Conn(info=_MASTER_INFO)
    state = _run(_provider(conn, mode="standalone").replication_state())
    assert state["connectedReplicas"] == 2
    assert conn.calls[0][2] is None                 # no target_nodes on a single node


# ── the gate ─────────────────────────────────────────────────────────────


class _GateProvider:
    """A provider stand-in whose replication answers the test scripts."""

    def __init__(self, *, replicas=2, acks=(2,), lag=0):
        self._graph_name = "g1"
        self.acks = list(acks)
        self.replicas = replicas
        self.lag = lag
        self.waits = []
        self.state_reads = 0

    def _endpoint_label(self):
        return "10.0.0.1:6379"

    async def replication_state(self, *a, **kw):
        self.state_reads += 1
        return {
            "role": "master", "connectedReplicas": self.replicas,
            "replicas": [{"endpoint": "10.0.0.4:6379", "state": "online",
                          "lagBytes": self.lag}] if self.replicas else [],
        }

    async def wait_for_replicas(self, *, min_replicas=1, timeout_ms=5000):
        self.waits.append((min_replicas, timeout_ms))
        return self.acks.pop(0) if self.acks else min_replicas


def _pipeline(provider, **live):
    pipe = base._make_pipeline()
    pipe.p = provider
    pipe._live.update(live)
    return pipe


async def _noop_write():
    return "ok"


def test_a_write_waits_for_the_replicas_and_the_wait_counts_as_its_duration(monkeypatch):
    """The wait folds into the write's own time, so the batch sizer and the
    pacing sleep both treat a replica-bound shard as the slow write path it
    is — smaller batches, more room between them."""
    provider = _GateProvider(acks=[1])
    pipe = _pipeline(provider)
    elapsed, result = _run(pipe._paced_write(_noop_write))
    assert result == "ok"
    assert provider.waits == [(1, 5000)]
    assert pipe._replica_waits == 1 and pipe._replica_holds == 0
    adapted = pipe._adapted_snapshot()
    assert adapted["replica_waits"] == 1 and "replica_holds" not in adapted


def test_a_node_with_no_replicas_never_waits():
    """WAIT against a node with no replicas blocks for the full timeout —
    every batch would pay it. The gate asks the node first."""
    provider = _GateProvider(replicas=0)
    pipe = _pipeline(provider)
    _run(pipe._paced_write(_noop_write))
    assert provider.waits == []
    assert pipe._replica_waits == 0
    assert "replica_waits" not in pipe._adapted_snapshot()


def test_the_gate_never_waits_for_more_replicas_than_exist():
    """A fleet default of 2 against a one-replica shard must not hold on
    every batch forever."""
    provider = _GateProvider(replicas=1, acks=[1])
    pipe = _pipeline(_GateProvider(replicas=1, acks=[1]), replica_ack_min=2)
    pipe.p = provider
    pipe._live["replica_ack_min"] = 2
    _run(pipe._paced_write(_noop_write))
    assert provider.waits == [(1, 5000)]


def test_replicas_that_are_behind_hold_the_run_then_let_it_through(monkeypatch):
    """The hold heartbeats and re-reads the replication state instead of
    failing — and the run's record says it happened."""
    sleeps = []

    async def _sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)
    provider = _GateProvider(acks=[0, 0, 1], lag=200 * 1024 ** 2)
    pipe = _pipeline(provider)
    beats = {"n": 0}

    async def _beat():
        beats["n"] += 1

    pipe._heartbeat = _beat
    pipe._last_hb_mono = 0.0

    _run(pipe._paced_write(_noop_write))

    assert len(provider.waits) == 3                  # the first, then two in the hold
    assert pipe._replica_holds == 1 and pipe._replica_waits == 1
    assert pipe._replica_max_lag_bytes == 200 * 1024 ** 2
    assert beats["n"] >= 1 and sleeps                # heartbeat + backoff, not a spin
    assert provider.state_reads >= 2                 # re-read while waiting
    adapted = pipe._adapted_snapshot()
    assert adapted["replica_holds"] == 1
    assert adapted["replica_max_lag_bytes"] == 200 * 1024 ** 2


def test_lowering_the_bar_on_the_running_job_releases_a_hold(monkeypatch):
    """The operator's escape hatch: replicaAckMin 0 ends the wait at once,
    without cancelling the job."""
    async def _sleep(s):
        # The moment the run is asleep in the hold, the operator lowers it.
        pipe._live["replica_ack_min"] = 0

    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)
    provider = _GateProvider(acks=[0, 0, 0, 0, 0])
    pipe = _pipeline(provider)
    pipe._heartbeat = _noop_write
    _run(pipe._paced_write(_noop_write))
    assert pipe._replica_holds == 1
    assert len(provider.waits) <= 2                  # released, not looping


def test_a_store_that_cannot_answer_wait_lets_the_write_through():
    class _Mute(_GateProvider):
        async def wait_for_replicas(self, **kw):
            return None

    pipe = _pipeline(_Mute())
    _run(pipe._paced_write(_noop_write))
    assert pipe._replica_waits == 0 and pipe._replica_holds == 0


def test_the_replication_state_is_read_at_most_once_a_minute(monkeypatch):
    """One INFO a minute, not one per batch: the gate's own cost must not
    be what slows a rebuild."""
    provider = _GateProvider()
    pipe = _pipeline(provider)
    for _ in range(5):
        _run(pipe._paced_write(_noop_write))
    assert provider.state_reads == 1
    assert len(provider.waits) == 5


def test_the_knobs_resolve_like_every_other_and_are_live(monkeypatch):
    monkeypatch.setenv("AGGREGATION_REPLICA_ACK_MIN", "2")
    monkeypatch.setenv("AGGREGATION_REPLICA_ACK_TIMEOUT_MS", "1500")
    values, sources = mat.resolve_effective_tuning({"replica_ack_min": 9}, None)
    assert (values["replica_ack_min"], sources["replica_ack_min"]) == (5, "job")
    values, sources = mat.resolve_effective_tuning(None, None)
    assert (values["replica_ack_min"], sources["replica_ack_min"]) == (2, "env")
    assert values["replica_ack_timeout_ms"] == 1500
    env = mat.env_tuning_defaults()
    assert env["replica_ack_min"] == 2 and env["replica_ack_timeout_ms"] == 1500

    pipe = base._make_pipeline()
    assert pipe._live_replica_ack_min() == 2
    pipe._live["replica_ack_min"] = 0
    assert pipe._live_replica_ack_min() == 0
    pipe._live["replica_ack_min"] = "two"                     # junk falls back
    assert pipe._live_replica_ack_min() == 2


def test_a_run_whose_replicas_re_run_every_write_says_so(monkeypatch):
    """The one setting that makes this whole problem go away is named in
    the run's advisories, with where to change it."""
    fake = base._FakeFalkor()
    levels = base._seed_two_chain_graph(fake)
    p = base._make_provider(fake, levels)

    async def _state(*a, **kw):
        return {"role": "master", "connectedReplicas": 2, "replicas": []}

    async def _wait(**kw):
        return kw.get("min_replicas", 1)

    p.replication_state = _state
    p.wait_for_replicas = _wait

    async def _shard(db, *, mode, graph_key, timeout):
        # A node that replicates writes by RE-RUNNING them on its replicas.
        return base._ShardMemory(
            "10.0.0.1:6379", 2 ** 30, 40 * 2 ** 30, "noeviction", 0.0, "measured",
            None, None, None, None, None, 300,
        )

    monkeypatch.setattr(mat, "read_shard_memory", _shard)

    result = _run(base._materialize(p))

    advisories = result["run_stats"].get("advisories") or []
    effects = [a for a in advisories if a.get("kind") == "effects_threshold"]
    assert effects, advisories
    assert effects[0]["effects_threshold_us"] == 300
    assert effects[0]["replicas"] == 2
    assert "change log" in effects[0]["detail"]
    assert "Graph store" in effects[0]["detail"]
