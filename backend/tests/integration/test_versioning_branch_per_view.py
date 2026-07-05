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


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning branch-per-view e2e: OK")
