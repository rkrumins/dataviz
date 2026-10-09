"""Import, export and publish jobs on the versioning worker's transfer lane.

The API process only queues the jobs it creates — never runs them; the worker's slot loops run them
a few at a time on leases. ``get_job`` is read-only: a queued job says how many are ahead of it in
its slot, a running one how far it has got and whether its worker went quiet, and nothing a reader
does flips a job's status — the transfer lane's ``JobReaper`` fails the jobs nothing will run. A
stopping worker DRAINS: it tells its jobs to hand themselves back, and cancels (and so releases) the
rest. The job store is faked at its session boundary, as in test_import_job_liveness.py; the claim
itself is proven on Postgres in test_job_lease.py and integration/test_transfer_queue.py.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export.runner import (
    INSPECT_TYPES,
    JOB_TYPES,
    QUEUED,
    JobReaper,
    TransferRunner,
)
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import Lease
from backend.app.services.versioning.models import JobORM
from backend.app.services.versioning.worker import ProjectionWorker


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


class _Count:
    def __init__(self, n):
        self._n = n
        self.rowcount = n

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


def _lease(job_id="vjob_1", job_type="export") -> Lease:
    return Lease(job_id=job_id, job_type=job_type, epoch=1, workspace_id="ws1", graph_id="g1")


# ── Starting a job ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("start", ["start_import", "start_export", "start_publish"])
async def test_the_api_only_ever_queues_a_job(monkeypatch, start):
    executed = []
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(executed=executed))

    assert await getattr(_service(), start)("vjob_1") == "pending"
    (stmt,) = executed
    params = stmt.compile().params
    assert params["current_phase"] == QUEUED and params["updated_at"]
    # Only a job still pending is queued: one already failed or finished stays so.
    assert "vjob_1" in params.values() and "pending" in params.values()


# ── Reading a job never changes it ───────────────────────────────────────────


async def test_a_queued_job_waits_its_turn_and_says_how_many_are_ahead(monkeypatch):
    waited = config.TRANSFER_QUEUE_TIMEOUT_SECS + 60      # long past the queue timeout, even
    row = JobORM(id="vjob_1", job_type="export", graph_id="g1", status="pending",
                 current_phase=QUEUED, created_at=_ago(waited), updated_at=_ago(waited))
    executed = []
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(row, executed, ahead=3))

    job = await _service().get_job("vjob_1")
    assert job["status"] == "pending" and row.status == "pending", "the reaper fails it, not a GET"
    assert job["queuedAhead"] == 3 and job["phase"] == QUEUED
    (count,) = executed
    assert count.is_select, "the only statement is the queue count"
    assert set(count.compile().params["job_type_1"]) == set(JOB_TYPES)


async def test_an_inspection_counts_only_the_inspections_ahead_of_it(monkeypatch):
    row = JobORM(id="vjob_1", job_type="package_inspect", graph_id="g1", status="pending",
                 current_phase=QUEUED, created_at=_ago(5), updated_at=_ago(5))
    executed = []
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(row, executed, ahead=1))

    assert (await _service().get_job("vjob_1"))["queuedAhead"] == 1
    assert list(executed[0].compile().params["job_type_1"]) == list(INSPECT_TYPES)


async def test_a_running_job_reports_its_progress_and_attempt(monkeypatch):
    row = JobORM(id="vjob_1", job_type="ingest", graph_id="g1", status="running",
                 current_phase="node:20000", progress=40, processed=20000, total=50000,
                 retry_count=2, created_at=_ago(60), updated_at=_ago(5))
    executed = []
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(row, executed))

    job = await _service().get_job("vjob_1")
    assert job["status"] == "running" and job["queuedAhead"] is None
    assert (job["phase"], job["progress"], job["processed"], job["total"]) == (
        "node:20000", 40, 20000, 50000)
    assert job["attempt"] == 2 and job["stale"] is False
    assert executed == [], "no queue count for a job that isn't queued"


async def test_a_running_job_whose_worker_went_quiet_reads_stale_and_stays_running(monkeypatch):
    row = JobORM(id="vjob_1", job_type="ingest", graph_id="g1", status="running", retry_count=1,
                 created_at=_ago(3600), updated_at=_ago(config.INGEST_STALE_SECS + 30))
    monkeypatch.setattr(ver_db, "graphver_session", lambda: _session(row))

    job = await _service().get_job("vjob_1")
    assert job["status"] == "running" and job["stale"] is True
    assert row.status == "running" and row.error_message is None, "taken over, not failed"


# ── The job reaper ───────────────────────────────────────────────────────────


async def test_the_reaper_fails_jobs_queued_too_long_and_uploads_that_never_finished():
    executed = []

    @contextlib.asynccontextmanager
    async def session():
        async with _session(executed=executed, ahead=2) as s:
            yield s

    assert await JobReaper(session_factory=session).run_once() == {"timedOut": 2,
                                                                   "neverQueued": 2}
    timed_out, abandoned = (stmt.compile().params for stmt in executed)
    assert timed_out["status"] == "failed" and "No worker started the job" in timed_out["error_message"]
    assert timed_out["current_phase_1"] == QUEUED and timed_out["status_1"] == "pending"
    assert set(timed_out["job_type_1"]) == set(JOB_TYPES + INSPECT_TYPES)
    assert abandoned["status"] == "failed" and "upload never finished" in abandoned["error_message"]
    assert "current_phase IS NULL" in str(executed[1].compile())


# ── The worker's slot loop ───────────────────────────────────────────────────


class _Queue:
    """A TransferRunner stand-in: hands out leases on queued jobs and records how they ran. A job
    honours its lease's drain the way a windowed job does: at its next boundary (every 10 ms)."""

    def __init__(self, jobs, *, secs=0.05, honours_drain=True):
        self.queue = list(jobs)
        self.secs = secs
        self.honours_drain = honours_drain
        self.running = 0
        self.peak = 0
        self.done: list = []
        self.released: list = []
        self.cancelled: list = []

    async def claim_one(self):
        return _lease(self.queue.pop(0)) if self.queue else None

    async def run_job(self, lease):
        self.running += 1
        self.peak = max(self.peak, self.running)
        try:
            deadline = asyncio.get_running_loop().time() + self.secs
            while asyncio.get_running_loop().time() < deadline:
                if self.honours_drain and lease.drain.is_set():
                    self.released.append(lease.job_id)
                    return
                await asyncio.sleep(0.01)
            self.done.append(lease.job_id)
        except asyncio.CancelledError:
            self.cancelled.append(lease.job_id)
            raise
        finally:
            self.running -= 1


def _loop(worker, queue, slots=2):
    return asyncio.create_task(worker._slot_loop(queue, slots=slots, name="transfer",
                                                 poll_secs=0.01))


async def _until(check, timeout=5.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        assert asyncio.get_running_loop().time() < deadline, "timed out"
        await asyncio.sleep(0.01)


async def test_the_worker_runs_queued_jobs_a_few_at_a_time():
    queue = _Queue([f"vjob_{i}" for i in range(5)])
    worker = ProjectionWorker(object(), transfers=queue)
    loop = _loop(worker, queue)

    await _until(lambda: len(queue.done) == 5)
    worker.stop()
    await asyncio.wait_for(loop, 5)
    assert sorted(queue.done) == [f"vjob_{i}" for i in range(5)]
    assert queue.peak == 2, "never more than its slots at once"


async def test_a_stopping_worker_has_its_jobs_hand_themselves_back():
    queue = _Queue(["vjob_1"], secs=3600)
    worker = ProjectionWorker(object(), transfers=queue)
    loop = _loop(worker, queue)

    await _until(lambda: queue.running == 1)
    worker.stop()
    await asyncio.wait_for(loop, 5)
    assert queue.released == ["vjob_1"] and queue.cancelled == [] and queue.done == []


async def test_a_job_still_running_when_the_drain_ends_is_cancelled(monkeypatch):
    monkeypatch.setattr(config, "DRAIN_SECS", 0.05)
    queue = _Queue(["vjob_1"], secs=3600, honours_drain=False)
    worker = ProjectionWorker(object(), transfers=queue)
    loop = _loop(worker, queue)

    await _until(lambda: queue.running == 1)
    worker.stop()
    await asyncio.wait_for(loop, 5)
    # Cancelled, which releases its job under a shield in _run_safe (test_import_job_liveness.py).
    assert queue.cancelled == ["vjob_1"] and queue.done == []


@pytest.mark.parametrize("while_draining", [False, True])
async def test_a_cancelled_loop_cancels_its_jobs_so_they_release_now(monkeypatch, while_draining):
    """An in-process worker's shutdown cancels the loop rather than waiting out the drain."""
    monkeypatch.setattr(config, "DRAIN_SECS", 3600)
    queue = _Queue(["vjob_1"], secs=3600, honours_drain=False)
    worker = ProjectionWorker(object(), transfers=queue)
    loop = _loop(worker, queue)

    await _until(lambda: queue.running == 1)
    if while_draining:
        worker.stop()
        await asyncio.sleep(0.05)                          # in the drain's wait now
    loop.cancel()
    with pytest.raises(asyncio.CancelledError):
        await loop
    await _until(lambda: queue.cancelled == ["vjob_1"])


async def test_a_runner_not_on_the_lease_yet_still_runs_by_job_id():
    ran = []

    class _Legacy:
        def __init__(self):
            self.queue = ["boot_1", "boot_2"]

        async def claim_one(self):
            return self.queue.pop(0) if self.queue else None

        async def run_job(self, job_id):
            ran.append(job_id)

    worker = ProjectionWorker(object())
    runner = _Legacy()
    loop = asyncio.create_task(worker._slot_loop(runner, slots=1, name="bootstrap",
                                                 poll_secs=0.01))
    await _until(lambda: len(ran) == 2)
    worker.stop()
    await asyncio.wait_for(loop, 5)
    assert ran == ["boot_1", "boot_2"]


async def test_the_loop_outlives_a_failed_claim():
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
    loop = _loop(worker, queue)

    await _until(lambda: queue.done == ["vjob_1"])
    worker.stop()
    await asyncio.wait_for(loop, 5)


# ── The runner ───────────────────────────────────────────────────────────────


async def test_a_claimed_job_runs_through_the_services_safe_entry_point_with_its_lease():
    ran = []

    class _Service:
        async def run_import_safe(self, job_id, lease):
            ran.append(("import", job_id, lease.epoch))

        async def run_export_safe(self, job_id, lease):
            ran.append(("export", job_id, lease.epoch))

        async def run_publish_safe(self, job_id, lease):
            ran.append(("publish", job_id, lease.epoch))

    runner = TransferRunner(_Service)
    await runner.run_job(_lease("vjob_1", "ingest"))
    await runner.run_job(_lease("vjob_2", "export"))
    await runner.run_job(_lease("vjob_3", "publish"))
    assert ran == [("import", "vjob_1", 1), ("export", "vjob_2", 1), ("publish", "vjob_3", 1)]


async def test_a_job_of_a_type_the_runner_does_not_know_fails_rather_than_run_as_something_else():
    """Anything not an import used to run as an export."""
    failed = []

    class _Service:
        async def run_export_safe(self, job_id, lease):
            pytest.fail("ran as an export")

    lease = _lease("vjob_9", "bogus")

    async def fail(message, code="internal", action=None, phase=None):
        failed.append((lease.job_id, message))
        return True

    lease.fail = fail
    await TransferRunner(_Service).run_job(lease)
    assert failed == [("vjob_9", "this worker doesn't run 'bogus' jobs")]
