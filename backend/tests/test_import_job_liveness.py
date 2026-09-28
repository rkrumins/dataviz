"""An import job never reads "running" after the work behind it has stopped.

Two ways it used to: the job's task was cancelled (``_run_safe`` caught only ``Exception``, and
``CancelledError`` is not one), or the pod running it went away. A cancelled job is now marked
failed on its way out; a running import touches ``updated_at`` on a timer; and ``get_job`` reports
a pending/running job silent for ``JOB_STALE_AFTER_SECS`` as failed, so the UI stops polling.

The versioning store is faked at its session boundary, as in test_import_view_assignments.py.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export.import_worker import ImportWorker
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import JobORM

_STOPPED = "The job stopped before it finished (the server restarted or it was interrupted). Start it again."


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


_SILENT = config.JOB_STALE_AFTER_SECS + 60


@pytest.mark.parametrize("job_type, status, stamps, reported", [
    ("ingest", "running", {"updated_at": _ago(_SILENT)}, "failed"),      # its heartbeat stopped
    ("ingest", "running", {"updated_at": _ago(5)}, "running"),           # still beating
    ("ingest", "pending", {}, "failed"),                                 # never started: by creation
    ("export", "running", {"started_at": _ago(_SILENT)}, "failed"),      # no heartbeat: by its start
    ("export", "running", {"started_at": _ago(30)}, "running"),
    ("ingest", "completed", {"updated_at": _ago(_SILENT)}, "completed"),  # a finished job stays so
    ("bootstrap", "running", {"updated_at": _ago(_SILENT)}, "running"),  # not this service's job
])
async def test_get_job_reports_a_job_whose_server_went_away(monkeypatch, job_type, status, stamps, reported):
    row = JobORM(id="vjob_1", job_type=job_type, graph_id="g1", status=status,
                 created_at=_ago(_SILENT), **stamps)
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row))

    job = await _service().get_job("vjob_1")
    assert job["status"] == reported and row.status == reported, "recorded on the job, not only reported"
    if reported == "failed":
        assert job["errorMessage"] == _STOPPED and row.completed_at


async def test_a_cancelled_import_is_marked_failed(monkeypatch):
    row = JobORM(id="vjob_1", job_type="ingest", graph_id="g1", status="running", created_at=_ago(1))
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row))
    started = asyncio.Event()

    async def run_import(job_id):
        started.set()
        await asyncio.sleep(3600)

    svc = _service()
    monkeypatch.setattr(svc, "run_import", run_import)
    task = asyncio.create_task(svc.run_import_safe("vjob_1"))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task                                  # the cancellation still propagates
    assert (row.status, row.error_message) == ("failed", _STOPPED) and row.completed_at


async def test_a_cancellation_after_the_import_completed_leaves_it_completed(monkeypatch):
    row = JobORM(id="vjob_1", job_type="ingest", graph_id="g1", status="running", created_at=_ago(1))
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row))

    async def run_import(job_id):
        row.status = "completed"                    # the worker finished; a post-commit step is running
        await asyncio.sleep(3600)

    svc = _service()
    monkeypatch.setattr(svc, "run_import", run_import)
    task = asyncio.create_task(svc.run_import_safe("vjob_1"))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert row.status == "completed" and row.error_message is None


async def test_a_running_import_beats_until_it_ends(monkeypatch):
    executed = []
    row = SimpleNamespace(status="running", completed_at=None, updated_at=None, summary=None, processed=0)
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session_yielding(row, executed))
    monkeypatch.setattr(import_worker, "_HEARTBEAT_SECS", 0.01)

    async def load(job_id):
        return {"graph_id": "g1", "branch_id": "b1", "source_uri": "k", "import_format": "ndjson",
                "reconcile_mode": "upsert"}

    async def owner(graph_id, branch_id):
        return "usr_1"

    async def parse(job_id, source_uri, fmt):
        await asyncio.sleep(0.1)                    # a long phase with no batch boundary

    async def build(*args):
        return {"new": 1}

    worker = ImportWorker(versioning=None, store=None)
    for name, fake in (("_load_running", load), ("_branch_owner", owner), ("_parse", parse),
                       ("_resolve_and_build", build)):
        monkeypatch.setattr(worker, name, fake)

    assert await worker.run("vjob_1") == {"new": 1}
    beats = [s for s in executed if s.is_update and s.table.name == "jobs"]
    assert len(beats) >= 3, "updated_at was touched while the import worked"
    assert row.status == "completed"
    await asyncio.sleep(0.05)
    assert len(executed) == len(beats), "and the heartbeat stopped with it"
