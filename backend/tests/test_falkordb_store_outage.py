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
