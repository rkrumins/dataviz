"""Import and export jobs on the versioning worker (``GRAPHVER_TRANSFER_INPROCESS`` off).

The API process only queues the jobs it creates; the worker's transfer loop runs them a few at a
time. ``get_job`` lets a queued job wait its turn, with how many are ahead of it, rather than read
it as abandoned. The job store is faked at its session boundary, as in test_import_job_liveness.py;
the claim itself (``FOR UPDATE SKIP LOCKED``) is proven on Postgres in
integration/test_transfer_queue.py.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning import worker as worker_mod
from backend.app.services.versioning.import_export import service as service_mod
from backend.app.services.versioning.import_export.runner import QUEUED, TransferRunner
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import JobORM
from backend.app.services.versioning.worker import ProjectionWorker


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


class _Count:
    def __init__(self, n):
        self._n = n

    def scalar_one(self):
        return self._n


@contextlib.asynccontextmanager
async def _session(row=None, executed=None, ahead=0):
    class _S:
        async def get(self, _orm, _key):
            return row

        async def execute(self, stmt):
            if executed is not None:
                executed.append(stmt)
            return _Count(ahead)

    yield _S()


def _service():
    return ImportExportService(versioning=object(), store=object())


# ── Starting a job ───────────────────────────────────────────────────────────


async def test_by_default_a_job_runs_in_the_api_process(monkeypatch):
    monkeypatch.setattr(config, "TRANSFER_INPROCESS", True)
    spawned = []

    def spawn(coro, *, name):
        coro.close()
        spawned.append(name)

    monkeypatch.setattr(service_mod, "spawn_detached", spawn)
    svc = _service()
    assert await svc.start_import("vjob_1") == "running"
    assert await svc.start_export("vjob_2") == "running"
    assert spawned == ["import vjob_1", "export vjob_2"]


async def test_with_the_switch_off_the_api_only_queues_the_job(monkeypatch):
    monkeypatch.setattr(config, "TRANSFER_INPROCESS", False)
    monkeypatch.setattr(service_mod, "spawn_detached",
                        lambda *a, **k: pytest.fail("the job ran in the API process"))
    executed = []
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(executed=executed))

    assert await _service().start_import("vjob_1") == "pending"
    (stmt,) = executed
    params = stmt.compile().params
    assert params["current_phase"] == QUEUED and params["updated_at"]
    # Only a job still pending is queued: one already failed or finished stays so.
    assert "vjob_1" in params.values() and "pending" in params.values()


# ── A queued job waits its turn ──────────────────────────────────────────────


_WAITED = config.JOB_STALE_AFTER_SECS + 60


async def test_a_queued_job_waits_its_turn_and_says_how_many_are_ahead(monkeypatch):
    row = JobORM(id="vjob_1", job_type="export", graph_id="g1", status="pending",
                 current_phase=QUEUED, created_at=_ago(_WAITED), updated_at=_ago(_WAITED))
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(row, ahead=3))

    job = await _service().get_job("vjob_1")
    # Silent longer than a running job may be, but a queued job isn't abandoned: it's waiting.
    assert job["status"] == "pending" and row.status == "pending"
    assert job["queuedAhead"] == 3


async def test_a_job_no_worker_starts_in_time_reads_failed(monkeypatch):
    waited = config.TRANSFER_QUEUE_TIMEOUT_SECS + 60
    row = JobORM(id="vjob_1", job_type="ingest", graph_id="g1", status="pending",
                 current_phase=QUEUED, created_at=_ago(waited), updated_at=_ago(waited))
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(row))

    job = await _service().get_job("vjob_1")
    assert job["status"] == "failed" and row.status == "failed" and row.completed_at
    assert "No worker started the job" in job["errorMessage"]
    assert job["queuedAhead"] is None


async def test_a_job_that_is_not_queued_says_nothing_about_a_queue(monkeypatch):
    row = JobORM(id="vjob_1", job_type="ingest", graph_id="g1", status="running",
                 created_at=_ago(5), updated_at=_ago(5))
    executed = []
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(row, executed=executed))

    job = await _service().get_job("vjob_1")
    assert job["status"] == "running" and job["queuedAhead"] is None
    assert executed == [], "no queue count for a job that isn't queued"


# ── The worker's transfer loop ───────────────────────────────────────────────


class _Queue:
    """A TransferRunner stand-in: hands out queued jobs and records how they ran."""

    def __init__(self, jobs, *, secs=0.05):
        self.queue = list(jobs)
        self.secs = secs
        self.running = 0
        self.peak = 0
        self.done: list = []
        self.cancelled: list = []

    async def claim_one(self):
        return (self.queue.pop(0), "export") if self.queue else None

    async def run_job(self, job_id, job_type):
        self.running += 1
        self.peak = max(self.peak, self.running)
        try:
            await asyncio.sleep(self.secs)
            self.done.append(job_id)
        except asyncio.CancelledError:
            self.cancelled.append(job_id)
            raise
        finally:
            self.running -= 1


@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(config, "TRANSFER_SLOTS", 2)
    monkeypatch.setattr(config, "TRANSFER_POLL_SECS", 0.01)


async def _until(check, timeout=5.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        assert asyncio.get_running_loop().time() < deadline, "timed out"
        await asyncio.sleep(0.01)


async def test_the_worker_runs_queued_jobs_a_few_at_a_time(quick):
    queue = _Queue([f"vjob_{i}" for i in range(5)])
    worker = ProjectionWorker(object(), transfers=queue)
    loop = asyncio.create_task(worker._transfer_loop())

    await _until(lambda: len(queue.done) == 5)
    worker.stop()
    await asyncio.wait_for(loop, 5)
    assert sorted(queue.done) == [f"vjob_{i}" for i in range(5)]
    assert queue.peak == 2, "never more than TRANSFER_SLOTS at once"


async def test_a_stopping_worker_lets_its_jobs_finish(quick):
    queue = _Queue(["vjob_1"], secs=0.2)
    worker = ProjectionWorker(object(), transfers=queue)
    loop = asyncio.create_task(worker._transfer_loop())

    await _until(lambda: queue.running == 1)
    worker.stop()
    await asyncio.wait_for(loop, 5)
    assert queue.done == ["vjob_1"] and queue.cancelled == []


async def test_a_job_still_running_when_the_drain_ends_is_cancelled(quick, monkeypatch):
    monkeypatch.setattr(worker_mod, "_TRANSFER_DRAIN_SECS", 0.05)
    queue = _Queue(["vjob_1"], secs=3600)
    worker = ProjectionWorker(object(), transfers=queue)
    loop = asyncio.create_task(worker._transfer_loop())

    await _until(lambda: queue.running == 1)
    worker.stop()
    await asyncio.wait_for(loop, 5)
    # Cancelled, which is what marks its job failed ("start it again") in run_*_safe.
    assert queue.cancelled == ["vjob_1"] and queue.done == []


async def test_the_loop_outlives_a_failed_claim(quick):
    queue = _Queue(["vjob_1"])
    claims = {"n": 0}
    claim = queue.claim_one

    async def flaky():
        claims["n"] += 1
        if claims["n"] == 1:
            raise RuntimeError("the database went away for a moment")
        return await claim()

    queue.claim_one = flaky
    worker = ProjectionWorker(object(), transfers=queue)
    loop = asyncio.create_task(worker._transfer_loop())

    await _until(lambda: queue.done == ["vjob_1"])
    worker.stop()
    await asyncio.wait_for(loop, 5)


async def test_a_claimed_job_runs_through_the_services_safe_entry_point():
    ran = []

    class _Service:
        async def run_import_safe(self, job_id):
            ran.append(("import", job_id))

        async def run_export_safe(self, job_id):
            ran.append(("export", job_id))

    runner = TransferRunner(_Service)
    await runner.run_job("vjob_1", "ingest")
    await runner.run_job("vjob_2", "export")
    assert ran == [("import", "vjob_1"), ("export", "vjob_2")]
