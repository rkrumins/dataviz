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
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend.app.services.aggregation import reconciler as recon_mod
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.aggregation.scheduler import AggregationScheduler

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


class _Session:
    def __init__(self, results):
        self._results = list(results)
        self.statements = []
        self.committed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def execute(self, stmt):
        self.statements.append(stmt)
        return _Result(self._results.pop(0) if self._results else [])

    async def get(self, orm, key):
        return None

    async def commit(self):
        self.committed = True


def _stale_job(trigger_source="manual"):
    old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    return AggregationJobORM(
        id="J", data_source_id="ds", status="running",
        trigger_source=trigger_source, updated_at=old,
    )


def _run(coro):
    return asyncio.run(coro)


def test_watchdog_stands_down_when_reconciler_redis_present():
    job = _stale_job()
    session = _Session(results=[[], [job]])
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
    session = _Session(results=[[], [job]])
    sched = AggregationScheduler(lambda: session, registry=None)
    _run(sched._tick())
    assert job.status == "failed"
    assert session.committed


def test_watchdog_fallback_excludes_purge_rows():
    session = _Session(results=[[], []])
    sched = AggregationScheduler(lambda: session, registry=None)
    _run(sched._tick())
    stale_stmt = str(session.statements[1])
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
