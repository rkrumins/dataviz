"""End-to-end integration test for the versioning write path (needs Postgres).

Exercises the full Postgres-first flow against a live ``graphver`` store:
blank canvas → draft → stage → checkpoint → squash publish, plus contributor
attribution, entity history, commit diff, the stale-publish concurrency guard,
and the referential-integrity guard.

Skipped unless ``GRAPHVER_E2E=1`` is set (and a Postgres is reachable via
``GRAPHVER_DB_URL``/``MANAGEMENT_DB_URL``), so it never runs in the unit lane.
Runs its own event loop, so it needs no pytest-asyncio plugin.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import (
    GraphVersioningService,
    MergeConflict,
)


async def _run_flow() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    def ds() -> str:
        return "ds_" + os.urandom(4).hex()

    # blank canvas → shared draft (alice + bob) → checkpoints
    g = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    gid = g["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="alice", originating_view_id="view_lineage")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "Alpha", "entityType": "Dataset"}},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": {"displayName": "Beta", "entityType": "Dataset"}},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B"}},
    ])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice", message="seed")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="bob", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "Alpha v2", "entityType": "Dataset"}},
        {"op": "create", "entity_kind": "node", "entity_id": "C", "payload": {"displayName": "Gamma"}},
    ])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="bob", message="rename A, add C")

    state = await svc.materialize_state(graph_id=gid, branch_id=d)
    assert set(state["nodes"]) == {"A", "B", "C"} and set(state["edges"]) == {"E1"}

    # squash publish carries multi-author attribution + originating view
    sq = await svc.publish(graph_id=gid, branch_id=d, actor="alice", message="Publish Q4")
    async with db.graphver_session() as s:
        cmt = await s.get(models.CommitORM, (gid, sq))
        graph = await s.get(models.GraphORM, gid)
    assert graph.main_head_commit_seq == 2
    assert cmt.contributors == ["alice", "bob"]
    assert cmt.source_commit_count == 2
    assert cmt.originating_view_id == "view_lineage"

    main = await svc.main_branch_id(gid)
    ms = await svc.materialize_state(graph_id=gid, branch_id=main)
    assert ms["nodes"]["A"]["displayName"] == "Alpha v2"

    # entity history (tier 1) + commit diff
    hist = [h["op"] for h in await svc.entity_history(graph_id=gid, entity_id="A")]
    assert "create" in hist and "update" in hist
    diff = await svc.diff_commits(graph_id=gid, branch_id=main, from_seq=1, to_seq=2)
    assert set(diff["added"]) == {"A", "B", "C", "E1"}

    # stale draft auto-rebases onto an advanced main (non-overlapping → no conflict)
    g2 = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    gid2 = g2["graph_id"]
    da = await svc.open_draft(graph_id=gid2, owner="alice")
    dbob = await svc.open_draft(graph_id=gid2, owner="bob")  # both based on seq 1
    await svc.stage_changes(graph_id=gid2, branch_id=da, actor="alice", ops=[{"op": "create", "entity_kind": "node", "entity_id": "X", "payload": {"displayName": "X"}}])
    await svc.checkpoint(graph_id=gid2, branch_id=da, actor="alice")
    await svc.publish(graph_id=gid2, branch_id=da, actor="alice", message="A adds X")   # main -> 2
    await svc.stage_changes(graph_id=gid2, branch_id=dbob, actor="bob", ops=[{"op": "create", "entity_kind": "node", "entity_id": "Y", "payload": {"displayName": "Y"}}])
    await svc.checkpoint(graph_id=gid2, branch_id=dbob, actor="bob")
    await svc.publish(graph_id=gid2, branch_id=dbob, actor="bob", message="B rebases, adds Y")
    rebased = await svc.materialize_state(graph_id=gid2, branch_id=await svc.main_branch_id(gid2))
    assert set(rebased["nodes"]) == {"X", "Y"}, rebased

    # cascade delete: deleting a node tombstones its incident edges in the same commit
    g3 = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    gid3 = g3["graph_id"]
    d3 = await svc.open_draft(graph_id=gid3, owner="alice")
    await svc.stage_changes(graph_id=gid3, branch_id=d3, actor="alice", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A"}},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": {"displayName": "B"}},
        {"op": "create", "entity_kind": "edge", "entity_id": "E", "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": "A", "targetEntityId": "B"}},
    ])
    await svc.checkpoint(graph_id=gid3, branch_id=d3, actor="alice")
    await svc.publish(graph_id=gid3, branch_id=d3, actor="alice", message="seed")
    d3b = await svc.open_draft(graph_id=gid3, owner="alice")
    await svc.stage_changes(graph_id=gid3, branch_id=d3b, actor="alice", ops=[{"op": "delete", "entity_kind": "node", "entity_id": "B"}])
    await svc.checkpoint(graph_id=gid3, branch_id=d3b, actor="alice")
    await svc.publish(graph_id=gid3, branch_id=d3b, actor="alice", message="delete B")
    m3 = await svc.materialize_state(graph_id=gid3, branch_id=await svc.main_branch_id(gid3))
    assert set(m3["nodes"]) == {"A"} and m3["edges"] == {}, m3   # B gone; edge E cascaded

    # rebase auto-merge: two drafts from the same base edit DIFFERENT fields.
    g4 = await svc.create_graph(data_source_id=ds(), workspace_id="ws1", actor="alice")
    gid4 = g4["graph_id"]
    main4 = await svc.main_branch_id(gid4)
    seed = await svc.open_draft(graph_id=gid4, owner="alice")
    await svc.stage_changes(graph_id=gid4, branch_id=seed, actor="alice", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f1": 1, "f2": 1}}])
    await svc.checkpoint(graph_id=gid4, branch_id=seed, actor="alice")
    await svc.publish(graph_id=gid4, branch_id=seed, actor="alice", message="seed A")     # main 2
    d1 = await svc.open_draft(graph_id=gid4, owner="alice")
    d2 = await svc.open_draft(graph_id=gid4, owner="bob")                                  # both based on seq 2
    await svc.stage_changes(graph_id=gid4, branch_id=d1, actor="alice", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f1": 2, "f2": 1}}])
    await svc.checkpoint(graph_id=gid4, branch_id=d1, actor="alice")
    await svc.publish(graph_id=gid4, branch_id=d1, actor="alice", message="d1 sets f1")    # main 3
    await svc.stage_changes(graph_id=gid4, branch_id=d2, actor="bob", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f1": 1, "f2": 9}}])
    await svc.checkpoint(graph_id=gid4, branch_id=d2, actor="bob")
    assert (await svc.preview_merge(graph_id=gid4, branch_id=d2))["clean"] is True
    await svc.publish(graph_id=gid4, branch_id=d2, actor="bob", message="d2 sets f2 (rebased)")  # main 4
    A = (await svc.materialize_state(graph_id=gid4, branch_id=main4))["nodes"]["A"]
    assert A["f1"] == 2 and A["f2"] == 9, A           # both non-overlapping edits survived

    # conflict on the SAME field → surfaced, then resolved.
    e1 = await svc.open_draft(graph_id=gid4, owner="alice")
    e2 = await svc.open_draft(graph_id=gid4, owner="bob")             # both based on seq 4
    await svc.stage_changes(graph_id=gid4, branch_id=e1, actor="alice", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f1": 10, "f2": 9}}])
    await svc.checkpoint(graph_id=gid4, branch_id=e1, actor="alice")
    await svc.publish(graph_id=gid4, branch_id=e1, actor="alice", message="e1 f1=10")      # main 5
    await svc.stage_changes(graph_id=gid4, branch_id=e2, actor="bob", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f1": 20, "f2": 9}}])
    await svc.checkpoint(graph_id=gid4, branch_id=e2, actor="bob")
    prev = await svc.preview_merge(graph_id=gid4, branch_id=e2)
    assert prev["clean"] is False and prev["conflicts"][0]["path"] == ["f1"], prev
    with pytest.raises(MergeConflict):
        await svc.publish(graph_id=gid4, branch_id=e2, actor="bob", message="e2 f1=20")
    await svc.publish(graph_id=gid4, branch_id=e2, actor="bob", message="resolved",
                      resolutions={"A": {"displayName": "A", "f1": 99, "f2": 9}})          # main 6
    A2 = (await svc.materialize_state(graph_id=gid4, branch_id=main4))["nodes"]["A"]
    assert A2["f1"] == 99, A2

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_write_path_e2e():
    asyncio.run(_run_flow())


if __name__ == "__main__":
    asyncio.run(_run_flow())
    print("versioning e2e: OK")
