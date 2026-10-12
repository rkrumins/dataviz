"""A graph store node that goes away mid-rebuild is a pause, not a failure.

What used to happen when a shard restarted under a large rebuild: the
refused connection was not "pressure", so it flew straight past the ladder;
the provider re-resolved the topology for 1.75 s while the cluster had not
even begun to fail over; the breaker wrapped it; the worker burned a retry
re-running EXTRACT from zero, then another, then fast-failed on an open
breaker — and the final error text was "Circuit open; will probe downstream
again in ~28s", which does not name the node that died.

Now the run waits for the node, reconnects to it (or to the replica
promoted in its place), and carries on at the same width from the same
checkpoint — and if it does give up, it says which node and for how long.
"""
from __future__ import annotations

import asyncio
import types

import pytest

import test_falkordb_materialize as base
from backend.app.providers import falkordb_materialize as mat


def _run(coro):
    return asyncio.run(coro)


REFUSED = ConnectionError("Error 111 connecting to 10.0.0.3:6379. Connection refused.")


class _Recovering:
    """A provider whose store is away for the first ``down`` attempts."""

    def __init__(self, down=2, *, run_ids=("run-a",), uptimes=(1000,)):
        self._graph_name = "g1"
        self.down = down
        self.reconnects = 0
        self.reads = 0
        self._run_ids = list(run_ids)
        self._uptimes = list(uptimes)

    def _endpoint_label(self):
        return "10.0.0.3:6379"

    async def reconnect_owner(self, graph_key=None):
        self.reconnects += 1
        return True

    def shard(self):
        self.reads += 1
        i = min(self.reads - 1, len(self._run_ids) - 1)
        return base._ShardMemory(
            "10.0.0.3:6379", 2 ** 30, 40 * 2 ** 30, "noeviction", 0.0, "measured",
            None, None, None, None, None, None,
            self._uptimes[min(i, len(self._uptimes) - 1)], self._run_ids[i], False,
        )


def _pipeline(provider, monkeypatch, *, sleeps=None):
    pipe = base._make_pipeline()
    pipe.p = provider

    async def _sleep(s):
        if sleeps is not None:
            sleeps.append(s)

    monkeypatch.setattr(mat.asyncio, "sleep", _sleep)

    async def _read_shard():
        return provider.shard()

    pipe._read_shard = _read_shard

    async def _beat():
        return None

    pipe._heartbeat = _beat
    return pipe


def test_a_refused_connection_is_waited_out_and_the_same_work_is_retried(monkeypatch):
    """No narrowing: a node that is restarting does not care how small the
    next query is, and shrinking would leave the run limping long after it
    recovered."""
    provider = _Recovering(down=2)
    sleeps = []
    pipe = _pipeline(provider, monkeypatch, sleeps=sleeps)
    calls = []

    async def _attempt():
        calls.append(len(calls))
        if len(calls) <= provider.down:
            raise REFUSED
        return "done"

    assert _run(pipe._through_outage(_attempt, op="reconcile")) == "done"
    assert len(calls) == 3                          # the same work, three times
    assert pipe._outage_holds == 2 and provider.reconnects == 2
    assert sleeps and all(s > 0 for s in sleeps)    # backoff, not a spin
    adapted = pipe._adapted_snapshot()
    assert adapted["store_outage_holds"] == 2
    assert any(e.get("kind") == "connection" for e in adapted.get("pressure", []))


def test_a_node_that_never_comes_back_names_itself_and_keeps_the_checkpoint(monkeypatch):
    provider = _Recovering(down=99)
    pipe = _pipeline(provider, monkeypatch)
    pipe._outage_hold_s = 0.0                        # the budget is already spent

    async def _attempt():
        raise REFUSED

    with pytest.raises(mat.MaterializationStoreUnreachable) as exc:
        _run(pipe._through_outage(_attempt, op="apply"))
    message = str(exc.value)
    assert "10.0.0.3:6379" in message                # the node, which the breaker text lost
    assert "keeps its checkpoint" in message and "Resume" in message
    assert "health probe" in message                 # where to look on the cluster

    from backend.app.services.aggregation.service import classify_failure
    assert classify_failure(message) == "provider_unavailable"


def test_a_restart_during_the_wait_is_recorded_as_evidence(monkeypatch):
    """A run id is regenerated on every start, so one that changed while the
    run was waiting proves the node restarted rather than being slow."""
    provider = _Recovering(down=1, run_ids=("run-before", "run-after", "run-after"),
                           uptimes=(9000, 12, 12))
    pipe = _pipeline(provider, monkeypatch)
    calls = []

    async def _attempt():
        calls.append(1)
        if len(calls) == 1:
            raise REFUSED
        return "ok"

    _run(pipe._through_outage(_attempt, op="reconcile"))
    restarts = pipe._adapted_snapshot()["node_restarts"]
    assert [r["endpoint"] for r in restarts] == ["10.0.0.3:6379"]
    assert restarts[0]["uptime_s"] == 12 and restarts[0]["at"]


def test_a_node_that_stayed_up_is_not_reported_as_restarted(monkeypatch):
    provider = _Recovering(down=1, run_ids=("run-a", "run-a"), uptimes=(9000, 9005))
    pipe = _pipeline(provider, monkeypatch)
    calls = []

    async def _attempt():
        calls.append(1)
        if len(calls) == 1:
            raise REFUSED
        return "ok"

    _run(pipe._through_outage(_attempt, op="reconcile"))
    assert "node_restarts" not in pipe._adapted_snapshot()


def test_pressure_still_narrows_and_is_not_confused_with_an_outage(monkeypatch):
    """The two must not be mixed up: a query the store REFUSES is narrowed,
    a store that is not there is waited for."""
    provider = _Recovering(down=0)
    pipe = _pipeline(provider, monkeypatch)

    async def _too_big():
        raise Exception("Query's mem consumption exceeded capacity")

    with pytest.raises(Exception, match="mem consumption"):
        _run(pipe._through_outage(_too_big, op="scan"))
    assert pipe._outage_holds == 0                   # not an outage: the ladder's job


def test_a_cancelled_job_stops_waiting(monkeypatch):
    from backend.app.services.aggregation.cancel import JobCancelled

    provider = _Recovering(down=99)
    pipe = _pipeline(provider, monkeypatch)
    pipe._should_cancel = lambda: True

    async def _attempt():
        raise REFUSED

    with pytest.raises(JobCancelled):
        _run(pipe._through_outage(_attempt, op="apply"))


def test_each_outage_gets_the_whole_budget(monkeypatch):
    """The budget is per outage, not per run. A rebuild that runs for hours
    meets several rolling restarts; timing the second one's wait from the
    first one's two-second blip would fail it instantly, having waited for
    nothing, and report a wait it never made."""
    provider = _Recovering(down=0)
    pipe = _pipeline(provider, monkeypatch)
    pipe._outage_hold_s = 60.0
    calls = []

    async def _attempt():
        calls.append(1)
        # Down for the 1st call, up for the 2nd, down again much later.
        if len(calls) in (1, 3):
            raise REFUSED
        return "ok"

    _run(pipe._through_outage(_attempt, op="extract"))     # first outage, ridden out
    assert pipe._outage_since is None                      # …and declared over

    # Hours pass, then the pod rotates again.
    _run(pipe._through_outage(_attempt, op="extract"))
    assert pipe._outage_holds == 2                         # both waits happened
    assert calls == [1, 1, 1, 1]                           # the second one waited too


def test_a_spent_budget_is_terminal_and_never_read_back_as_pressure(monkeypatch):
    """The message quotes the redis error so a failed run names the node —
    and classification is by text, so without the terminal marker the
    enclosing ladder reads it back as `connection` pressure, halves a page
    it cannot deliver to a node that is not there, and leaves the run
    limping at the floor width long after the node came back."""
    provider = _Recovering(down=99)
    pipe = _pipeline(provider, monkeypatch)
    pipe._outage_hold_s = 0.0

    async def _attempt():
        raise REFUSED

    with pytest.raises(mat.MaterializationStoreUnreachable) as exc:
        _run(pipe._through_outage(_attempt, op="apply"))
    assert "Connection refused" in str(exc.value)           # the text that fooled it
    assert mat._pressure_kind(exc.value) is None            # …and no longer does

    # The floor-width scan verdict is terminal for the same reason.
    assert mat._pressure_kind(mat.MaterializationScanTimedOut("timed out at width 1")) is None


def test_the_outage_budget_is_a_knob(monkeypatch):
    monkeypatch.setenv("AGGREGATION_STORE_OUTAGE_HOLD_S", "120")
    assert mat._store_outage_hold_s() == 120
    monkeypatch.setenv("AGGREGATION_STORE_OUTAGE_HOLD_S", "1")
    assert mat._store_outage_hold_s() == 30          # clamped to the floor


# ── the provider's own recovery window ───────────────────────────────────


def test_a_refusal_re_resolves_the_topology_from_the_first_retry():
    """A refusal PROVES the address is dead, so redialing it again is a
    wasted retry; a reset may be one bad socket, which the cheap redial
    absorbs."""
    from backend.app.providers import falkordb_provider as fp
    import inspect

    src = inspect.getsource(fp.FalkorDBProvider._run_guarded)
    assert "refused or attempt >= 2" in src
    assert "_REFUSED_RETRY_BACKOFFS" in src
    # And the window covers a cluster failover: the shipped manifests do not
    # begin one until cluster-node-timeout (5 s) has passed.
    assert sum(fp._REFUSED_RETRY_BACKOFFS) >= 15.0
    assert sum(fp._TRANSIENT_RETRY_BACKOFFS) < 2.0   # unchanged for a blip


def test_the_refusal_classifier_walks_the_cause_chain():
    from backend.app.providers.falkordb_provider import _is_connection_refused_error

    assert _is_connection_refused_error(ConnectionRefusedError())
    assert _is_connection_refused_error(REFUSED)
    wrapped = RuntimeError("wrapped")
    wrapped.__cause__ = REFUSED
    assert _is_connection_refused_error(wrapped)
    assert not _is_connection_refused_error(Exception("Query timed out"))


def test_the_worker_reports_an_unreachable_node_as_its_own_terminal_reason():
    import inspect

    from backend.app.services.aggregation.worker import AggregationWorker

    src = inspect.getsource(AggregationWorker.run)
    assert "except MaterializationStoreUnreachable as store_exc:" in src
    assert '"reason": "connection"' in src


def test_the_breaker_verdict_still_names_the_node_that_died():
    """By the third attempt the only text left was "Circuit open; will probe
    downstream again in ~28s" — which is what the operator saw, and it names
    no node. The reason that started it is carried forward instead."""
    from backend.app.services.aggregation.worker import _named_failure
    from backend.common.adapters import ProviderUnavailable

    breaker = ProviderUnavailable(
        "XYZ", "Circuit open; will probe downstream again in ~28s", 28,
    )
    named = _named_failure(breaker, str(REFUSED))
    assert named is not None
    assert "10.0.0.3:6379" in str(named)          # the node
    assert "Circuit open" in str(named)           # and why it stopped trying
    assert named.provider_name == "XYZ" and named.retry_after_seconds == 28

    from backend.app.services.aggregation.service import classify_failure
    assert classify_failure(str(named)) == "provider_unavailable"

    # Nothing to add: the verdict already says it, or there is no first failure.
    assert _named_failure(breaker, None) is None
    assert _named_failure(breaker, "   ") is None
    concrete = ProviderUnavailable("XYZ", str(REFUSED), 30)
    assert _named_failure(concrete, str(REFUSED)) is None


# ── a node replaying its dataset is worth waiting for, and only it ──────
#
# A rotated pod replays its AOF before it serves anything: minutes per GB,
# and docker-compose's own comment records a multi-GB incremental taking
# about an HOUR. Throughout, the node ACCEPTS connections and answers every
# data command with `-LOADING Redis is loading the dataset in memory`.
#
# `_pressure_kind` did not classify that at all, so `_through_outage`
# re-raised it instead of waiting: a rebuild that touched a rotating node
# died on the spot, having done everything right. It is the same situation
# the outage hold exists for — the node is not answering YET — so it is
# classified as a connection signal and waited out.
#
# The budget differs, deliberately. A node that is silent might never come
# back, so 15 minutes and then keep the checkpoint. A node that says it is
# loading is telling us it IS coming back, and roughly when, so it earns the
# longer wait. Guessing one number for both cases is what made the default
# too short for a replay and too long for a corpse.


def _loading_exc():
    from redis.exceptions import BusyLoadingError

    return BusyLoadingError("LOADING Redis is loading the dataset in memory")


def test_a_loading_reply_is_a_wait_not_a_failure():
    from backend.app.providers.falkordb_materialize import _pressure_kind

    assert _pressure_kind(_loading_exc()) == "connection", (
        "a node mid-replay flew past the outage hold and killed the run"
    )


def test_a_provider_loading_verdict_is_a_wait_too():
    """The provider converts the raw reply into ``ProviderLoading`` before
    the pipeline ever sees it, so that shape has to classify the same."""
    from backend.common.adapters import ProviderLoading
    from backend.app.providers.falkordb_materialize import _pressure_kind

    exc = ProviderLoading(
        provider_name="g1",
        reason="graph is starting up (loading dataset into memory)",
        retry_after_seconds=5,
    )
    assert _pressure_kind(exc) == "connection"


def test_a_silent_node_is_still_a_connection_signal():
    """Unchanged: the existing behaviour for a node that is simply gone."""
    from backend.app.providers.falkordb_materialize import _pressure_kind

    assert _pressure_kind(ConnectionError("Connection refused")) == "connection"


def test_a_replaying_node_gets_the_longer_budget():
    from backend.app.providers.falkordb_materialize import (
        _store_loading_hold_s, _store_outage_hold_s,
    )

    assert _store_loading_hold_s() > _store_outage_hold_s(), (
        "a node that says it is coming back must be waited for longer than "
        "one that says nothing"
    )
    assert _store_loading_hold_s() >= 3600, (
        "compose's own comment records a multi-GB AOF replay taking about an "
        "hour; a shorter budget fails a run that would have succeeded"
    )


def test_a_replaying_node_is_waited_out_past_the_plain_outage_budget(monkeypatch):
    """The budgets have to differ in the HOLD, not just in the constants."""
    import backend.app.providers.falkordb_materialize as mat

    pipe = object.__new__(mat.AggregationPipeline)
    pipe._outage_since = None
    pipe._outage_holds = pipe._outage_holds_now = pipe._outage_s = 0
    pipe._outage_hold_s = 10          # a corpse gets 10s
    pipe._loading_hold_s = 10_000     # a replay gets much longer
    pipe.p = types.SimpleNamespace(_graph_name="g1", reconnect_owner=None)
    pipe._last_budget = None
    pipe._on_pressure = lambda *a, **k: None
    pipe._cancel_check = lambda: None

    async def _noop(*a, **k):
        return None

    pipe._ladder_heartbeat = _noop
    pipe._note_node_identity = _noop
    monkeypatch.setattr(mat.asyncio, "sleep", _noop)

    # 30s into an outage, past the plain budget.
    pipe._outage_since = mat.time.monotonic() - 30

    # A node that is merely silent: give up, keep the checkpoint.
    with pytest.raises(mat.MaterializationStoreUnreachable):
        _run(pipe._hold_for_store(ConnectionError("refused"), "apply"))

    # The SAME elapsed time, but the node says it is replaying: keep waiting.
    pipe._outage_since = mat.time.monotonic() - 30
    _run(pipe._hold_for_store(_loading_exc(), "apply"))   # must not raise


def test_the_message_names_the_replay_and_the_knob(monkeypatch):
    """An operator reading a failed run needs to know the wait ran out on a
    REPLAY, and which knob buys more of it."""
    import backend.app.providers.falkordb_materialize as mat

    pipe = object.__new__(mat.AggregationPipeline)
    pipe._outage_since = mat.time.monotonic() - 10_000
    pipe._outage_holds = pipe._outage_holds_now = pipe._outage_s = 0
    pipe._outage_hold_s = 10
    pipe._loading_hold_s = 100
    pipe.p = types.SimpleNamespace(_graph_name="g1", reconnect_owner=None)
    pipe._last_budget = None
    pipe._on_pressure = lambda *a, **k: None
    pipe._cancel_check = lambda: None

    async def _noop(*a, **k):
        return None

    pipe._ladder_heartbeat = _noop
    pipe._note_node_identity = _noop

    with pytest.raises(mat.MaterializationStoreUnreachable) as exc:
        _run(pipe._hold_for_store(_loading_exc(), "apply"))
    msg = str(exc.value)
    assert "replaying" in msg
    assert "AGGREGATION_STORE_LOADING_HOLD_S" in msg


# ── what a total master outage reaches users as ─────────────────────────
#
# Measured against a real six-node Redis Cluster with every master killed
# at once. The surviving replicas hold the data, but a cluster with no
# master quorum cannot promote one, goes `cluster_state:fail`, and the
# cluster client then refuses every command — a targeted replica read
# included (ClusterDownError). That is Redis's own safety model, not
# something the router can route around.
#
# It is not an outage for users, and this pins why: both shapes that outage
# produces classify as connection pressure, the breaker proxy turns them
# into ProviderUnavailable, and graph_cache answers from the last known
# good snapshot with a stale banner. One master down is different and
# better — the cluster promotes a replica and reads carry on, verified
# against a live `CLUSTER FAILOVER`.


def test_a_total_master_outage_is_connection_pressure_not_a_hard_error():
    from redis.exceptions import ClusterDownError
    from backend.app.providers.falkordb_provider import _pressure_kind

    # Both shapes a real all-masters-down cluster produced.
    assert _pressure_kind(ClusterDownError("CLUSTERDOWN The cluster is down")) == "connection"
    assert _pressure_kind(
        ConnectionError("Error 111 connecting to node-7001.falkordb.local:7001")
    ) == "connection"


def test_the_read_path_still_answers_from_the_last_known_good():
    """The property that makes a total master outage survivable for a
    reader: it must not depend on any node being reachable."""
    import inspect

    from backend.app.services import graph_cache as gc

    src = inspect.getsource(gc.GraphCache.get_or_compute)
    assert "except (ProviderUnavailable, asyncio.TimeoutError)" in src
    assert "_get_lkg" in src


def test_a_dead_shard_names_the_node_that_died():
    """Measured: a read of a graph whose whole shard is gone raises a
    ConnectionError carrying the node, and the other shards keep serving —
    so the message has to name which one, or an operator is hunting."""
    from backend.app.providers.falkordb_provider import _refused_endpoint

    exc = ConnectionError(
        "Error 111 connecting to node-7002.falkordb.local:7002. "
        "Connect call failed ('127.0.0.1', 7002)."
    )
    assert _refused_endpoint(exc) == "node-7002.falkordb.local:7002"
