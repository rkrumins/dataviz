"""Revert a published commit (P9) — needs Postgres.

revert_commit applies the inverse of a chosen commit as a new ``revert`` commit on
main: undo a create (delete), an update (restore prior value), and cascade to
incident edges. Reverting a commit whose entities were changed by a *later* commit
can't apply cleanly and raises MergeConflict.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import CommitORM
from backend.app.services.versioning.service import GraphVersioningService, MergeConflict


async def _edit_publish(svc, gid, actor, ops, msg):
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=gid, branch_id=d, actor=actor)
    return await svc.publish(graph_id=gid, branch_id=d, actor=actor, message=msg)


def _n(eid, **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, **kw}}


def _upd(eid, **kw):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": eid, **kw}}


def _e(eid, src, tgt):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "R", "sourceEntityId": src, "targetEntityId": tgt}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = lambda: "ds_" + os.urandom(4).hex()

    # ══ A. revert undoes an update + a create, as a new `revert` commit ═══
    P = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    pg, pmain = P["graph_id"], P["main_branch_id"]
    await _edit_publish(svc, pg, "alice", [_n("A", f=1), _n("B", f=1)], "seed")
    c2 = await _edit_publish(svc, pg, "alice", [_upd("A", f=2), _n("C")], "edit")
    assert (await svc.materialize_state(graph_id=pg, branch_id=pmain))["nodes"]["A"]["f"] == 2

    rid = await svc.revert_commit(graph_id=pg, commit_id=c2, actor="bob")
    m = await svc.materialize_state(graph_id=pg, branch_id=pmain)
    assert m["nodes"]["A"]["f"] == 1 and set(m["nodes"]) == {"A", "B"}, m   # A restored, C undone
    async with db.graphver_session() as s:
        assert (await s.get(CommitORM, (pg, rid))).kind == "revert"

    # ══ B. revert cascades: undoing a node-create drops a later edge to it ═
    Q = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    qg, qmain = Q["graph_id"], Q["main_branch_id"]
    await _edit_publish(svc, qg, "alice", [_n("A"), _n("B")], "seed")
    cC = await _edit_publish(svc, qg, "alice", [_n("C")], "add C")
    await _edit_publish(svc, qg, "alice", [_e("E", "A", "C")], "add edge to C")   # later commit
    await svc.revert_commit(graph_id=qg, commit_id=cC, actor="bob")              # deletes C
    m = await svc.materialize_state(graph_id=qg, branch_id=qmain)
    assert set(m["nodes"]) == {"A", "B"} and m["edges"] == {}, m                 # C gone, E cascaded

    # ══ C. reverting a stale commit conflicts; reverting the head is clean ═
    R = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    rg, rmain = R["graph_id"], R["main_branch_id"]
    await _edit_publish(svc, rg, "alice", [_n("A", f=1)], "seed")
    c2r = await _edit_publish(svc, rg, "alice", [_upd("A", f=2)], "f=2")
    c3r = await _edit_publish(svc, rg, "alice", [_upd("A", f=3)], "f=3")
    with pytest.raises(MergeConflict):                       # A changed by c3 after c2
        await svc.revert_commit(graph_id=rg, commit_id=c2r, actor="bob")
    await svc.revert_commit(graph_id=rg, commit_id=c3r, actor="bob")     # head revert: clean
    assert (await svc.materialize_state(graph_id=rg, branch_id=rmain))["nodes"]["A"]["f"] == 2

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_revert_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning revert e2e: OK")
