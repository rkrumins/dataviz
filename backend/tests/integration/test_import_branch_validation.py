"""An import names the draft it lands on, and that draft is checked when the job is created — needs
Postgres.

* main, by its id or as ``'main'``: 409 ``main_write_forbidden``. An import only ever fills a draft;
* a draft of another graph, or no branch at all: 404, as an unknown branch;
* a merged or abandoned draft: 409 ``branch_closed``;
* none of these leaves a job behind.

A job created on an open draft that is published before the job runs — the create read the draft
before the publish committed, so the publish did not see the job — fails at its first window, and
nothing lands on the merged draft (regression guard: each window's ``apply_ops`` checks the draft).
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, update

from backend.app.api.v1.endpoints.versioning import _domain_errors
from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key
from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export.import_worker import lease_job
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import CommitORM, JobORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _node(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": "Table", "displayName": eid}}


async def _graph(svc):
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[_node("N")])
    return gid


async def _draft(svc, gid, eid):
    d = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", message="edit", ops=[_node(eid)])
    return d


def _create(ie, gid, branch_id, **kw):
    return ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                import_format="ndjson", branch_id=branch_id, **kw)


async def _refused(ie, gid, branch_id) -> HTTPException:
    """The route's answer to an import onto ``branch_id``; the job is never created."""
    with pytest.raises(HTTPException) as exc:
        with _domain_errors():
            await _create(ie, gid, branch_id)
    async with db.graphver_session() as s:
        assert await s.scalar(select(func.count()).select_from(JobORM).where(JobORM.graph_id == gid)) == 0
    return exc.value


def _e2e(coro_fn):
    async def run():
        await models.create_schema_and_partitions()
        try:
            await coro_fn(GraphVersioningService())
        finally:
            await db.dispose_engine()
    asyncio.run(run())


async def _main(svc):
    gid = await _graph(svc)
    ie = ImportExportService(versioning=svc, store=object())
    for bid in (await svc.main_branch_id(gid), "main"):
        exc = await _refused(ie, gid, bid)
        assert (exc.status_code, exc.detail["type"]) == (409, "main_write_forbidden"), (bid, exc.detail)


async def _unknown(svc):
    gid, other = await _graph(svc), await _graph(svc)
    ie = ImportExportService(versioning=svc, store=object())
    for bid in (await _draft(svc, other, "X"), "br_" + os.urandom(4).hex()):
        exc = await _refused(ie, gid, bid)
        assert (exc.status_code, exc.detail) == (404, "unknown branch"), (bid, exc.detail)


async def _closed(svc):
    gid = await _graph(svc)
    ie = ImportExportService(versioning=svc, store=object())
    merged = await _draft(svc, gid, "M")
    await svc.publish(graph_id=gid, branch_id=merged, actor="u", message="ship")
    abandoned = await _draft(svc, gid, "A")
    await svc.abandon_draft(graph_id=gid, branch_id=abandoned, actor="u")
    for bid, status in ((merged, "merged"), (abandoned, "abandoned")):
        exc = await _refused(ie, gid, bid)
        assert exc.status_code == 409 and exc.detail == {
            "type": "branch_closed", "status": status, "branchId": bid,
            "message": f"branch {bid} is {status}"}, exc.detail


async def _published_before_it_runs(svc):
    gid = await _graph(svc)
    root = tempfile.mkdtemp()
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)
        draft = await _draft(svc, gid, "D")
        key = storage_key("ws1", gid, os.urandom(4).hex(), "source.ndjson")

        async def body():
            yield (json.dumps({"kind": "node", "urn": "urn:I", "entityType": "Table",
                               "displayName": "I", "qualifiedName": "i"}) + "\n").encode()

        await store.put_stream(key, body())
        job_id = (await _create(ie, gid, draft, source_uri=key))["job_id"]
        await ie.start_import(job_id)
        async with db.graphver_session() as s:       # the publish does not see it (see above)
            await s.execute(update(JobORM).where(JobORM.id == job_id).values(status="failed"))
        await svc.publish(graph_id=gid, branch_id=draft, actor="u", message="ship")
        async with db.graphver_session() as s:
            await s.execute(update(JobORM).where(JobORM.id == job_id).values(status="pending"))
        async with db.graphver_session() as s:
            commits = await s.scalar(select(func.count()).select_from(CommitORM).where(
                CommitORM.graph_id == gid, CommitORM.branch_id == draft))

        await ie.run_import_safe(job_id, await lease_job(job_id))

        job = await ie.get_job(job_id)
        assert job["status"] == "failed" and "is merged" in job["errorMessage"], job
        async with db.graphver_session() as s:
            assert await s.scalar(select(func.count()).select_from(CommitORM).where(
                CommitORM.graph_id == gid, CommitORM.branch_id == draft)) == commits
        state = await svc.materialize_state(graph_id=gid, branch_id=await svc.main_branch_id(gid))
        assert "urn:I" not in {p.get("urn") for p in state["nodes"].values()}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_an_import_onto_main_is_refused():
    _e2e(_main)


def test_an_import_onto_another_graphs_draft_or_no_branch_is_unknown():
    _e2e(_unknown)


def test_an_import_onto_a_closed_draft_is_refused():
    _e2e(_closed)


def test_an_import_whose_draft_is_published_before_it_runs_fails():
    _e2e(_published_before_it_runs)
