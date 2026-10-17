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


async def _run(data_sources: dict) -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, _V = _build_app()
    svc = GraphVersioningService()
    ws1 = "/api/v1/ws1/versioning"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        ds = "ds_" + os.urandom(3).hex()
        data_sources[ds] = "gvt_" + os.urandom(3).hex()
        gid = (await c.post(f"{ws1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"})).json()["graphId"]
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
        assert wm["readRoute"] == {"main": "falkordb", "drafts": "overlay"}
        assert wm["projectedRevision"]["commitId"] == published["commitId"] == wm["committedRevision"]["commitId"]
        assert (await svc.projection_watermark(gid))["committed_revision"]["commit_id"] == published["commitId"]


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_watermark_names_both_revisions(data_sources):
    asyncio.run(_run(data_sources))


async def _projection_fields() -> None:
    """The watermark says where each graph's projection lives — the key, the provider hosting it
    and whether the platform minted that key — for a blank model, a graph pinned to its data
    source's own graph, and a fork, read from ``projection_state``. It carries the retry state and
    a liveness failure so a backing-off graph can be told apart from a wedged one."""
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import update

    from backend.app.db.engine import PoolRole, get_engine, get_session_factory
    from backend.app.db.models import Base as MgmtBase, ProviderORM
    from backend.app.services.versioning.db import graphver_session

    await models.create_schema_and_partitions()
    async with get_engine(PoolRole.WEB).begin() as conn:
        await conn.run_sync(MgmtBase.metadata.create_all, tables=[ProviderORM.__table__])
    sfx = os.urandom(3).hex()
    prov = f"prov_wm_{sfx}"
    async with get_session_factory(PoolRole.WEB)() as s:
        s.add(ProviderORM(id=prov, name="Falkor West", provider_type="falkordb",
                          host="falkordb", port=6379))
        await s.commit()

    app, _V = _build_app()
    svc = GraphVersioningService()
    ws1 = "/api/v1/ws1/versioning"
    blank = (await svc.create_graph(
        data_source_id=f"ds_b_{sfx}", workspace_id="ws1", kind="blank", owns_falkor_graph=True,
        falkor_graph_name=f"blank_{sfx}", falkor_provider=prov))["graph_id"]
    pinned = (await svc.create_graph(
        data_source_id=f"ds_p_{sfx}", workspace_id="ws1",
        falkor_graph_name=f"customer_{sfx}", falkor_provider=prov))["graph_id"]
    fork = (await svc.fork_graph(parent_graph_id=pinned, workspace_id="ws1", actor="u_test"))["graph_id"]
    async with graphver_session() as s:
        await s.execute(update(models.ProjectionStateORM)
                        .where(models.ProjectionStateORM.graph_id == pinned)
                        .values(epoch=7, failed_attempts=3, next_retry_at="2026-10-17T12:00:00Z",
                                last_error="liveness: projection key missing"))
        await s.execute(update(models.ProjectionStateORM)
                        .where(models.ProjectionStateORM.graph_id == fork)
                        .values(last_error="FalkorDB unreachable"))
        await s.commit()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        wm = {g: (await c.get(f"{ws1}/graphs/{g}/watermark")).json() for g in (blank, pinned, fork)}

    assert {k: wm[blank][k] for k in ("projectionKey", "providerId", "providerName", "owned")} == {
        "projectionKey": f"blank_{sfx}", "providerId": prov, "providerName": "Falkor West", "owned": True}
    assert {k: wm[pinned][k] for k in ("projectionKey", "providerId", "providerName", "owned")} == {
        "projectionKey": f"customer_{sfx}", "providerId": prov, "providerName": "Falkor West", "owned": False}
    assert {k: wm[fork][k] for k in ("projectionKey", "providerId", "providerName", "owned")} == {
        "projectionKey": f"customer_{sfx}__fork_{fork}", "providerId": prov,
        "providerName": "Falkor West", "owned": True}
    # Retry and liveness state: a liveness reset names itself; any other failure is not one.
    assert {k: wm[pinned][k] for k in ("epoch", "failedAttempts", "nextRetryAt", "livenessError")} == {
        "epoch": 7, "failedAttempts": 3, "nextRetryAt": "2026-10-17T12:00:00Z",
        "livenessError": "liveness: projection key missing"}
    assert wm[blank]["failedAttempts"] == 0 and wm[blank]["nextRetryAt"] is None
    assert wm[fork]["lastError"] == "FalkorDB unreachable" and wm[fork]["livenessError"] is None


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_watermark_says_where_the_projection_lives():
    asyncio.run(_projection_fields())
