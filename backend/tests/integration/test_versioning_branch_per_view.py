"""Branch-per-view draft resolution — resolve_graph isolates drafts per (data source, owner, VIEW).

Task 1 of the branch-per-view plan. Today ``resolve_graph`` returns ANY of the owner's open drafts
on the data source (most-recent wins, no view filter), so two views on one source share a draft and
View B sees View A's staged edits. This pins the fix: when ``originating_view_id`` is provided,
``resolve_graph`` prefers THIS view's own draft; else claims a not-yet-attributed
(``originating_view_id IS NULL``) legacy draft for this view; else (only OTHER views' drafts exist)
opens a fresh draft for this view when ``open_draft_if_absent`` else returns no draft (⇒ Published).
When ``originating_view_id`` is None (a legacy/no-view caller) it is unchanged: the owner's
most-recent open draft. Live Postgres (``GRAPHVER_E2E=1``); no FalkorDB.
"""
import asyncio
import os

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import BranchORM, WorkingChangeORM
from backend.app.services.versioning.service import GraphVersioningService


async def _pending_count(graph_id: str, branch_id: str) -> int:
    """Uncommitted working-change rows on a branch (a draft's staged, un-checkpointed edits)."""
    async with db.graphver_session() as s:
        return int((await s.execute(
            select(func.count()).select_from(WorkingChangeORM).where(
                WorkingChangeORM.graph_id == graph_id,
                WorkingChangeORM.branch_id == branch_id,
                WorkingChangeORM.committed_into_commit_id.is_(None),
            )
        )).scalar_one())


async def _new_graph(svc: GraphVersioningService, actor: str):
    """A fresh versioned graph (1:1 with a unique data source) seeded with one node."""
    ds = "ds_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor=actor)
    gid = G["graph_id"]
    await svc.apply_ops(graph_id=gid, actor=actor, message="seed", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N1",
         "payload": {"urn": "N1", "entityType": "Table", "displayName": "N1"}}])
    return ds, gid


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    actor = "u_" + os.urandom(3).hex()
    v1, v2 = "view_" + os.urandom(3).hex(), "view_" + os.urandom(3).hex()

    # ---- Core: two views on one data source get ISOLATED drafts -----------------------------
    ds, gid = await _new_graph(svc, actor)

    # resolve+open as v1, then stage a change on v1's draft
    r1 = await svc.resolve_graph(data_source_id=ds, actor=actor, originating_view_id=v1)
    d1 = r1["my_draft"]["branch_id"]
    assert r1["my_draft"]["originating_view_id"] == v1
    await svc.stage_changes(graph_id=gid, branch_id=d1, actor=actor, ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N_v1",
         "payload": {"urn": "N_v1", "entityType": "Table", "displayName": "N_v1"}}])
    assert await _pending_count(gid, d1) == 1

    # resolve as v2 (open_if_absent) → a DIFFERENT draft, WITHOUT v1's staged change
    r2 = await svc.resolve_graph(data_source_id=ds, actor=actor, originating_view_id=v2)
    d2 = r2["my_draft"]["branch_id"]
    assert d2 != d1, "v2 must NOT reuse v1's draft (branch-per-view isolation)"
    assert r2["my_draft"]["originating_view_id"] == v2
    assert await _pending_count(gid, d2) == 0, "v1's staged change must be invisible in v2's draft"

    # resolve back as v1 → ITS draft, the staged change still there
    r1b = await svc.resolve_graph(data_source_id=ds, actor=actor, originating_view_id=v1)
    assert r1b["my_draft"]["branch_id"] == d1
    assert await _pending_count(gid, d1) == 1

    # a view with no own draft + open_draft_if_absent=False → Published (no draft), even though
    # OTHER views (v1, v2) have open drafts on this graph
    v3 = "view_" + os.urandom(3).hex()
    r3 = await svc.resolve_graph(data_source_id=ds, actor=actor,
                                 originating_view_id=v3, open_draft_if_absent=False)
    assert r3["my_draft"] is None, "a view with no own draft opens Published when not auto-opening"

    # ---- Claim-fill: a legacy null-view draft is adopted by the first view to resolve --------
    ds_c, gid_c = await _new_graph(svc, actor)
    legacy = await svc.open_draft(graph_id=gid_c, owner=actor)  # originating_view_id = None
    rc = await svc.resolve_graph(data_source_id=ds_c, actor=actor, originating_view_id=v1)
    assert rc["my_draft"]["branch_id"] == legacy, "first view claims the unattributed legacy draft"
    assert rc["my_draft"]["originating_view_id"] == v1
    async with db.graphver_session() as s:
        assert (await s.get(BranchORM, legacy)).originating_view_id == v1  # persisted claim

    # ---- Claim gate: a READ (open_draft_if_absent=False) must NOT mutate a null-view draft's
    # originating_view_id; only a write-intent resolve (open_draft_if_absent=True) claims it ----
    ds_g, gid_g = await _new_graph(svc, actor)
    legacy_g = await svc.open_draft(graph_id=gid_g, owner=actor)  # originating_view_id = None
    v_read = "view_" + os.urandom(3).hex()
    rg_read = await svc.resolve_graph(
        data_source_id=ds_g, actor=actor, originating_view_id=v_read, open_draft_if_absent=False)
    assert rg_read["my_draft"]["branch_id"] == legacy_g, "a read still SEES the unattributed legacy draft"
    async with db.graphver_session() as s:
        assert (await s.get(BranchORM, legacy_g)).originating_view_id is None, \
            "a read (open_draft_if_absent=False) must NOT claim/mutate the null-view draft"
    v_write = "view_" + os.urandom(3).hex()
    rg_write = await svc.resolve_graph(
        data_source_id=ds_g, actor=actor, originating_view_id=v_write, open_draft_if_absent=True)
    assert rg_write["my_draft"]["branch_id"] == legacy_g, "the write-intent resolve claims the same draft"
    async with db.graphver_session() as s:
        assert (await s.get(BranchORM, legacy_g)).originating_view_id == v_write, \
            "a write-intent resolve (open_draft_if_absent=True) DOES claim (mutate) the null-view draft"

    # ---- Legacy None-view caller unchanged: owner's MOST-RECENT open draft -------------------
    ds_n, gid_n = await _new_graph(svc, actor)
    _da = await svc.open_draft(graph_id=gid_n, owner=actor)
    await asyncio.sleep(0.005)  # distinct created_at so "most recent" is deterministic
    dbr = await svc.open_draft(graph_id=gid_n, owner=actor)
    rn = await svc.resolve_graph(data_source_id=ds_n, actor=actor, originating_view_id=None)
    assert rn["my_draft"]["branch_id"] == dbr, \
        "None-view caller keeps the most-recent-owner-draft behavior byte-for-byte"

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_branch_per_view_e2e():
    asyncio.run(_run())


# --------------------------------------------------------------------------------------------- #
# Task 2: GET /resolve threads viewId + optional viewId filter on branch/PR/commit-log lists      #
# --------------------------------------------------------------------------------------------- #
R, M = "workspace:datasource:read", "workspace:datasource:manage"


def _build_app():
    from types import SimpleNamespace

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
    return app


async def _run_http() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app = _build_app()
    ws1 = "/api/v1/ws1/versioning"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        ds = "ds_" + os.urandom(4).hex()
        gid = (await c.post(f"{ws1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"})).json()["graphId"]

        # ---- (a) GET /resolve threads viewId: v1 opens its own draft; v2's READ must NOT
        # resolve v1's draft — it resolves Published (no draft) instead ----------------------
        b1 = (await c.post(f"{ws1}/resolve",
                           json={"dataSourceId": ds, "originatingViewId": "v1"})).json()["myDraft"]["branchId"]
        g_v2 = (await c.get(f"{ws1}/resolve", params={"dataSourceId": ds, "viewId": "v2"})).json()
        assert g_v2["myDraft"] is None, "v2's GET /resolve must not see v1's draft (Published)"
        g_v1 = (await c.get(f"{ws1}/resolve", params={"dataSourceId": ds, "viewId": "v1"})).json()
        assert g_v1["myDraft"]["branchId"] == b1, "v1's GET /resolve resolves its own draft"

        # a GET read for a THIRD view must not claim an unattributed legacy draft on this graph
        svc = GraphVersioningService()
        legacy = await svc.open_draft(graph_id=gid, owner="u_test")   # originating_view_id = None
        g_v3 = (await c.get(f"{ws1}/resolve", params={"dataSourceId": ds, "viewId": "v3"})).json()
        assert g_v3["myDraft"]["branchId"] == legacy, "a read still SEES the unattributed legacy draft"
        async with db.graphver_session() as s:
            assert (await s.get(BranchORM, legacy)).originating_view_id is None, \
                "GET /resolve (read) must NOT mutate the null draft's originatingViewId"
        await svc.abandon_draft(graph_id=gid, branch_id=legacy, actor="u_test")  # keep it out of the lists below

        # v1's draft gets one checkpoint commit attributed to v1.
        await c.post(f"{ws1}/graphs/{gid}/branches/{b1}/changes", json={"ops": [
            {"op": "create", "entityKind": "node", "entityId": "N_v1", "payload": {"displayName": "N_v1"}}]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{b1}/commit", json={})
        pr_v1 = (await c.post(f"{ws1}/graphs/{gid}/branches/{b1}/merge-requests", json={})).json()["prId"]

        # v2 opens (write-intent) its OWN draft and gets one checkpoint commit attributed to v2.
        b2 = (await c.post(f"{ws1}/resolve",
                           json={"dataSourceId": ds, "originatingViewId": "v2"})).json()["myDraft"]["branchId"]
        assert b2 != b1
        await c.post(f"{ws1}/graphs/{gid}/branches/{b2}/changes", json={"ops": [
            {"op": "create", "entityKind": "node", "entityId": "N_v2", "payload": {"displayName": "N_v2"}}]})
        await c.post(f"{ws1}/graphs/{gid}/branches/{b2}/commit", json={})
        pr_v2 = (await c.post(f"{ws1}/graphs/{gid}/branches/{b2}/merge-requests", json={})).json()["prId"]

        # ---- (c) GET /pulls: default graph-wide (BOTH views), ?viewId= narrows to one -------
        all_prs = {p["prId"] for p in (await c.get(f"{ws1}/graphs/{gid}/pulls")).json()}
        assert {pr_v1, pr_v2} <= all_prs, "no viewId ⇒ graph-wide PR list includes BOTH views"
        v1_prs = {p["prId"] for p in (await c.get(f"{ws1}/graphs/{gid}/pulls", params={"viewId": "v1"})).json()}
        assert v1_prs == {pr_v1}, "viewId=v1 narrows the PR list to that view's own PRs"
        v2_prs = {p["prId"] for p in (await c.get(f"{ws1}/graphs/{gid}/pulls", params={"viewId": "v2"})).json()}
        assert v2_prs == {pr_v2}, "viewId=v2 narrows the PR list to that view's own PRs"

        # ---- (d) branch-list: default graph-wide (main + BOTH view drafts), ?viewId= narrows -
        all_branches = {b["branchId"] for b in (await c.get(f"{ws1}/graphs/{gid}/branches")).json()}
        assert {b1, b2} <= all_branches, "no viewId ⇒ graph-wide branch list includes BOTH views' drafts"
        v1_branches = {b["branchId"] for b in
                       (await c.get(f"{ws1}/graphs/{gid}/branches", params={"viewId": "v1"})).json()}
        assert v1_branches == {b1}, "viewId=v1 narrows the branch list to that view's own branch(es)"

        # ---- (d) commit-log: originatingViewId narrows to one view's raw commits; the
        # existing branch-scoped default (main by default) is unaffected by the new filter ----
        cl_v1 = {cm["commit_id"] for cm in
                 (await c.get(f"{ws1}/graphs/{gid}/commits", params={"originatingViewId": "v1"})).json()["commits"]}
        cl_v2 = {cm["commit_id"] for cm in
                 (await c.get(f"{ws1}/graphs/{gid}/commits", params={"originatingViewId": "v2"})).json()["commits"]}
        assert cl_v1 and cl_v2 and cl_v1.isdisjoint(cl_v2), \
            "originatingViewId scopes the commit log to that view's own commits only"
        cl_default = (await c.get(f"{ws1}/graphs/{gid}/commits")).json()["commits"]  # default: main, unfiltered
        assert not (cl_v1 & {cm["commit_id"] for cm in cl_default}), \
            "the default (no originatingViewId) commit log is unaffected — still main, not view-filtered"

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_branch_per_view_http_e2e():
    asyncio.run(_run_http())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning branch-per-view e2e: OK")
    asyncio.run(_run_http())
    print("versioning branch-per-view http e2e: OK")
