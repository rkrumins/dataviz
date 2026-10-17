"""An import survives its worker being killed and stopped mid-job (live Postgres, real processes).

Real versioning workers (``python -m backend.app.services.versioning``, transfer lane only) run one
queued import, a window of five rows at a time:

1. the first is killed (SIGKILL) during the node windows: the job stays ``running`` at its cursor
   — nothing fails it — and once its lease has gone stale the next worker takes it over, at the
   next attempt, from that cursor;
2. that one is stopped (SIGTERM) during the edge windows: it hands the job back at a window
   boundary — ``pending``, queued again, its cursor kept — and exits;
3. the third finishes it.

The draft it leaves is the one an import that never stopped makes: the same entities, none twice,
the same tallies; and every file row was staged exactly once.
"""
import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import pytest
from sqlalchemy import func, select, update

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export.import_worker import ImportWorker
from backend.app.services.versioning.import_export.runner import INSPECT_TYPES, JOB_TYPES, QUEUED
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import ImportRowORM, JobORM
from backend.app.services.versioning.service import GraphVersioningService

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_NODES = 400
# Rows a window, how long a lease may go unrenewed before another worker takes the job over, and how
# often a worker renews its leases: a takeover within seconds, not minutes.
_WINDOW, _STALE_SECS, _RENEW_SECS = 5, 4, 1

_LINES = [
    *({"kind": "node", "urn": f"urn:n{i}", "entityType": "Table", "displayName": f"n{i}",
       "qualifiedName": f"q.n{i}"} for i in range(_NODES)),
    *({"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": f"urn:n{i}", "targetUrn": f"urn:n{i + 1}"}
      for i in range(_NODES - 1)),
    {"kind": "edge", "edgeType": "LINEAGE", "sourceUrn": "urn:nowhere", "targetUrn": "urn:n0"},
]


class _Worker:
    """A versioning worker process on the transfer lane, logging to a file of its own."""

    def __init__(self, root: str, n: int) -> None:
        env = {**os.environ, "PYTHONPATH": _REPO, "GRAPHVER_WORKER_LANES": "transfer",
               "OBJECT_STORE_BACKEND": "local", "IMPORT_STORE_ROOT": root,
               "IMPORT_COMMIT_WINDOW": str(_WINDOW), "GRAPHVER_INGEST_STALE_SECS": str(_STALE_SECS),
               "GRAPHVER_INGEST_HEARTBEAT_SECS": str(_RENEW_SECS), "GRAPHVER_TRANSFER_POLL_SECS": "0.2",
               "GRAPHVER_DRAIN_SECS": "30", "LOG_LEVEL": "INFO"}
        self.log = os.path.join(root, f"worker-{n}.log")
        with open(self.log, "wb") as out:
            self.proc = subprocess.Popen([sys.executable, "-m", "backend.app.services.versioning"],
                                         cwd=_REPO, env=env, stdout=out, stderr=subprocess.STDOUT)

    def tail(self) -> str:
        with open(self.log, errors="replace") as f:
            return "".join(f.readlines()[-40:])

    async def ended(self, timeout: float) -> int:
        deadline = time.monotonic() + timeout
        while self.proc.poll() is None:
            assert time.monotonic() < deadline, f"worker still running:\n{self.tail()}"
            await asyncio.sleep(0.1)
        return self.proc.returncode


async def _row(job_id: str) -> JobORM:
    async with db.graphver_session() as s:
        return await s.get(JobORM, job_id)


async def _until(job_id: str, ready, worker: _Worker, timeout: float = 120.0) -> JobORM:
    """Poll the job's row until ``ready(row)``."""
    deadline = time.monotonic() + timeout
    while True:
        row = await _row(job_id)
        if ready(row):
            return row
        assert row.status not in ("completed", "failed"), (row.status, row.error_message, worker.tail())
        assert worker.proc.poll() is None or time.monotonic() < deadline, worker.tail()
        assert time.monotonic() < deadline, f"job at {row.status}/{row.last_cursor}:\n{worker.tail()}"
        await asyncio.sleep(0.02)


def _past(kind: str, row_index: int):
    def ready(row) -> bool:
        k, _, at = (row.last_cursor or "").partition(":")
        return row.status == "running" and k == kind and int(at) >= row_index
    return ready


async def _state(svc, gid, branch_id):
    state = await svc.materialize_state(graph_id=gid, branch_id=branch_id)
    urn = {eid: p.get("urn") for eid, p in state["nodes"].items()}
    return (len(state["nodes"]), len(state["edges"]),
            sorted(p.get("urn") for p in state["nodes"].values()),
            sorted((urn.get(p["sourceEntityId"]), urn.get(p["targetEntityId"])) for p in state["edges"].values()))


async def _run(root: str) -> None:
    await models.create_schema_and_partitions()
    async with db.graphver_session() as s:      # what an earlier run left queued: not this test's to run
        await s.execute(update(JobORM).where(JobORM.job_type.in_(JOB_TYPES + INSPECT_TYPES),
                                             JobORM.status.in_(("pending", "running")))
                        .values(status="failed", error_message="cleared by test_import_resume_e2e"))
    svc = GraphVersioningService()
    store = LocalFsObjectStore(root)
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="u"))["graph_id"]
    key = storage_key("ws1", gid, "upload", "source.ndjson")

    async def body():
        yield ("\n".join(json.dumps(line) for line in _LINES) + "\n").encode()
    await store.put_stream(key, body())
    ie = ImportExportService(versioning=svc, store=store)

    async def import_job():
        return await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                          actor="u", import_format="ndjson", source_uri=key)

    reference = await import_job()                         # an import that never stops
    want_summary = await ImportWorker(svc, store).run(reference["job_id"])
    assert want_summary == {"new": 2 * _NODES - 1, "updated": 0, "unchanged": 0, "deleted": 0,
                            "invalid": 1}, want_summary
    want = await _state(svc, gid, reference["branch_id"])

    job = await import_job()
    job_id = job["job_id"]
    assert await ie.start_import(job_id) == "pending"
    workers = []
    try:
        # 1. Killed during the node windows: the job stays running where it got to.
        workers.append(first := _Worker(root, 1))
        await _until(job_id, _past("node", _NODES // 4), first)
        first.proc.send_signal(signal.SIGKILL)
        assert await first.ended(30) == -signal.SIGKILL
        killed = await _row(job_id)
        assert (killed.status, killed.retry_count) == ("running", 1), killed.__dict__
        assert (await ie.get_job(job_id))["status"] == "running", "nothing fails a job whose worker died"

        # 2. Taken over once its lease went stale, from its cursor; stopped during the edge windows.
        workers.append(second := _Worker(root, 2))
        taken = await _until(job_id, lambda row: row.retry_count == 2, second)
        assert taken.last_cursor.startswith("node:")
        assert int(taken.last_cursor.partition(":")[2]) >= int(killed.last_cursor.partition(":")[2]), \
            "resumed from its cursor, not from the start"
        await _until(job_id, _past("edge", _NODES // 4), second)
        second.proc.send_signal(signal.SIGTERM)
        assert await second.ended(60) == 0, second.tail()
        released = await _row(job_id)
        assert (released.status, released.current_phase, released.retry_count) == ("pending", QUEUED, 2), \
            released.__dict__
        assert released.last_cursor.startswith("edge:"), "handed back with its cursor"

        # 3. The next worker finishes it.
        workers.append(third := _Worker(root, 3))
        done = await _until(job_id, lambda row: row.status == "completed", third)
        assert (done.retry_count, done.progress, done.processed) == (3, 100, len(_LINES)), done.__dict__
        assert {k: done.summary[k] for k in want_summary} == want_summary, done.summary
        assert await _state(svc, gid, job["branch_id"]) == want
        async with db.graphver_session() as s:
            staged = (await s.execute(select(func.count()).where(ImportRowORM.job_id == job_id))).scalar_one()
        assert staged == len(_LINES), "every row staged once"
        third.proc.send_signal(signal.SIGTERM)
        assert await third.ended(60) == 0, third.tail()
    finally:
        for worker in workers:
            if worker.proc.poll() is None:
                worker.proc.kill()
                worker.proc.wait()
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_an_import_survives_its_worker_being_killed_and_stopped():
    root = tempfile.mkdtemp(prefix="import-resume-e2e-")
    try:
        asyncio.run(_run(root))
    finally:
        shutil.rmtree(root, ignore_errors=True)
