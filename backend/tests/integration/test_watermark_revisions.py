"""The watermark names the REVISION each side is at — the main commit whose seq the system of
record's head and the graph hold — so the sync indicators can say "version #12 · cmt_…" and a
reader can match it to History. Needs Postgres (GRAPHVER_E2E=1)."""
import asyncio
import os

import pytest

from backend.app.services.versioning import models
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_projection import FakeFalkor
from backend.tests.integration.test_versioning_reads import _build_app


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, _V = _build_app()
    svc = GraphVersioningService()
    ws1 = "/api/v1/ws1/versioning"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        gid = (await c.post(f"{ws1}/graphs", json={"dataSourceId": "ds_" + os.urandom(3).hex(), "workspaceId": "ws1",
                                                 "falkorGraphName": "gvt_" + os.urandom(3).hex()})).json()["graphId"]
        bid = (await c.post(f"{ws1}/graphs/{gid}/branches", json={})).json()["branchId"]
        await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/changes", json={"ops": [
            {"op": "create", "entityKind": "node", "entityId": "A", "payload": {"displayName": "Alpha", "entityType": "Dataset"}},
        ]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/commit", json={})
        published = (await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/publish", json={"message": "ship it"})).json()

        # The head names the publish commit. (Whether the graph is behind it yet depends on the
        # live dev projection worker, which shares this database and may already have run — so it
        # is not asserted here.)
        wm = (await c.get(f"{ws1}/graphs/{gid}/watermark")).json()
        assert wm["committedRevision"]["commitId"] == published["commitId"]
        assert wm["committedRevision"]["message"] == "ship it"
        assert wm["committedRevision"]["createdAt"]

        # Projected: both sides name the same revision.
        await FalkorProjector(graph_client_factory=FakeFalkor()).project_graph(gid)
        wm = (await c.get(f"{ws1}/graphs/{gid}/watermark")).json()
        assert wm["fresh"] is True
        assert wm["projectedRevision"]["commitId"] == published["commitId"] == wm["committedRevision"]["commitId"]
        assert (await svc.projection_watermark(gid))["committed_revision"]["commit_id"] == published["commitId"]


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_watermark_names_both_revisions():
    asyncio.run(_run())
