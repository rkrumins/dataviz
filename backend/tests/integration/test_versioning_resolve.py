"""Resolve endpoint + draft bootstrap (unification Phase 2) — needs Postgres.

The UI boots from (workspace, dataSource): GET /resolve finds the versioned graph and
the caller's open draft without opening one; POST /resolve ensures a draft exists
(reusing the caller's newest open one rather than spawning duplicates). Unknown data
sources 404; multiple open drafts resolve to the newest.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import models
from backend.app.services.versioning.service import GraphVersioningService

R, M = "workspace:datasource:read", "workspace:datasource:manage"


def _build_app():
    from fastapi import FastAPI, Request
    import backend.app.auth.dependencies as deps
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.api.v1.endpoints import versioning as V

    deps.get_revocation_service = lambda: SimpleNamespace(is_revoked=lambda sid: False)

    async def fake_user():
        return SimpleNamespace(id="u_test", email="t@example.com")

    async def fake_claims(request: Request):
        ws = request.path_params.get("ws_id") or "ws1"
        return PermissionClaims(sid="", global_perms=(), ws_perms={ws: (R, M)})

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[get_permission_claims] = fake_claims
    return app, V


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, V = _build_app()
    svc = GraphVersioningService()
    ws1 = "/api/v1/ws1/versioning"
    ds = "ds_" + os.urandom(4).hex()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        gid = (await c.post(f"{ws1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"})).json()["graphId"]

        # GET resolve: finds the graph, opens no draft
        g = (await c.get(f"{ws1}/resolve", params={"dataSourceId": ds})).json()
        assert g["graphId"] == gid and g["mainHeadCommitSeq"] == 1 and g["myDraft"] is None
        assert g["mainBranchId"] == await svc.main_branch_id(gid)

        # POST resolve: opens a draft
        b1 = (await c.post(f"{ws1}/resolve", json={"dataSourceId": ds})).json()["myDraft"]["branchId"]
        assert b1

        # GET now returns that draft; POST is idempotent (reuses, no duplicate)
        assert (await c.get(f"{ws1}/resolve", params={"dataSourceId": ds})).json()["myDraft"]["branchId"] == b1
        assert (await c.post(f"{ws1}/resolve", json={"dataSourceId": ds})).json()["myDraft"]["branchId"] == b1

        # a second, newer draft → resolve picks the newest
        await asyncio.sleep(0.02)
        b2 = (await c.post(f"{ws1}/graphs/{gid}/branches", json={})).json()["branchId"]
        assert b2 != b1
        assert (await c.get(f"{ws1}/resolve", params={"dataSourceId": ds})).json()["myDraft"]["branchId"] == b2

        # unknown data source → 404
        assert (await c.get(f"{ws1}/resolve", params={"dataSourceId": "ds_nope"})).status_code == 404
        # workspace isolation: same ds resolved under a different workspace → 404
        assert (await c.get("/api/v1/ws2/versioning/resolve", params={"dataSourceId": ds})).status_code == 404

    from backend.app.services.versioning import db
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_resolve_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning resolve + draft bootstrap e2e: OK")
