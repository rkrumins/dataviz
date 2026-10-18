"""The branch a view route is handed: ``check_view_branch`` on a live store — needs Postgres.

A view's branchId must be a branch of the view's own (live) graph that the caller can read, else
it is unknown (404). Main reads as the published view and refuses a write; a draft write needs the
draft open (branch_closed) and the caller able to edit it (access_denied): a manager reads someone
else's private draft but does not write it (not_draft_owner).
"""
import asyncio
import os

import pytest
from sqlalchemy import update

from backend.app.services.versioning import db, models
from backend.app.services.versioning.errors import BranchNotOpen, MainWriteForbidden, NotDraftOwner
from backend.app.services.versioning.models import GraphORM
from backend.app.services.versioning.service import AccessDenied, GraphVersioningService, Viewer

ALICE, BOB, CAROL = Viewer("alice"), Viewer("bob"), Viewer("carol")


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds_a, ds_b = "ds_" + os.urandom(4).hex(), "ds_" + os.urandom(4).hex()
    ga = (await svc.create_graph(data_source_id=ds_a, workspace_id="ws1", actor="alice"))["graph_id"]
    gb = (await svc.create_graph(data_source_id=ds_b, workspace_id="ws1", actor="alice"))["graph_id"]

    async def check(branch_id, viewer=ALICE, *, write, ds=ds_a):
        await svc.check_view_branch(data_source_id=ds, branch_id=branch_id, viewer=viewer, write=write)

    # ── the owner's private draft, on its own graph only ────────────────────
    d = await svc.open_draft(graph_id=ga, owner="alice")
    await check(d, write=False)
    await check(d, write=True)
    for ds in (ds_b, None):
        with pytest.raises(ValueError):
            await check(d, write=False, ds=ds)
    with pytest.raises(ValueError):
        await check("br_" + os.urandom(4).hex(), write=False)

    # ── main: the published view; never written through a view route ───────
    main = await svc.main_branch_id(ga)
    await check(main, BOB, write=False)
    with pytest.raises(MainWriteForbidden):
        await check(main, write=True)

    # ── someone else's private draft is unknown, except to a manager ────────
    with pytest.raises(ValueError):
        await check(d, BOB, write=False)
    await check(d, Viewer("bob", can_manage=True), write=False)
    with pytest.raises(NotDraftOwner):                # …who reads it, but does not write it
        await check(d, Viewer("bob", can_manage=True), write=True)

    # ── a shared draft: a viewer reads it, an editor writes it ──────────────
    sd = await svc.open_draft(graph_id=ga, owner="alice", shared=True)
    for who, role in (("bob", "viewer"), ("carol", "editor")):
        await svc.add_branch_member(graph_id=ga, branch_id=sd, subject_type="user",
                                    subject_id=who, role=role, actor="alice")
    await check(sd, BOB, write=False)
    with pytest.raises(AccessDenied):
        await check(sd, BOB, write=True)
    await check(sd, CAROL, write=True)

    # ── closed drafts still read (a tab on them must load) but refuse writes ─
    await svc.abandon_draft(graph_id=ga, branch_id=d, actor="alice")
    await check(d, write=False)
    with pytest.raises(BranchNotOpen) as closed:
        await check(d, write=True)
    assert closed.value.status == "abandoned"

    d2 = await svc.open_draft(graph_id=ga, owner="alice")
    await svc.stage_changes(graph_id=ga, branch_id=d2, actor="alice", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "N",
         "payload": {"entityType": "Dataset", "displayName": "N"}}])
    await svc.checkpoint(graph_id=ga, branch_id=d2, actor="alice")
    await svc.publish(graph_id=ga, branch_id=d2, actor="alice", message="ship")
    with pytest.raises(BranchNotOpen) as merged:
        await check(d2, write=True)
    assert merged.value.status == "merged"

    # ── a deleted graph's drafts are gone, even to their owner ──────────────
    db_draft = await svc.open_draft(graph_id=gb, owner="alice")
    await check(db_draft, write=False, ds=ds_b)
    async with db.graphver_session() as s:
        await s.execute(update(GraphORM).where(GraphORM.id == gb).values(deleted_at="2026-10-17T00:00:00Z"))
    with pytest.raises(ValueError):
        await check(db_draft, write=False, ds=ds_b)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_check_view_branch_live():
    asyncio.run(_run())
