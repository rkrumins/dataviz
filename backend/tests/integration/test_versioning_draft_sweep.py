"""Auto-abandon idle drafts (P13) — needs Postgres.

sweep_idle_drafts abandons open drafts whose updated_at is older than the TTL,
leaving fresh drafts, already-terminal branches, and main untouched. It also leaves an
idle draft that is still in use: one with a live PR, one being published, one with
staged (uncheckpointed) work, and one on a deleted graph. It is global
(a janitor across all graphs). A frozen graph's drafts are not swept (nobody can touch them), and
after an unfreeze each gets a full TTL again. The worker runs it on a timer; here we drive
sweep_once directly, which is all the worker loop adds.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import update

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import BranchORM, GraphORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.worker import ProjectionWorker


def _n(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"entityType": "Dataset", "displayName": eid}}


async def _backdate(bid: str, days: int) -> None:
    old = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    async with db.graphver_session() as s:
        await s.execute(update(BranchORM).where(BranchORM.id == bid).values(updated_at=old))


async def _set(orm, row_id: str, **values) -> None:
    async with db.graphver_session() as s:
        await s.execute(update(orm).where(orm.id == row_id).values(**values))


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]
    main = await svc.main_branch_id(gid)

    stale = await svc.open_draft(graph_id=gid, owner="alice")     # idle → swept
    fresh = await svc.open_draft(graph_id=gid, owner="alice")     # recent → kept

    merged = await svc.open_draft(graph_id=gid, owner="alice")    # terminal → kept even if idle
    await svc.stage_changes(graph_id=gid, branch_id=merged, actor="alice", ops=[_n("A")])
    await svc.checkpoint(graph_id=gid, branch_id=merged, actor="alice")
    await svc.publish(graph_id=gid, branch_id=merged, actor="alice", message="ship")

    # idle, but still in use → kept
    in_review = await svc.open_draft(graph_id=gid, owner="alice")  # live PR
    await svc.stage_changes(graph_id=gid, branch_id=in_review, actor="alice", ops=[_n("R")])
    await svc.checkpoint(graph_id=gid, branch_id=in_review, actor="alice")
    await svc.open_draft_mr(graph_id=gid, branch_id=in_review, actor="alice")
    publishing = await svc.open_draft(graph_id=gid, owner="alice")  # mid-publish
    await _set(BranchORM, publishing, status="publishing")
    staged = await svc.open_draft(graph_id=gid, owner="alice")      # uncheckpointed work
    await svc.stage_changes(graph_id=gid, branch_id=staged, actor="alice", ops=[_n("S")])
    dead_gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                       workspace_id="ws1", actor="alice"))["graph_id"]
    orphan = await svc.open_draft(graph_id=dead_gid, owner="alice")  # graph deleted
    await _set(GraphORM, dead_gid, deleted_at=datetime.now(timezone.utc).isoformat())

    # idle, checkpointed work, its PR closed → nothing keeps it: swept
    done = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.stage_changes(graph_id=gid, branch_id=done, actor="alice", ops=[_n("D")])
    await svc.checkpoint(graph_id=gid, branch_id=done, actor="alice")
    await svc.close_pr(pr_id=await svc.open_draft_mr(graph_id=gid, branch_id=done, actor="alice"),
                       actor="alice")

    await _backdate(stale, 60)
    await _backdate(merged, 60)                                   # idle but already merged
    await _backdate(main, 60)                                     # main is not a draft
    for bid in (in_review, publishing, staged, orphan, done):
        await _backdate(bid, 60)

    # only the idle, still-open drafts nothing else is using are abandoned
    assert sorted(await svc.sweep_idle_drafts(ttl_days=30)) == sorted([stale, done])

    by_id = {b["branch_id"]: b for b in (await svc.list_branches(graph_id=gid, status=["all"]))[0]}
    assert by_id[stale]["status"] == "abandoned"
    assert by_id[fresh]["status"] == "open"
    assert by_id[merged]["status"] == "merged"
    assert by_id[main]["kind"] == "main" and by_id[main]["status"] == "open"
    assert by_id[done]["status"] == "abandoned"
    assert by_id[in_review]["status"] == "open"
    assert by_id[publishing]["status"] == "publishing"
    assert by_id[staged]["status"] == "open"
    async with db.graphver_session() as s:
        assert (await s.get(BranchORM, orphan)).status == "open"

    # idempotent: nothing stale-open remains
    assert await svc.sweep_idle_drafts(ttl_days=30) == []

    # a draft idle by less than the TTL is left alone
    young = await svc.open_draft(graph_id=gid, owner="alice")
    await _backdate(young, 10)
    assert await svc.sweep_idle_drafts(ttl_days=30) == []
    assert young not in [b["branch_id"] for b in (await svc.list_branches(graph_id=gid, status=["abandoned"]))[0]]

    # worker wiring: no service → no-op; a wired service → delegates (default TTL)
    assert await ProjectionWorker(None, versioning=None).sweep_once() == []
    aged = await svc.open_draft(graph_id=gid, owner="alice")
    await _backdate(aged, 60)
    assert await ProjectionWorker(None, versioning=svc).sweep_once() == [aged]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_sweep_e2e():
    asyncio.run(_run())


async def _frozen() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    paused, control = [(await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                               workspace_id="ws1", actor="alice"))["graph_id"]
                       for _ in range(2)]
    kept = await svc.open_draft(graph_id=paused, owner="alice")
    swept = await svc.open_draft(graph_id=control, owner="alice")      # never changed state
    await svc.set_frozen(graph_id=paused, frozen=True, expected_rev=0)
    for bid in (kept, swept):
        await _backdate(bid, 60)

    first = await svc.sweep_idle_drafts(ttl_days=30)
    assert swept in first and kept not in first, "nobody can touch a frozen graph's draft"
    await svc.set_frozen(graph_id=paused, frozen=False, expected_rev=1)
    assert kept not in await svc.sweep_idle_drafts(ttl_days=30), "a full TTL from the unfreeze"
    unfrozen = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
    await _set(GraphORM, paused, lifecycle_changed_at=unfrozen)
    assert kept in await svc.sweep_idle_drafts(ttl_days=30)
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_the_sweep_spares_drafts_of_a_frozen_or_just_unfrozen_graph():
    asyncio.run(_frozen())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft-sweep e2e: OK")
