"""Shared-draft OCC (P7) — needs Postgres.

A shared draft field-merges concurrent edits from different collaborators:
disjoint fields union, a same-field clash raises MergeConflict (settled via
`resolutions`). A single actor's sequential edits keep last-writer-wins, and a
private draft is unaffected.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import (
    AccessDenied,
    GraphVersioningService,
    MergeConflict,
)


def _node(name, **kw):
    return {"entityType": "T", "displayName": name, **kw}


def _upd(eid, actor, **kw):
    return {"op": "update", "entity_kind": "node", "entity_id": eid, "payload": _node(eid, **kw)}


async def _seed(svc, gid, branch, x, y):
    await svc.stage_changes(graph_id=gid, branch_id=branch, actor="alice", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "E", "payload": _node("E", x=x, y=y)}])
    await svc.checkpoint(graph_id=gid, branch_id=branch, actor="alice")


async def _x(svc, gid, branch, eid="E"):
    st = await svc.materialize_state(graph_id=gid, branch_id=branch)
    return st["nodes"][eid]


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]

    # ── shared draft: disjoint-field concurrent edits auto-merge ─────────
    d = await svc.open_draft(graph_id=gid, owner="alice", shared=True)
    await svc.add_branch_member(graph_id=gid, branch_id=d, subject_type="user",
                                subject_id="bob", role="editor", actor="alice")
    assert {m["subjectId"] for m in await svc.list_branch_members(graph_id=gid, branch_id=d)} == {"bob"}
    await _seed(svc, gid, d, x=0, y=0)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[_upd("E", "alice", x=1, y=0)])
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="bob",   ops=[_upd("E", "bob",   x=0, y=2)])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    merged = await _x(svc, gid, d)
    assert (merged["x"], merged["y"]) == (1, 2), merged          # both edits survived

    # ── same-field clash → MergeConflict, then settle via resolutions ────
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[_upd("E", "alice", x=5, y=2)])
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="bob",   ops=[_upd("E", "bob",   x=9, y=2)])
    with pytest.raises(MergeConflict) as ei:
        await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    assert ei.value.conflicts[0]["entity_id"] == "E"
    assert ei.value.conflicts[0]["path"] == ["x"]
    # the staged changes survived the rollback; resolve and re-checkpoint
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice",
                         resolutions={"E": _node("E", x=7, y=2)})
    assert (await _x(svc, gid, d))["x"] == 7

    # ── single actor in a shared draft → last-writer-wins, no false clash ─
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[_upd("E", "alice", x=10, y=2)])
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[_upd("E", "alice", x=20, y=2)])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice")
    assert (await _x(svc, gid, d))["x"] == 20

    # ── access control: viewer/non-member can't edit; only maintainer publishes ─
    await svc.add_branch_member(graph_id=gid, branch_id=d, subject_type="user",
                                subject_id="carol", role="viewer", actor="alice")
    with pytest.raises(AccessDenied):                                  # viewer can't edit
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="carol", ops=[_upd("E", "carol", x=99, y=2)])
    with pytest.raises(AccessDenied):                                  # non-member can't edit
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="dave", ops=[_upd("E", "dave", x=99, y=2)])
    with pytest.raises(AccessDenied):                                  # editor can't manage members
        await svc.add_branch_member(graph_id=gid, branch_id=d, subject_type="user",
                                    subject_id="z", role="viewer", actor="bob")
    with pytest.raises(AccessDenied):                                  # editor can't publish
        await svc.publish(graph_id=gid, branch_id=d, actor="bob", message="no")
    # group membership resolves via actor_groups: erin edits as a member of "eng"
    await svc.add_branch_member(graph_id=gid, branch_id=d, subject_type="group",
                                subject_id="eng", role="editor", actor="alice")
    with pytest.raises(AccessDenied):                                  # ...but not without the group
        await svc.stage_changes(graph_id=gid, branch_id=d, actor="erin", ops=[_upd("E", "erin", x=33, y=2)])
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="erin", actor_groups=["eng"],
                            ops=[_upd("E", "erin", x=33, y=2)])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice", actor_groups=())
    assert (await _x(svc, gid, d))["x"] == 33
    assert await svc.publish(graph_id=gid, branch_id=d, actor="alice", message="ship")  # owner/maintainer

    # ── private draft is unaffected (clobber, no conflict) ───────────────
    p = await svc.open_draft(graph_id=gid, owner="alice", shared=False)
    await _seed(svc, gid, p, x=0, y=0)
    await svc.stage_changes(graph_id=gid, branch_id=p, actor="alice", ops=[_upd("E", "alice", x=1, y=0)])
    await svc.stage_changes(graph_id=gid, branch_id=p, actor="bob",   ops=[_upd("E", "bob",   x=0, y=2)])
    await svc.checkpoint(graph_id=gid, branch_id=p, actor="alice")     # no raise
    clob = await _x(svc, gid, p)
    assert (clob["x"], clob["y"]) == (0, 2), clob                      # bob (last) clobbered

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_shared_occ_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning shared-draft OCC e2e: OK")
