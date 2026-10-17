"""A private draft is read only by its owner, workspace managers and PR participants (doc 13
READ_DRAFT) — over HTTP, needs Postgres.

Alice owns a private draft. Bob holds ``datasource:read`` but not manage: every read of it naming
``branchId`` is 404, the same answer as a branch that doesn't exist, so he can't learn it is there
— the graph routes (through the context engine), neighbors, freshness and members. Carol (a
manager) reads it, Alice reads it without manage, and Dave reads it once he reviews her PR.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models

from .test_api_graph_draft_journey import _IMPORT_NDJSON, _StubCache, _StubManager, _build_app


def _app():
    from fastapi import Request
    from types import SimpleNamespace
    from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    app, G = _build_app()

    async def header_user(request: Request):         # X-User picks the caller
        uid = request.headers.get("X-User", "alice")
        return SimpleNamespace(id=uid, email=f"{uid}@example.com")

    async def header_claims(request: Request):       # X-Manage: 1 adds workspace manage to read
        perms = ("workspace:datasource:read",)
        if request.headers.get("X-Manage") == "1":
            perms += ("workspace:datasource:manage",)
        return PermissionClaims(sid="", global_perms=(), ws_perms={"ws1": perms})
    app.dependency_overrides[get_current_user] = header_user
    app.dependency_overrides[get_optional_user] = header_user
    app.dependency_overrides[get_permission_claims] = header_claims
    return app, G


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, G = _app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()
    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    setup = {"X-User": "alice", "X-Manage": "1"}
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=setup)
            assert r.status_code == 201, r.text
            gid = r.json()["graphId"]
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON, headers=setup)
            assert r.status_code == 200, r.text
            d = (await c.post(f"{V1}/graphs/{gid}/branches", json={}, headers=setup)).json()["branchId"]
            save = {"ops": [{"op": "update", "kind": "node", "id": "urn:t:child",
                             "payload": {"displayName": "Child v2"}}]}
            r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": d}, json=save, headers=setup)
            assert r.status_code == 200, r.text

            async def reads(user: str, manage: bool = False, branch: str = d) -> list:
                h = {"X-User": user, "X-Manage": "1" if manage else "0"}
                return [
                    await c.post(f"{GP}/nodes/query", params={"dataSourceId": ds, "branchId": branch},
                                 json={"query": {}}, headers=h),
                    await c.get(f"{V1}/graphs/{gid}/graph/neighbors",
                                params={"urn": "urn:t:root", "branchId": branch}, headers=h),
                    await c.get(f"{V1}/graphs/{gid}/branches/{branch}/freshness", headers=h),
                    await c.get(f"{V1}/graphs/{gid}/branches/{branch}/members", headers=h),
                ]

            def hidden(rs):
                for r in rs:
                    assert r.status_code == 404, (r.request.url, r.text)

            def shown(rs):
                for r in rs:
                    assert r.status_code == 200, (r.request.url, r.text)
                names = {n.get("displayName") for n in rs[0].json()}
                assert "Child v2" in names, names   # the draft's own edit, not main's

            # An unknown branch and Alice's draft answer Bob alike.
            hidden(await reads("bob", branch="br_bogus"))
            hidden(await reads("bob"))
            hidden(await reads("dave"))
            shown(await reads("carol", manage=True))
            shown(await reads("alice"))

            r = await c.post(f"{V1}/graphs/{gid}/branches/{d}/merge-requests",
                             json={"reviewers": ["dave"]}, headers=setup)
            assert r.status_code == 201, r.text
            shown(await reads("dave"))
            hidden(await reads("bob"))
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_private_draft_read_only_by_owner_managers_and_reviewers(data_sources):
    asyncio.run(_run())
