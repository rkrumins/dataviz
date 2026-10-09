"""An import job never reads "running" after the work behind it has stopped for good.

Two ways it used to: the job's task was cancelled (``_run_safe`` caught only ``Exception``, and
``CancelledError`` is not one), or the pod running it went away. Now a cancelled or draining job
hands itself back (``Lease.release``, shielded) for another worker to resume; a superseded one stops
quietly; an error fails it, fenced; and ``get_job`` never writes — a job whose worker died reads
``stale`` until it is taken over (the claim's stale takeover, ``job_lease``), rather than being
failed by whoever happened to poll it.

The versioning store is faked at its session boundary, as in test_import_view_assignments.py.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import Draining, Lease, Superseded
from backend.app.services.versioning.models import JobORM


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


@contextlib.asynccontextmanager
async def _session_yielding(row, executed=None):
    class _S:
        async def get(self, _orm, _key):
            return row

        async def execute(self, stmt):
            executed.append(stmt)

    yield _S()


def _service():
    return ImportExportService(versioning=object(), store=object())


_SILENT = config.INGEST_STALE_SECS + 60


@pytest.mark.parametrize("job_type, status, silent, stale", [
    ("ingest", "running", {"updated_at": _SILENT}, True),            # its heartbeat stopped
    ("ingest", "running", {"updated_at": 5}, False),                 # still beating
    ("ingest", "pending", {}, False),                                # not started: no heartbeat due
    ("export", "running", {"started_at": _SILENT}, True),            # no heartbeat: by its start
    ("export", "running", {"started_at": 30}, False),
    ("ingest", "completed", {"updated_at": _SILENT}, False),         # a finished job is not stale
])
async def test_get_job_reports_a_quiet_job_stale_and_never_changes_it(monkeypatch, job_type, status,
                                                                     silent, stale):
    stamps = {column: _ago(secs) for column, secs in silent.items()}   # now, not at collection
    row = JobORM(id="vjob_1", job_type=job_type, graph_id="g1", status=status,
                 created_at=_ago(_SILENT), **stamps)
    executed = []
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row, executed))

    job = await _service().get_job("vjob_1")
    assert job["status"] == status and row.status == status, "a read never flips a job"
    assert job["stale"] is stale and row.error_message is None and row.completed_at is None
    assert not any(getattr(stmt, "is_update", False) for stmt in executed)


class _FakeLease(Lease):
    """A lease whose fenced writes are recorded instead of sent."""

    def __init__(self, *, fenced_out=False):
        super().__init__(job_id="vjob_1", job_type="ingest", epoch=1, workspace_id="ws1",
                         graph_id="g1")
        self.calls = []
        self._fenced_out = fenced_out

    async def release(self):
        self.calls.append(("release",))
        return not self._fenced_out

    async def fail(self, message, code="internal", action=None, phase=None):
        self.calls.append(("fail", message, code))
        return not self._fenced_out


async def _cancelled_while_running(svc, lease, run_import):
    svc.run_import = run_import
    task = asyncio.create_task(svc.run_import_safe("vjob_1", lease))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task                                  # the cancellation still propagates


async def test_a_cancelled_import_is_handed_back_for_another_worker():
    lease = _FakeLease()

    async def run_import(job_id, lease=None):
        await asyncio.sleep(3600)

    await _cancelled_while_running(_service(), lease, run_import)
    assert lease.calls == [("release",)]


async def test_a_cancellation_after_the_import_completed_leaves_it_completed():
    """The release is fenced on ``status='running'``: once the worker finished the job, a late
    cancellation (a post-commit step still running) changes nothing."""
    lease = _FakeLease(fenced_out=True)

    async def run_import(job_id, lease=None):
        await asyncio.sleep(3600)

    await _cancelled_while_running(_service(), lease, run_import)
    assert lease.calls == [("release",)]            # tried, and fenced out (returned False)


@pytest.mark.parametrize("raised, calls", [
    (Draining("stopping"), [("release",)]),                  # handed back at a boundary
    (Superseded("taken over"), []),                          # someone else's now: stop quietly
    (RuntimeError("bad row 7"), [("fail", "bad row 7", "internal")]),
])
async def test_how_a_run_ends_settles_its_lease(raised, calls):
    lease = _FakeLease()

    async def run_import(job_id, lease=None):
        raise raised

    svc = _service()
    svc.run_import = run_import
    await svc.run_import_safe("vjob_1", lease)               # none of them escapes
    assert lease.calls == calls

