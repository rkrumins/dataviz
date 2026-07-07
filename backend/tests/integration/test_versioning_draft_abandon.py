"""Draft abandonment (P11) — needs Postgres.

abandon_draft marks an open draft inert: no further stage/checkpoint/publish.
Re-abandoning is idempotent; main and already-merged drafts cannot be abandoned;
a shared draft requires a maintainer (an editor cannot abandon it).
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import AccessDenied, GraphVersioningService


def _n(eid):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid}}


async def _stage(svc, gid, bid, actor, eid):
    await svc.stage_changes(graph_id=gid, branch_id=bid, actor=actor, ops=[_n(eid)])


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]

    # ── solo draft: abandon makes every mutating op inert ───────────────────
    d = await svc.open_draft(graph_id=gid, owner="alice")
    await _stage(svc, gid, d, "alice", "A")
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    assert (await svc.abandon_draft(graph_id=gid, branch_id=d, actor="alice"))["status"] == "abandoned"

    with pytest.raises(ValueError):
        await _stage(svc, gid, d, "alice", "B")
    with pytest.raises(ValueError):
        await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    with pytest.raises(ValueError):
        await svc.publish(graph_id=gid, branch_id=d, actor="alice", message="x")

    # re-abandon is idempotent; the branch listing reflects the status
    assert (await svc.abandon_draft(graph_id=gid, branch_id=d, actor="alice"))["status"] == "abandoned"
    branches = {b["branch_id"]: b for b in await svc.list_branches(graph_id=gid)}
    assert branches[d]["status"] == "abandoned"

    # ── cannot abandon main, nor an already-merged draft ────────────────────
    main = await svc.main_branch_id(gid)
    with pytest.raises(ValueError):
        await svc.abandon_draft(graph_id=gid, branch_id=main, actor="alice")

    d2 = await svc.open_draft(graph_id=gid, owner="alice")
    await _stage(svc, gid, d2, "alice", "C")
    await svc.checkpoint(graph_id=gid, branch_id=d2, actor="alice")
    await svc.publish(graph_id=gid, branch_id=d2, actor="alice", message="ship")   # → merged
    with pytest.raises(ValueError):
        await svc.abandon_draft(graph_id=gid, branch_id=d2, actor="alice")

    # ── shared draft: an editor cannot abandon; the maintainer can ──────────
    sd = await svc.open_draft(graph_id=gid, owner="alice", shared=True)
    await svc.add_branch_member(graph_id=gid, branch_id=sd, subject_type="user",
                                subject_id="bob", role="editor", actor="alice")
    with pytest.raises(AccessDenied):
        await svc.abandon_draft(graph_id=gid, branch_id=sd, actor="bob")
    assert (await svc.abandon_draft(graph_id=gid, branch_id=sd, actor="alice"))["status"] == "abandoned"

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_abandon_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft-abandon e2e: OK")
