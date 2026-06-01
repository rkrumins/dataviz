"""HTTP test for the versioning API — proves the frontend↔Postgres path is
API-only AND that the boundary enforces auth, RBAC, and tenant isolation (needs
Postgres).

Drives the router over in-process ASGI.  Only the two leaf identity dependencies
are overridden (``get_current_user`` + ``get_permission_claims``) so the *real*
``requires(...)`` gate logic runs; a per-request header decides which data-source
permissions the caller holds in the path workspace.  Skipped unless
``GRAPHVER_E2E=1`` + a reachable Postgres.
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models

R = "workspace:datasource:read"
M = "workspace:datasource:manage"


def _hdr(perms: str) -> dict:
    return {"x-test-perms": perms}


def _build_app():
    from fastapi import FastAPI, Request
    import backend.app.auth.dependencies as deps
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.api.v1.endpoints import versioning as V

    # No Redis in the test env: neutralise the revocation lookup (never hit
    # anyway since our claims carry an empty sid).
    deps.get_revocation_service = lambda: SimpleNamespace(is_revoked=lambda sid: False)

    async def fake_user():
        return SimpleNamespace(id="u_test", email="t@example.com")

    async def fake_claims(request: Request):
        perms = tuple(p for p in request.headers.get("x-test-perms", "").split(",") if p)
        ws = request.path_params.get("ws_id") or "ws1"
        return PermissionClaims(sid="", global_perms=(), ws_perms={ws: perms} if perms else {})

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[get_permission_claims] = fake_claims
    return app


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app = _build_app()
    c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    ws1 = "/api/v1/ws1/versioning"

    async with c:
        ds = "ds_" + os.urandom(4).hex()

        # ── RBAC: no permission → 403 ────────────────────────────────────
        r = await c.post(f"{ws1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=_hdr(""))
        assert r.status_code == 403, r.text

        # ── manage → create graph (camelCase contract) ───────────────────
        r = await c.post(f"{ws1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"}, headers=_hdr(M))
        assert r.status_code == 201, r.text
        gid = r.json()["graphId"]

        # ── tenant isolation: same graph via ws2 → 404 (not leaked) ──────
        r = await c.get(f"/api/v1/ws2/versioning/graphs/{gid}", headers=_hdr(R))
        assert r.status_code == 404, r.text

        # ── happy path (read+manage) ─────────────────────────────────────
        h = _hdr(f"{R},{M}")
        bid = (await c.post(f"{ws1}/graphs/{gid}/branches", json={"originatingViewId": "v1"}, headers=h)).json()["branchId"]
        r = await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/changes", headers=h, json={"ops": [
            {"op": "create", "entityKind": "node", "entityId": "A", "payload": {"displayName": "Alpha"}},
            {"op": "create", "entityKind": "node", "entityId": "B", "payload": {"displayName": "Beta"}},
            {"op": "create", "entityKind": "edge", "entityId": "E1", "payload": {"edgeType": "R", "sourceEntityId": "A", "targetEntityId": "B"}},
        ]})
        assert r.json()["count"] == 3, r.text
        assert (await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/commit", json={}, headers=h)).json()["stagedChanges"] is True
        st = (await c.get(f"{ws1}/graphs/{gid}/branches/{bid}/state", headers=h)).json()
        assert set(st["nodes"]) == {"A", "B"} and set(st["edges"]) == {"E1"}
        # read endpoint with manage-only (no read perm) → 403 (perms are distinct)
        assert (await c.get(f"{ws1}/graphs/{gid}/branches/{bid}/state", headers=_hdr(M))).status_code == 403
        assert (await c.post(f"{ws1}/graphs/{gid}/branches/{bid}/publish", json={"message": "seed"}, headers=h)).status_code == 200
        hist = (await c.get(f"{ws1}/graphs/{gid}/entities/A/history", headers=h)).json()
        assert hist["entityId"] == "A" and any(v["op"] == "create" for v in hist["versions"])
        from backend.app.services.versioning.service import GraphVersioningService
        mid = await GraphVersioningService().main_branch_id(gid)
        d = (await c.get(f"{ws1}/graphs/{gid}/branches/{mid}/diff", params={"fromSeq": 1, "toSeq": 2}, headers=h)).json()
        assert set(d["added"]) == {"A", "B", "E1"}

        # ── fork/PR governance ───────────────────────────────────────────
        # read-only caller may fork and open a PR …
        fork = (await c.post(f"{ws1}/graphs/{gid}/forks", json={}, headers=_hdr(R))).json()
        fgid = fork["graphId"]
        # diverge on the fork (needs manage on the fork)
        fb = (await c.post(f"{ws1}/graphs/{fgid}/branches", json={}, headers=h)).json()["branchId"]
        await c.post(f"{ws1}/graphs/{fgid}/branches/{fb}/changes", headers=h, json={"ops": [
            {"op": "update", "entityKind": "node", "entityId": "A", "payload": {"displayName": "Alpha2"}},
        ]})
        await c.post(f"{ws1}/graphs/{fgid}/branches/{fb}/commit", json={}, headers=h)
        await c.post(f"{ws1}/graphs/{fgid}/branches/{fb}/publish", json={"message": "fork work"}, headers=h)
        pr = (await c.post(f"{ws1}/graphs/{fgid}/pulls", json={}, headers=_hdr(R))).json()["prId"]
        assert (await c.get(f"{ws1}/pulls/{pr}/preview", headers=_hdr(R))).json()["clean"] is True
        # … but a read-only caller may NOT merge into the base → 403 …
        assert (await c.post(f"{ws1}/pulls/{pr}/merge", json={"message": "m"}, headers=_hdr(R))).status_code == 403
        # … manage merges it.
        r = await c.post(f"{ws1}/pulls/{pr}/merge", json={"message": "merge fork"}, headers=h)
        assert r.status_code == 200, r.text
        base_state = (await c.get(f"{ws1}/graphs/{gid}/branches/{mid}/state", headers=h)).json()
        assert base_state["nodes"]["A"]["displayName"] == "Alpha2"

        # ── conflict → 409 → resolve → 200 (via the API) ─────────────────
        f2 = (await c.post(f"{ws1}/graphs/{gid}/forks", json={}, headers=_hdr(R))).json()["graphId"]
        f2b = (await c.post(f"{ws1}/graphs/{f2}/branches", json={}, headers=h)).json()["branchId"]
        await c.post(f"{ws1}/graphs/{f2}/branches/{f2b}/changes", headers=h, json={"ops": [{"op": "update", "entityKind": "node", "entityId": "A", "payload": {"displayName": "FromFork"}}]})
        await c.post(f"{ws1}/graphs/{f2}/branches/{f2b}/commit", json={}, headers=h)
        await c.post(f"{ws1}/graphs/{f2}/branches/{f2b}/publish", json={"message": "f2"}, headers=h)
        # base changes the same field
        pb = (await c.post(f"{ws1}/graphs/{gid}/branches", json={}, headers=h)).json()["branchId"]
        await c.post(f"{ws1}/graphs/{gid}/branches/{pb}/changes", headers=h, json={"ops": [{"op": "update", "entityKind": "node", "entityId": "A", "payload": {"displayName": "FromBase"}}]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{pb}/commit", json={}, headers=h)
        await c.post(f"{ws1}/graphs/{gid}/branches/{pb}/publish", json={"message": "base"}, headers=h)
        pr2 = (await c.post(f"{ws1}/graphs/{f2}/pulls", json={}, headers=_hdr(R))).json()["prId"]
        conflict = await c.post(f"{ws1}/pulls/{pr2}/merge", json={"message": "m"}, headers=h)
        assert conflict.status_code == 409 and conflict.json()["detail"]["type"] == "merge_conflict", conflict.text
        resolved = await c.post(f"{ws1}/pulls/{pr2}/merge", json={"message": "resolved", "resolutions": {"A": {"displayName": "Resolved"}}}, headers=h)
        assert resolved.status_code == 200, resolved.text

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_api_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning API (auth + RBAC + tenant + governance) e2e: OK")
