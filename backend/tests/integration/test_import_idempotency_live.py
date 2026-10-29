"""An import's idempotency key on a live Postgres.

The jobs table holds one job per key on a graph, whatever its kind or state, so a second import
with a taken key is refused (``IntegrityError``) — and leaves no draft: the draft is opened in the
job's transaction, which the refused insert rolls back. The job the key started is what
``find_job`` finds.
"""
import asyncio
import os
import shutil
import tempfile

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.models import BranchORM
from backend.app.services.versioning.service import GraphVersioningService


async def _run(root):
    svc = GraphVersioningService()
    ie = ImportExportService(versioning=svc, store=LocalFsObjectStore(root))
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    key = f"u:nightly-{os.urandom(3).hex()}"
    common = dict(workspace_id="ws1", data_source_id="ds1", graph_id=gid, actor="u", import_format="ndjson")

    first = await ie.create_import_job(**common, idempotency_key=key)
    with pytest.raises(IntegrityError):
        await ie.create_import_job(**common, idempotency_key=key)

    async with db.graphver_session() as s:
        drafts = (await s.execute(select(BranchORM.id, BranchORM.status).where(
            BranchORM.graph_id == gid, BranchORM.kind != "main"))).all()
    assert dict(drafts)[first["branch_id"]] == "open"
    refused = [status for branch_id, status in drafts if branch_id != first["branch_id"]]
    assert refused == [], ("the refused call leaves no draft: it is opened in the job's transaction, "
                           "which the refused insert rolls back")

    found = await ie.find_job(graph_id=gid, idempotency_key=key)
    assert found["jobId"] == first["job_id"] and found["jobType"] == "ingest"

    # The key is taken for every kind of job: an export with it is refused too.
    with pytest.raises(IntegrityError):
        await ie.create_export_job(workspace_id="ws1", data_source_id="ds1", graph_id=gid, actor="u",
                                   idempotency_key=key)
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_a_taken_key_refuses_the_second_job_and_leaves_no_draft():
    root = tempfile.mkdtemp()
    try:
        asyncio.run(_run(root))
    finally:
        shutil.rmtree(root, ignore_errors=True)
