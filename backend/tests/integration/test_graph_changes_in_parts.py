"""A draft save too large for one request, sent in parts, against Postgres: its ops (``POST
/graph/changes``'s, one a line) arrive as an upload in more than one part, and a ``save`` job writes
them as ONE commit — temp refs resolved across the parts, the answer the route gives kept for the
client. The same key never queues it twice nor writes it twice, the upload is never used again,
and a batch that can't be read fails the job saying why."""
import asyncio
import json
import os

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models


async def _upload(ie, uploads, *, gid, ds, owner, ops, part_bytes):
    data = b"".join(json.dumps(o).encode() + b"\n" for o in ops)
    record = await uploads.create(ie.store, workspace_id="ws1", data_source_id=ds, graph_id=gid, owner=owner,
                                  file_name="save.ndjson", size=len(data), fmt="ndjson", part_bytes=part_bytes)

    async def body():
        yield data
    await uploads.put_part(ie.store, record, 0, body())          # every part, cut as it arrives
    assert len(await uploads.received(ie.store, record)) == record["parts"]
    return record


async def _run(monkeypatch) -> None:
    from backend.app.api.v1.endpoints.versioning import (_save_from_job, get_import_export_service,
                                                          get_versioning_service)
    from backend.app.services.versioning.import_export import uploads

    await models.create_schema_and_partitions()
    svc, ie = get_versioning_service(), get_import_export_service()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="alice"))["graph_id"]
    draft = await svc.open_draft(graph_id=gid, owner="alice")

    # Two new nodes and an edge between them by their temp refs, across parts: the refs resolve
    # over the whole batch, and one commit holds them all.
    pad = "x" * 3000
    ops = [{"op": "create", "kind": "node", "ref": f"tmp-node-{i:04d}-aaaaaaaa",
            "payload": {"entityType": "Dataset", "displayName": f"Set {i}", "description": pad}}
           for i in range(1800)]
    ops.append({"op": "create", "kind": "edge", "ref": "tmp-edge-0001-aaaaaaaa",
                "payload": {"edgeType": "FEEDS", "sourceEntityId": "tmp-node-0000-aaaaaaaa",
                            "targetEntityId": "tmp-node-1799-aaaaaaaa"}})
    record = await _upload(ie, uploads, gid=gid, ds=ds, owner="alice", ops=ops, part_bytes=uploads.MIN_PART_BYTES)
    assert record["parts"] >= 2

    async def commits():
        async with db.graphver_session() as s:
            return await s.scalar(select(func.count()).select_from(models.CommitORM).where(
                models.CommitORM.graph_id == gid, models.CommitORM.branch_id == draft))
    before = await commits()
    job = await ie.create_save_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft,
                                   actor="alice", record=record, message="Big batch", key="key-big-batch-1")
    result = await ie.run_save(job["job_id"])
    assert "error" not in result, result
    assert await commits() == before + 1
    assigned = result["assigned"]
    assert {o["ref"] for o in ops} <= set(assigned) and result["commitId"]
    assert await ie.save_result(job["job_id"]) == result
    row = await ie.get_job(job["job_id"])
    assert row["status"] == "completed" and row["summary"]["ops"] == 1801

    # The same key: the same job, never queued again; the upload is bound to it.
    again = await ie.create_save_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft,
                                     actor="alice", record=record, message="Big batch", key="key-big-batch-1")
    assert again["job_id"] == job["job_id"]
    with pytest.raises(uploads.UploadError):
        await ie.create_save_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft,
                                 actor="alice", record={**record, "jobId": job["job_id"]}, message="x", key="key-other-1")
    # Written again under its key (a retry that lost the job's answer): the same commit, the same ids.
    replay = await _save_from_job({"graphId": gid, "branchId": draft, "actor": "alice", "key": "key-big-batch-1",
                                   "workspaceId": "ws1", "message": "Big batch"}, ops)
    assert replay["commitId"] == result["commitId"] and replay["assigned"] == assigned
    assert await commits() == before + 1

    # A batch that can't be read fails its job, saying why; nothing is written.
    bad = await uploads.create(ie.store, workspace_id="ws1", data_source_id=ds, graph_id=gid, owner="alice",
                               file_name="save.ndjson", size=9, fmt="ndjson")

    async def junk():
        yield b"{not json"
    await uploads.put_part(ie.store, bad, 0, junk())
    job2 = await ie.create_save_job(workspace_id="ws1", data_source_id=ds, graph_id=gid, branch_id=draft,
                                    actor="alice", record=bad, message=None, key="key-bad-batch-1")
    out = await ie.run_save(job2["job_id"])
    assert out["error"]["detail"]["type"] == "invalid_upload"
    assert (await ie.get_job(job2["job_id"]))["status"] == "failed"
    assert await commits() == before + 1
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_save_sent_in_parts_lands_as_one_commit(monkeypatch):
    asyncio.run(_run(monkeypatch))


async def _many_base_versions() -> None:
    from backend.app.api.v1.endpoints.versioning import get_versioning_service

    await models.create_schema_and_partitions()
    svc = get_versioning_service()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    n = 20_000
    await svc.bulk_ingest(graph_id=gid, actor="alice", rows=[
        {"kind": "node", "entity_id": f"N{i}", "urn": f"urn:N{i}", "entityType": "Dataset", "displayName": f"N{i}"}
        for i in range(n)])
    async with db.graphver_session() as s:
        tokens = dict((await s.execute(select(models.NodeVersionORM.entity_id, models.NodeVersionORM.content_hash)
                                       .where(models.NodeVersionORM.graph_id == gid))).all())
    draft = await svc.open_draft(graph_id=gid, owner="alice")
    # Each edit names the version it was made from: past ~16k of them, one statement used to bind
    # every id and every token, beyond Postgres's 32,767 parameters.
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": f"N{i}", "base_version": tokens[f"N{i}"],
         "payload": {"description": "reviewed"}} for i in range(n)])
    async with db.graphver_session() as s:
        heads = await s.scalar(select(func.count()).select_from(models.EntityHeadORM).where(
            models.EntityHeadORM.graph_id == gid, models.EntityHeadORM.branch_id == draft))
    assert heads == n
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_save_of_20k_edits_each_from_its_version_binds_within_postgres_limits():
    asyncio.run(_many_base_versions())
