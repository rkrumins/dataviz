"""Restore main to an earlier commit (point-in-time rollback) — needs Postgres.

restore_to_commit resets main to its state at commit K as ONE new ``restore``
commit: entities modified after K return to their at-K values, entities created
after K are tombstoned, entities deleted after K are resurrected. There is NO
conflict path (a restore overrides everything after K by definition) — which is
exactly the escape hatch for a revert that raises MergeConflict. restore_preview
returns the same delta as counts, without writing.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import CommitORM, ProjectionStateORM
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


def _del(eid):
    return {"op": "delete", "entity_kind": "node", "entity_id": eid}


def _e(eid, src, tgt):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "R", "sourceEntityId": src, "targetEntityId": tgt}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = lambda: "ds_" + os.urandom(4).hex()

    # ══ A. restore rolls back modify + create + delete in one commit ══════
    P = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    pg, pmain = P["graph_id"], P["main_branch_id"]
    c1 = await _edit_publish(svc, pg, "alice", [_n("A", f=1), _n("B", f=1), _n("D", f=1)], "seed")
    await _edit_publish(svc, pg, "alice", [_upd("A", f=2), _n("C")], "edit")
    await _edit_publish(svc, pg, "alice", [_del("D")], "drop D")
    m = await svc.materialize_state(graph_id=pg, branch_id=pmain)
    assert m["nodes"]["A"]["f"] == 2 and "C" in m["nodes"] and "D" not in m["nodes"]

    # Preview BEFORE the write — counts must equal what the restore then does.
    pv = await svc.restore_preview(graph_id=pg, commit_id=c1)
    assert pv["commitsUndone"] == 2, pv
    assert pv["nodes"] == {"create": 1, "update": 1, "delete": 1}, pv  # D back, A back, C gone
    assert pv["edges"] == {"create": 0, "update": 0, "delete": 0}, pv

    rid = await svc.restore_to_commit(graph_id=pg, commit_id=c1, actor="bob")
    m = await svc.materialize_state(graph_id=pg, branch_id=pmain)
    assert m["nodes"]["A"]["f"] == 1, m                     # later modify rolled back
    assert set(m["nodes"]) == {"A", "B", "D"}, m            # C tombstoned, D resurrected
    async with db.graphver_session() as s:
        row = await s.get(CommitORM, (pg, rid))
        assert row.kind == "restore"
        assert row.source_commit_ids == [c1]                # provenance
        assert row.stats == {"create": 1, "update": 1, "delete": 1}
        g = await s.get(models.GraphORM, pg)
        ps = await s.get(ProjectionStateORM, pg)
        assert ps.target_commit_seq == g.main_head_commit_seq  # projection scheduled

    # A restore is itself just a commit — restoring again to it is a no-op.
    assert await svc.restore_to_commit(graph_id=pg, commit_id=rid, actor="bob") == ""

    # ══ B. edges created after K disappear with their nodes (no dangling) ══
    Q = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    qg, qmain = Q["graph_id"], Q["main_branch_id"]
    cq1 = await _edit_publish(svc, qg, "alice", [_n("A"), _n("B")], "seed")
    await _edit_publish(svc, qg, "alice", [_n("C"), _e("E", "A", "C")], "C + edge")
    await svc.restore_to_commit(graph_id=qg, commit_id=cq1, actor="bob")
    m = await svc.materialize_state(graph_id=qg, branch_id=qmain)
    assert set(m["nodes"]) == {"A", "B"} and m["edges"] == {}, m

    # ══ C. escape hatch: conflicted revert restores cleanly via the target ═
    R = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    rg, rmain = R["graph_id"], R["main_branch_id"]
    cr1 = await _edit_publish(svc, rg, "alice", [_n("A", f=1)], "seed")
    cr2 = await _edit_publish(svc, rg, "alice", [_upd("A", f=2)], "f=2")
    await _edit_publish(svc, rg, "alice", [_upd("A", f=3)], "f=3")
    with pytest.raises(MergeConflict):                      # revert of the middle commit conflicts
        await svc.revert_commit(graph_id=rg, commit_id=cr2, actor="bob")
    await svc.restore_to_commit(graph_id=rg, commit_id=cr1, actor="bob")   # restore never conflicts
    assert (await svc.materialize_state(graph_id=rg, branch_id=rmain))["nodes"]["A"]["f"] == 1

    # ══ D. restore to genesis empties the graph; restore of a restore works ═
    S = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    sg, smain, sgen = S["graph_id"], S["main_branch_id"], S["genesis_commit_id"]
    cs1 = await _edit_publish(svc, sg, "alice", [_n("A"), _n("B"), _e("E", "A", "B")], "seed")
    await svc.restore_to_commit(graph_id=sg, commit_id=sgen, actor="bob")
    m = await svc.materialize_state(graph_id=sg, branch_id=smain)
    assert m["nodes"] == {} and m["edges"] == {}, m
    # The wipe is itself restorable — roll forward to the seeded state again.
    await svc.restore_to_commit(graph_id=sg, commit_id=cs1, actor="bob")
    m = await svc.materialize_state(graph_id=sg, branch_id=smain)
    assert set(m["nodes"]) == {"A", "B"} and set(m["edges"]) == {"E"}, m

    # ══ E. fork path (CoW state replay) ════════════════════════════════════
    # A restore target must be one of the fork's OWN commits (its base lives in
    # the parent) — restore fork commit 2 back to fork commit 1 and check the
    # CoW-composed base (parent state) survives underneath.
    F = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    fg = F["graph_id"]
    await _edit_publish(svc, fg, "alice", [_n("A", f=1), _n("P")], "seed")
    fork = await svc.fork_graph(parent_graph_id=fg, data_source_id=ds(), actor="carol",
                                workspace_id="ws1")
    fkg, fkmain = fork["graph_id"], fork["main_branch_id"]
    fc1 = await _edit_publish(svc, fkg, "carol", [_upd("A", f=5)], "fork edit 1")
    await _edit_publish(svc, fkg, "carol", [_upd("A", f=9), _n("Z")], "fork edit 2")
    m = await svc.materialize_state(graph_id=fkg, branch_id=fkmain)
    assert m["nodes"]["A"]["f"] == 9 and "Z" in m["nodes"]
    await svc.restore_to_commit(graph_id=fkg, commit_id=fc1, actor="carol")
    m = await svc.materialize_state(graph_id=fkg, branch_id=fkmain)
    assert m["nodes"]["A"]["f"] == 5 and "Z" not in m["nodes"], m
    assert "P" in m["nodes"], m                              # CoW base intact
    # Parent untouched throughout.
    mp = await svc.materialize_state(graph_id=fg, branch_id=F["main_branch_id"])
    assert mp["nodes"]["A"]["f"] == 1

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_restore_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning restore e2e: OK")
