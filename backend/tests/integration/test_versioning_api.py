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


async def _seed_management_user() -> None:
    """Seed management-DB ``users`` rows for the harness's principals — the acting
    ``u_test`` and a second ``u_rev`` (a reviewer who can approve, since authors
    can't approve their own PR) — so the versioning endpoints can resolve their
    ids → display names. The management ``users`` table lives in the SAME Postgres
    as the graphver store here; create it (plus the ``idp_providers`` its FK
    references) if absent, then upsert the actors. Idempotent across runs."""
    from backend.app.db.engine import PoolRole, get_engine, get_session_factory
    from backend.app.db.models import Base as MgmtBase, IdpProviderORM, UserORM

    eng = get_engine(PoolRole.WEB)
    async with eng.begin() as conn:
        await conn.run_sync(
            MgmtBase.metadata.create_all,
            tables=[IdpProviderORM.__table__, UserORM.__table__],
        )
    seed = {
        "u_test": ("t@example.com", "Test", "Actor"),
        "u_rev": ("rev@example.com", "Reviewer", "Person"),
    }
    async with get_session_factory(PoolRole.WEB)() as s:
        for uid, (email, first, last) in seed.items():
            if await s.get(UserORM, uid) is None:
                s.add(UserORM(
                    id=uid, email=email, password_hash="x",
                    first_name=first, last_name=last, status="active",
                ))
        await s.commit()


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    await _seed_management_user()
    app = _build_app()
    # Keep the projection background task (fired by publish/merge/rebuild) hermetic — no live
    # FalkorDB/Redis in this harness — so a rebuild's replay doesn't reach for a real socket.
    from backend.app.api.v1.endpoints import versioning as V

    async def _noop_project_now(graph_id: str) -> None:
        return None

    _orig_project_now = V.project_now
    V.project_now = _noop_project_now
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

        # ── rebase ("pull latest"): RBAC + up-to-date no-op + behind→clean ─
        rb = (await c.post(f"{ws1}/graphs/{gid}/branches", json={}, headers=h)).json()["branchId"]
        # read-only caller may not rebase (manage-gated) → 403
        assert (await c.post(f"{ws1}/graphs/{gid}/branches/{rb}/rebase", json={}, headers=_hdr(R))).status_code == 403
        up = await c.post(f"{ws1}/graphs/{gid}/branches/{rb}/rebase", json={}, headers=h)   # up to date → clean no-op
        assert up.status_code == 200, up.text
        assert up.json()["clean"] is True and set(up.json()) >= {"clean", "conflicts", "changes"}
        # advance main under it (publish another draft adding C), then the rebase pulls main forward
        adv = (await c.post(f"{ws1}/graphs/{gid}/branches", json={}, headers=h)).json()["branchId"]
        await c.post(f"{ws1}/graphs/{gid}/branches/{adv}/changes", headers=h, json={"ops": [
            {"op": "create", "entityKind": "node", "entityId": "C", "payload": {"displayName": "Gamma"}}]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{adv}/commit", json={}, headers=h)
        await c.post(f"{ws1}/graphs/{gid}/branches/{adv}/publish", json={"message": "add C"}, headers=h)
        pulled = await c.post(f"{ws1}/graphs/{gid}/branches/{rb}/rebase", json={}, headers=h)
        assert pulled.status_code == 200 and pulled.json()["clean"] is True, pulled.text
        assert "C" in (await c.get(f"{ws1}/graphs/{gid}/branches/{rb}/state", headers=h)).json()["nodes"]

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

        # ── actor id → display-name resolution (userNames maps) ──────────
        # branches list: each item carries a userNames map covering its owner.
        brs = (await c.get(f"{ws1}/graphs/{gid}/branches", headers=h)).json()
        owned = [b for b in brs if b.get("owner") == "u_test"]
        assert owned and all(b["userNames"].get("u_test") == "Test Actor" for b in owned), brs
        # commit log: ONE wrapper-level map covers every commit's actor/contributors.
        cl = (await c.get(f"{ws1}/graphs/{gid}/commits", params={"branchId": mid}, headers=h)).json()
        assert cl["userNames"].get("u_test") == "Test Actor", cl
        # a checkpoint with no message no longer bakes the actor id into the stored message.
        mdb = (await c.post(f"{ws1}/graphs/{gid}/branches", json={}, headers=h)).json()["branchId"]
        await c.post(f"{ws1}/graphs/{gid}/branches/{mdb}/changes", headers=h, json={"ops": [
            {"op": "create", "entityKind": "node", "entityId": "Z", "payload": {"displayName": "Zed"}}]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{mdb}/commit", json={}, headers=h)
        dcl = (await c.get(f"{ws1}/graphs/{gid}/commits", params={"branchId": mdb}, headers=h)).json()
        assert any(cm["message"] == "checkpoint" for cm in dcl["commits"]), dcl
        # MR detail + list carry maps over actor/reviewers/approvedBy; an unresolvable id is absent.
        mrid = (await c.post(f"{ws1}/graphs/{gid}/branches/{mdb}/merge-requests",
                             json={"reviewers": ["u_rev", "usr_ghost"]}, headers=h)).json()["prId"]
        # Approve as u_rev (a different principal — authors can't self-approve).
        from backend.app.auth.dependencies import get_current_user
        _orig_user = app.dependency_overrides[get_current_user]
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="u_rev", email="rev@example.com")
        try:
            assert (await c.post(f"{ws1}/merge-requests/{mrid}/approve", headers=h)).status_code == 200
        finally:
            app.dependency_overrides[get_current_user] = _orig_user
        mr = (await c.get(f"{ws1}/merge-requests/{mrid}", headers=h)).json()
        assert mr["userNames"].get("u_test") == "Test Actor", mr        # actor + source_branch_owner
        assert mr["userNames"].get("u_rev") == "Reviewer Person", mr    # reviewer + approvedBy
        assert "usr_ghost" not in mr["userNames"], mr                   # unresolvable → absent, still 200
        assert "usr_ghost" in mr["reviewers"] and "u_rev" in mr["approvedBy"]  # raw ids kept on their fields
        mlist = (await c.get(f"{ws1}/graphs/{gid}/merge-requests", headers=h)).json()
        assert any(m["userNames"].get("u_test") == "Test Actor" for m in mlist), mlist

        # ── projection reconcile: RBAC + tenant isolation + unpinned skip ─
        # read-only caller may not reconcile (manage-gated) → 403
        assert (await c.post(f"{ws1}/graphs/{gid}/projection/reconcile", json={}, headers=_hdr(R))).status_code == 403
        rc = await c.post(f"{ws1}/graphs/{gid}/projection/reconcile", json={}, headers=h)
        assert rc.status_code == 200, rc.text
        # this graph was created without a FalkorDB target → reconcile reports a skip, not drift
        assert rc.json()["skippedReason"] == "no projection target" and rc.json()["inSync"] is False
        assert rc.json()["graphId"] == gid and rc.json()["pgNodes"] >= 1
        # cross-tenant reconcile via ws2 → 404 (graph existence not leaked)
        assert (await c.post(f"/api/v1/ws2/versioning/graphs/{gid}/projection/reconcile", json={}, headers=h)).status_code == 404
        # in-process concurrency guard: a reconcile already in flight for this graph → 409. (Two
        # gathered HTTP requests don't reliably interleave in the ASGI+httpx harness, so mark the
        # graph in-flight directly and assert the guard rejects the second call deterministically.)
        V._reconcile_inflight.add(gid)
        try:
            assert (await c.post(f"{ws1}/graphs/{gid}/projection/reconcile", json={}, headers=h)).status_code == 409
        finally:
            V._reconcile_inflight.discard(gid)

        # ── projection rebuild: RBAC + 409 when no target + 200 on a pinned graph ─
        # read-only caller may not rebuild (manage-gated) → 403
        assert (await c.post(f"{ws1}/graphs/{gid}/projection/rebuild", headers=_hdr(R))).status_code == 403
        # the unpinned graph has no FalkorDB target to rebuild → 409
        assert (await c.post(f"{ws1}/graphs/{gid}/projection/rebuild", headers=h)).status_code == 409
        # a PINNED graph rebuilds: started, watermark flipped to rebuilding
        pinned = (await c.post(f"{ws1}/graphs", json={
            "dataSourceId": "ds_" + os.urandom(4).hex(), "workspaceId": "ws1",
            "falkorGraphName": "real_" + os.urandom(3).hex()}, headers=_hdr(M))).json()["graphId"]
        rb = await c.post(f"{ws1}/graphs/{pinned}/projection/rebuild", headers=h)
        assert rb.status_code == 200, rb.text
        assert rb.json()["started"] is True and rb.json()["alreadyRunning"] is False
        assert rb.json()["watermark"]["status"] == "rebuilding"
        # a rebuild already in flight is a no-op → started=false / alreadyRunning=true
        rb2 = await c.post(f"{ws1}/graphs/{pinned}/projection/rebuild", headers=h)
        assert rb2.status_code == 200 and rb2.json()["started"] is False and rb2.json()["alreadyRunning"] is True
        # cross-tenant rebuild via ws2 → 404
        assert (await c.post(f"/api/v1/ws2/versioning/graphs/{pinned}/projection/rebuild", headers=h)).status_code == 404

    V.project_now = _orig_project_now                # restore: don't leak the no-op into other tests
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_api_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning API (auth + RBAC + tenant + governance) e2e: OK")
