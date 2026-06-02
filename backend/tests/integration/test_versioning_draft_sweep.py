"""Auto-abandon idle drafts (P13) — needs Postgres.

sweep_idle_drafts abandons open drafts whose updated_at is older than the TTL,
leaving fresh drafts, already-terminal branches, and main untouched. It is global
(a janitor across all graphs). The worker runs it on a timer; here we drive
sweep_once directly, which is all the worker loop adds.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import update

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import BranchORM
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.services.versioning.worker import ProjectionWorker


def _n(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid}}


async def _backdate(bid: str, days: int) -> None:
    old = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    async with db.graphver_session() as s:
        await s.execute(update(BranchORM).where(BranchORM.id == bid).values(updated_at=old))


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

    await _backdate(stale, 60)
    await _backdate(merged, 60)                                   # idle but already merged
    await _backdate(main, 60)                                     # main is not a draft

    # only the idle, still-open draft is abandoned
    assert await svc.sweep_idle_drafts(ttl_days=30) == [stale]

    by_id = {b["branch_id"]: b for b in await svc.list_branches(graph_id=gid)}
    assert by_id[stale]["status"] == "abandoned"
    assert by_id[fresh]["status"] == "open"
    assert by_id[merged]["status"] == "merged"
    assert by_id[main]["kind"] == "main" and by_id[main]["status"] == "open"

    # idempotent: nothing stale-open remains
    assert await svc.sweep_idle_drafts(ttl_days=30) == []

    # a draft idle by less than the TTL is left alone
    young = await svc.open_draft(graph_id=gid, owner="alice")
    await _backdate(young, 10)
    assert await svc.sweep_idle_drafts(ttl_days=30) == []
    assert young not in [b["branch_id"] for b in await svc.list_branches(graph_id=gid)
                         if b["status"] == "abandoned"]

    # worker wiring: no service → no-op; a wired service → delegates (default TTL)
    assert await ProjectionWorker(None, versioning=None).sweep_once() == []
    aged = await svc.open_draft(graph_id=gid, owner="alice")
    await _backdate(aged, 60)
    assert await ProjectionWorker(None, versioning=svc).sweep_once() == [aged]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_sweep_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft-sweep e2e: OK")
