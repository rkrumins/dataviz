"""Crash-recovery wiring contracts (F2 audit finding).

The lock-aware stuck-job reconciler (exec lock absent ⇒ auto-resume from
``last_cursor``) only ran in the monolith topology: the dedicated
control plane never started it, and workers ACK stream messages BEFORE
executing, so in the split topology a worker crash mid-job was caught
only by the scheduler's ~4h stale sweep — which marks jobs FAILED
instead of resuming them. These tests pin:

* the topology contract — both control-plane entrypoints start
  ``run_reconciler``;
* scheduler deference — with a Redis client the scheduler's mark-failed
  watchdog stands down entirely (the reconciler owns liveness; the
  worker's stall watchdog kills wedged-but-locked jobs), and without
  Redis the fallback sweep must never hijack purge rows (their progress
  is Redis-only, so every >4h purge looked "stale" here);
* the reconciler's cross-replica advisory lock.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend.app.services.aggregation import reconciler as recon_mod
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.aggregation.reap import WORKER_LOST
from backend.app.services.aggregation.scheduler import AggregationScheduler
from backend.app.services.aggregation.steps import StepLedger, failed_stage

_AGG_DIR = Path(__file__).resolve().parents[1] / "app" / "services" / "aggregation"
_APP_DIR = Path(__file__).resolve().parents[1] / "app"


# ── topology contract: every control-plane entrypoint runs the reconciler ──


def test_dedicated_controlplane_starts_reconciler():
    source = (_AGG_DIR / "controlplane.py").read_text()
    assert "run_reconciler(" in source, (
        "controlplane.py lifespan must start run_reconciler — without it "
        "the split topology has NO auto-resume and a dead worker's job "
        "stays 'running' until the scheduler's 4h sweep marks it failed"
    )


def test_monolith_starts_reconciler():
    source = (_APP_DIR / "main.py").read_text()
    assert "run_reconciler(" in source


# ── scheduler watchdog deference ────────────────────────────────────────


class _Result:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return self

    def all(self):
        return list(self._items)

    def __iter__(self):
        return iter(self._items)


class _State:
    """The source row ``trigger()`` left in flight. Only a worker ever moved
    it off, and this watchdog exists precisely for when there is no worker."""

    def __init__(self):
        self.data_source_id = "ds"
        self.aggregation_status = "running"
        self.last_aggregated_at = "2026-01-01T00:00:00+00:00"


class _Session:
    def __init__(self, results, state=None):
        self._results = list(results)
        self.statements = []
        self.committed = False
        self.state = _State() if state is None else state

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def execute(self, stmt):
        self.statements.append(stmt)
        return _Result(self._results.pop(0) if self._results else [])

    async def get(self, orm, key):
        # The aggregation-owned state row only; the public mirror is absent,
        # as in a split-DB topology.
        name = getattr(orm, "__name__", "")
        return self.state if name.endswith("StateORM") else None

    async def commit(self):
        self.committed = True


def _stale_job(trigger_source="manual"):
    old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    return AggregationJobORM(
        id="J", data_source_id="ds", status="running",
        trigger_source=trigger_source, updated_at=old,
        started_at=(datetime.now(timezone.utc) - timedelta(days=3)).isoformat(),
        run_stats=json.dumps({"steps": _mid_run_steps()}),
    )


def _mid_run_steps():
    """A ledger with APPLY still open — what a row looks like when its
    worker was killed rather than allowed to finish."""
    led = StepLedger()
    led.enter("preparing")
    led.enter("extracting")
    led.enter("applying")
    led.note(done=4, total=10, unit="aggregated edges")
    return led.snapshot()


def _run(coro):
    return asyncio.run(coro)


def test_watchdog_stands_down_when_reconciler_redis_present():
    job = _stale_job()
    session = _Session(results=[[job]])
    sched = AggregationScheduler(
        lambda: session, registry=None, redis_client=object(),
    )
    _run(sched._tick())
    assert job.status == "running", (
        "with a job-bus Redis the reconciler owns liveness — the "
        "scheduler must not mark progressing-but-slow jobs failed"
    )
    assert not session.committed


def test_watchdog_fallback_still_fails_stale_jobs_without_redis():
    job = _stale_job()
    session = _Session(results=[[job]])
    sched = AggregationScheduler(lambda: session, registry=None)
    _run(sched._tick())
    assert job.status == "failed"
    assert session.committed


def test_the_watchdog_reaps_rather_than_stamping():
    """It used to set ``status`` and the aggregation-owned status column and
    stop there, which left the ledger with a step still ``running`` — so the
    run reported NO failure stage anywhere — and left the viz-service's
    mirror of the source saying "running" forever."""
    job = _stale_job()
    session = _Session(results=[[job]])
    sched = AggregationScheduler(lambda: session, registry=None)
    _run(sched._tick())

    assert failed_stage(json.loads(job.run_stats)["steps"]) == "applying"
    assert session.state.aggregation_status == "failed"
    assert job.completed_at                      # a terminal row has an end
    assert job.error_message.startswith(WORKER_LOST)


def test_watchdog_fallback_excludes_purge_rows():
    session = _Session(results=[[]])
    sched = AggregationScheduler(lambda: session, registry=None)
    _run(sched._tick())
    stale_stmt = str(session.statements[0])
    assert "trigger_source !=" in stale_stmt, (
        "purge rows checkpoint via Redis only — the fallback sweep must "
        "exclude them or every >4h purge gets hijacked to failed"
    )


# ── reconciler cross-replica advisory lock ─────────────────────────────


class _LockDeniedSession(_Session):
    async def execute(self, stmt):
        self.statements.append(stmt)
        if "pg_try_advisory_xact_lock" in str(stmt):
            class _Scalar:
                def scalar(self):
                    return False
            return _Scalar()
        return _Result([])


def test_reconcile_once_yields_to_the_replica_holding_the_lock():
    session = _LockDeniedSession(results=[])
    n = _run(recon_mod._reconcile_once(lambda: session, None))
    assert n == 0
    assert len(session.statements) == 1, (
        "lock denied ⇒ another replica is sweeping — this one must do "
        "no further queries this tick"
    )
