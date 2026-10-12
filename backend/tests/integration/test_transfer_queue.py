"""Import, export and publish jobs on the versioning worker's transfer lane (live Postgres).

The API only queues a job, and transfer runners claim it through ``job_lease.claim``. Proven here:
runners claiming at once never take the same job; a job is claimed only once its creator queued it,
oldest first within a workspace and fairly across workspaces; a queued job reports how many are
ahead of it in its own slot, and package inspections have a slot of their own; two runners on one
job — a zombie and its successor — never both land a write: the zombie's window rolls back and its
finish is a no-op, while the successor runs at the next epoch; a job whose worker keeps dying fails
as poison; an import staged before leases fails rather than resuming; the job reaper fails what no
worker will run; a real import, then an export of its draft, run to completion through the transfer
lane; and a worker stopped mid-job hands the job back for the next one to finish.
"""
import asyncio
import json
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import insert, select, update

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import config, db, job_lease, models
from backend.app.services.versioning.import_export import export_worker
from backend.app.services.versioning.import_export.runner import (
    INSPECT_TYPES,
    JOB_TYPES,
    QUEUED,
    JobReaper,
    TransferRunner,
)
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import INTERRUPTED, Superseded
from backend.app.services.versioning.models import ImportRowORM, JobORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.worker import ProjectionWorker


def _ago(secs: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


async def _clear_queue() -> None:
    """Leftovers of an earlier run would be claimed (or taken over) first."""
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.job_type.in_(JOB_TYPES + INSPECT_TYPES),
                                             JobORM.status.in_(("pending", "running")))
                        .values(status="failed", error_message="cleared by test_transfer_queue"))


async def _age(job_id: str, secs: float) -> None:
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.id == job_id).values(updated_at=_ago(secs)))


async def _row(job_id: str) -> JobORM:
    async with db.graphver_session() as s:
        return await s.get(JobORM, job_id)


async def _finished(ie, job_id, timeout=60.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        job = await ie.get_job(job_id)
        if job["status"] in ("completed", "failed", "cancelled"):
            return job
        assert asyncio.get_running_loop().time() < deadline, f"job {job_id} still {job['status']}"
        await asyncio.sleep(0.1)


def _export_jobs(ie, graph_id):
    async def export_job(ws="ws1"):
        return (await ie.create_export_job(workspace_id=ws, data_source_id="ds1",
                                           graph_id=graph_id, actor="u"))["job_id"]
    return export_job


async def _tidy(graph_id: str) -> None:
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.graph_id == graph_id,
                                             JobORM.status.in_(("pending", "running")))
                        .values(status="failed", error_message="test job"))


async def _claims() -> None:
    ie = ImportExportService(versioning=GraphVersioningService(), store=object())
    graph_id = "g_" + os.urandom(4).hex()
    export_job = _export_jobs(ie, graph_id)

    queued = [await export_job() for _ in range(3)]
    not_ready = await export_job()          # created, but its creator hasn't queued it yet
    for job_id in queued:
        assert await ie.start_export(job_id) == "pending"
    assert [(await ie.get_job(j))["queuedAhead"] for j in queued] == [0, 1, 2]

    # Two workers, four claims each, all at once: every queued job goes to exactly one of them.
    first, second = TransferRunner(lambda: ie), TransferRunner(lambda: ie)
    got = await asyncio.gather(*[r.claim_one() for r in (first, second) for _ in range(4)])
    claimed = [lease.job_id for lease in got if lease]
    assert sorted(claimed) == sorted(queued), got
    for job_id in queued:
        job = await ie.get_job(job_id)
        assert job["status"] == "running" and job["queuedAhead"] is None and job["attempt"] == 1
    assert (await ie.get_job(not_ready))["status"] == "pending", "never claimed before it is queued"

    # One worker takes the oldest first.
    older, newer = await export_job(), await export_job()
    await ie.start_export(newer)
    await ie.start_export(older)
    assert (await first.claim_one()).job_id == older
    assert (await first.claim_one()).job_id == newer
    assert await first.claim_one() is None
    await _tidy(graph_id)


async def _fair_claims() -> None:
    ie = ImportExportService(versioning=GraphVersioningService(), store=object())
    graph_id = "g_" + os.urandom(4).hex()
    export_job = _export_jobs(ie, graph_id)
    big = [await export_job("ws_big") for _ in range(3)]          # one tenant queues first...
    small = await export_job("ws_small")                          # ...another after it
    for job_id in big + [small]:
        await ie.start_export(job_id)
    runner = TransferRunner(lambda: ie)
    order = [(await runner.claim_one()).job_id for _ in range(3)]
    assert order == [big[0], small, big[1]], "the second tenant doesn't wait behind the first's"
    await _tidy(graph_id)


async def _a_zombie_and_its_successor() -> None:
    ie = ImportExportService(versioning=GraphVersioningService(), store=object())
    graph_id = "g_" + os.urandom(4).hex()
    job_id = await _export_jobs(ie, graph_id)()
    await ie.start_export(job_id)
    zombie_runner, successor_runner = TransferRunner(lambda: ie), TransferRunner(lambda: ie)

    zombie = await zombie_runner.claim_one()
    await _age(job_id, config.INGEST_STALE_SECS + 5)   # its worker stalled past the takeover window
    job = await ie.get_job(job_id)
    assert job["status"] == "running" and job["stale"] is True, "a GET reports it, and changes nothing"
    successor = await successor_runner.claim_one()
    assert successor.job_id == job_id and successor.epoch == zombie.epoch + 1

    with pytest.raises(Superseded):
        async with db.graphver_session() as s:          # the zombie's window, ending in its checkpoint
            await s.execute(insert(ImportRowORM.__table__), [
                {"job_id": job_id, "row_index": 0, "kind": "node", "raw": {"urn": "urn:zombie"}}])
            await zombie.checkpoint(s, processed=1)
    async with db.graphver_session() as s:
        assert (await s.execute(select(ImportRowORM).where(ImportRowORM.job_id == job_id))).all() == []
    assert await zombie.finish("completed") is False
    assert await successor.finish("completed", summary={"nodes": 0}) is True
    job = await ie.get_job(job_id)
    assert (job["status"], job["attempt"], job["summary"]) == ("completed", 2, {"nodes": 0})


async def _jobs_that_must_not_run_again() -> None:
    ie = ImportExportService(versioning=GraphVersioningService(), store=object())
    graph_id = "g_" + os.urandom(4).hex()
    export_job = _export_jobs(ie, graph_id)
    runner = TransferRunner(lambda: ie)

    poison = await export_job()                         # its worker died on it three times already
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.id == poison).values(
            status="running", retry_count=4, summary={"takeovers": 3},
            updated_at=_ago(config.INGEST_STALE_SECS + 5)))
    legacy = (await ie.create_import_job(workspace_id="ws1", data_source_id="ds1", graph_id=graph_id,
                                         actor="u", import_format="ndjson", branch_id="br_x"))["job_id"]
    async with db.graphver_session() as s:              # staged by a worker from before leases
        await s.execute(insert(ImportRowORM.__table__), [
            {"job_id": legacy, "row_index": 0, "kind": "node", "raw": {"urn": "urn:old"}}])
        await s.execute(update(JobORM).where(JobORM.id == legacy).values(
            status="running", updated_at=_ago(config.INGEST_STALE_SECS + 5)))

    assert await runner.claim_one() is None, "neither is taken over"
    job = await ie.get_job(poison)
    assert job["status"] == "failed" and "stopped 4 times" in job["errorMessage"]
    assert job["summary"]["failure"]["action"] == "resume"
    job = await ie.get_job(legacy)
    assert (job["status"], job["errorMessage"]) == ("failed", INTERRUPTED)


async def _the_inspect_slot() -> None:
    ie = ImportExportService(versioning=GraphVersioningService(), store=object())
    graph_id = "g_" + os.urandom(4).hex()
    export = await _export_jobs(ie, graph_id)()
    await ie.start_export(export)
    async with db.graphver_session() as s:
        inspect = JobORM(job_type="package_inspect", graph_id=graph_id, workspace_id="ws1",
                         status="pending", current_phase=QUEUED, updated_at=_ago(0))
        s.add(inspect)
        await s.flush()
        inspect_id = inspect.id
    assert (await ie.get_job(inspect_id))["queuedAhead"] == 0, "it waits only behind inspections"

    general, inspector = TransferRunner(lambda: ie), TransferRunner(lambda: ie, types=INSPECT_TYPES)
    assert (await general.claim_one()).job_id == export
    assert await general.claim_one() is None, "the general slots never take an inspection"
    lease = await inspector.claim_one()
    assert (lease.job_id, lease.job_type) == (inspect_id, "package_inspect")
    await _tidy(graph_id)


async def _the_reaper() -> None:
    ie = ImportExportService(versioning=GraphVersioningService(), store=object())
    graph_id = "g_" + os.urandom(4).hex()
    export_job = _export_jobs(ie, graph_id)
    timed_out, waiting, never_queued = await export_job(), await export_job(), await export_job()
    for job_id in (timed_out, waiting):
        await ie.start_export(job_id)
    await _age(timed_out, config.TRANSFER_QUEUE_TIMEOUT_SECS + 60)
    async with db.graphver_session() as s:
        await s.execute(update(JobORM).where(JobORM.id == never_queued)
                        .values(created_at=_ago(2 * 3600)))

    tally = await JobReaper().run_once()
    assert tally["timedOut"] >= 1 and tally["neverQueued"] >= 1
    assert "No worker started the job" in (await ie.get_job(timed_out))["errorMessage"]
    assert "upload never finished" in (await ie.get_job(never_queued))["errorMessage"]
    assert (await ie.get_job(waiting))["status"] == "pending"
    await _tidy(graph_id)


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

        worker = ProjectionWorker(object(), lanes={"transfer"},
                                  transfers=TransferRunner(lambda: ie))
        loop = asyncio.create_task(worker.run())
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

            # Running, an export says how far it has got: a CSV reads every record for its columns,
            # then again to write them. Its own summary replaces that when it finishes.
            put = store.put_stream

            async def slow_put(key, chunks):
                async def slowly():
                    async for chunk in chunks:
                        await asyncio.sleep(0.2)
                        yield chunk
                return await put(key, slowly())

            store.put_stream = slow_put
            csv = await ie.create_export_job(workspace_id="ws1", data_source_id=G["graph_id"], graph_id=gid,
                                             actor="u", export_format="csv", branch_id=created["branch_id"])
            await ie.start_export(csv["job_id"])
            seen = []
            while (job := await ie.get_job(csv["job_id"]))["status"] not in ("completed", "failed", "cancelled"):
                if job["status"] == "running" and job["summary"]:
                    seen.append(job["summary"])
                await asyncio.sleep(0.05)
            assert job["status"] == "completed", job
            assert seen and seen[-1]["passes"] == 2 and seen[-1]["edges"] == 1, seen
            assert 0 < seen[-1]["bytes"] <= job["summary"]["bytes"], (seen, job["summary"])
            assert job["summary"] == {"nodes": 2, "edges": 1, "bytes": job["summary"]["bytes"]}

            # Stopped mid-job, a worker hands the job back (it doesn't fail it), and the next
            # worker finishes it at the next attempt.
            store.put_stream = slow_put
            again = await ie.create_export_job(workspace_id="ws1", data_source_id=G["graph_id"],
                                               graph_id=gid, actor="u", export_format="csv",
                                               branch_id=created["branch_id"])
            await ie.start_export(again["job_id"])
            while (await ie.get_job(again["job_id"]))["status"] != "running":
                await asyncio.sleep(0.02)
            worker.stop()
            await asyncio.wait_for(loop, 60)
            job = await ie.get_job(again["job_id"])
            assert (job["status"], job["phase"], job["attempt"]) == ("pending", QUEUED, 1), job
            store.put_stream = put
            worker = ProjectionWorker(object(), lanes={"transfer"},
                                      transfers=TransferRunner(lambda: ie))
            loop = asyncio.create_task(worker.run())
            job = await _finished(ie, again["job_id"])
            assert (job["status"], job["attempt"]) == ("completed", 2), job
        finally:
            worker.stop()
            await asyncio.wait_for(loop, 60)
    finally:
        shutil.rmtree(root, ignore_errors=True)


async def _run() -> None:
    await models.create_schema_and_partitions()
    await _clear_queue()
    await _claims()
    await _fair_claims()
    await _a_zombie_and_its_successor()
    await _jobs_that_must_not_run_again()
    await _the_inspect_slot()
    await _the_reaper()
    await _clear_queue()
    await _through_the_worker()
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_transfer_queue_e2e(monkeypatch):
    monkeypatch.setattr(config, "TRANSFER_POLL_SECS", 0.05)
    monkeypatch.setattr(config, "DRAIN_SECS", 0.1)
    monkeypatch.setattr(export_worker, "_PROGRESS_SECS", 0.05)
    assert job_lease.running_keeper() is None
    asyncio.run(_run())
