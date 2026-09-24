"""Import and export jobs queued for the versioning worker (live Postgres).

With ``GRAPHVER_TRANSFER_INPROCESS`` off the API only queues a job, and workers claim it with
``FOR UPDATE SKIP LOCKED``. Proven here: workers claiming at once never take the same job; a job is
claimed only once its creator queued it (its inputs stored), oldest first; a queued job reports how
many are ahead of it; and a real import, then an export of its draft, queued this way, run to
completion through the worker's transfer loop.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest
from sqlalchemy import update

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.import_export.runner import QUEUED, TransferRunner
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import JobORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.worker import ProjectionWorker


async def _clear_queue() -> None:
    """Leftovers of an earlier run would be claimed first: the queue is oldest first."""
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.status == "pending", JobORM.current_phase == QUEUED)
                        .values(status="failed", error_message="cleared by test_transfer_queue"))


async def _finished(ie, job_id, timeout=60.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        job = await ie.get_job(job_id)
        if job["status"] in ("completed", "failed", "cancelled"):
            return job
        assert asyncio.get_running_loop().time() < deadline, f"job {job_id} still {job['status']}"
        await asyncio.sleep(0.1)


async def _claims() -> None:
    ie = ImportExportService(versioning=GraphVersioningService(), store=object())
    graph_id = "g_" + os.urandom(4).hex()

    async def export_job():
        return (await ie.create_export_job(workspace_id="ws1", data_source_id="ds1",
                                           graph_id=graph_id, actor="u"))["job_id"]

    queued = [await export_job() for _ in range(3)]
    not_ready = await export_job()          # created, but its creator hasn't queued it yet
    for job_id in queued:
        assert await ie.start_export(job_id) == "pending"
    assert [(await ie.get_job(j))["queuedAhead"] for j in queued] == [0, 1, 2]

    # Two workers, four claims each, all at once: every queued job goes to exactly one of them.
    first, second = TransferRunner(lambda: ie), TransferRunner(lambda: ie)
    got = await asyncio.gather(*[r.claim_one() for r in (first, second) for _ in range(4)])
    claimed = [c[0] for c in got if c]
    assert sorted(claimed) == sorted(queued), got
    for job_id in queued:
        job = await ie.get_job(job_id)
        assert job["status"] == "running" and job["queuedAhead"] is None
    assert (await ie.get_job(not_ready))["status"] == "pending", "never claimed before it is queued"

    # One worker takes the oldest first.
    older, newer = await export_job(), await export_job()
    await ie.start_export(newer)
    await ie.start_export(older)
    assert (await first.claim_one())[0] == older
    assert (await first.claim_one())[0] == newer
    assert await first.claim_one() is None

    async with db.graphver_session() as s:          # tidy: these jobs never ran
        await s.execute(update(JobORM).where(JobORM.graph_id == graph_id)
                        .values(status="failed", error_message="test job"))


async def _through_the_worker() -> None:
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    root = tempfile.mkdtemp(prefix="transfer-queue-")
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)
        created = await ie.create_import_job(workspace_id="ws1", data_source_id=G["graph_id"], graph_id=gid,
                                             actor="u", import_format="ndjson")
        lines = [
            {"kind": "node", "urn": "urn:A", "entityType": "Table", "displayName": "A", "qualifiedName": "a"},
            {"kind": "node", "urn": "urn:B", "entityType": "Table", "displayName": "B", "qualifiedName": "b"},
            {"kind": "edge", "edgeType": "LINEAGE", "sourceQualifiedName": "a", "targetQualifiedName": "b"},
        ]

        async def body():
            yield ("\n".join(json.dumps(x) for x in lines) + "\n").encode()

        await store.put_stream(created["source_uri"], body())
        assert await ie.start_import(created["job_id"]) == "pending"
        assert (await ie.get_job(created["job_id"]))["queuedAhead"] == 0

        worker = ProjectionWorker(object(), transfers=TransferRunner(lambda: ie))
        loop = asyncio.create_task(worker._transfer_loop())
        try:
            job = await _finished(ie, created["job_id"])
            assert job["status"] == "completed", job
            assert job["summary"]["new"] == 3, job["summary"]

            export = await ie.create_export_job(workspace_id="ws1", data_source_id=G["graph_id"], graph_id=gid,
                                                actor="u", branch_id=created["branch_id"])
            assert await ie.start_export(export["job_id"]) == "pending"
            job = await _finished(ie, export["job_id"])
            assert job["status"] == "completed", job
            assert (job["summary"]["nodes"], job["summary"]["edges"]) == (2, 1), job["summary"]
            text = b"".join([c async for c in store.open_stream(export["result_uri"])]).decode()
            assert "urn:A" in text and "urn:B" in text
        finally:
            worker.stop()
            await asyncio.wait_for(loop, 60)
    finally:
        shutil.rmtree(root, ignore_errors=True)


async def _run() -> None:
    await models.create_schema_and_partitions()
    await _clear_queue()
    await _claims()
    await _through_the_worker()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_transfer_queue_e2e(monkeypatch):
    monkeypatch.setattr(config, "TRANSFER_INPROCESS", False)
    monkeypatch.setattr(config, "TRANSFER_POLL_SECS", 0.05)
    asyncio.run(_run())
