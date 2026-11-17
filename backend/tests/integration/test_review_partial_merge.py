"""A draft's review decided change by change, against Postgres: accepting a change accepts what it
needs (a new edge, the new entity it joins and that entity's link to its parent); rejecting one
rejects what needs it, with a reason; reversing a decision a change takes with it is refused
unless forced; an edit since makes a decision stale. A review with a rejection merges only what is
accepted: main gets exactly that, the draft stays open with the rest — which then merges on its
own review — and the decisions are purged with the graph."""
import asyncio
import os

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.change_index import ChangeOrigin
from backend.app.services.versioning.errors import (ChangesRejected, DecisionConflict, NothingAccepted,
                                                    ReviewIncomplete)
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]


def _n(eid, name, desc="", op="create"):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name, "description": desc}}


def _e(eid, s, t, etype="CONTAINS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _changes(svc, gid, branch):
    page = await svc.change_entries(graph_id=gid, origin=ChangeOrigin(branch_id=branch),
                                    containment_edge_types=CONT, limit=100)
    return {e["entityId"]: e["status"] for e in page["entries"]}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = G["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", containment_edge_types=CONT, ops=[
        _n("DB", "warehouse"), _n("T1", "orders"), _n("T2", "sales"),
        _e("c1", "DB", "T1"), _e("c2", "DB", "T2")])
    d = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[
        _n("T1", "orders", "Daily orders", op="update"), _n("T2", "Sales", op="update"),
        _n("T3", "refunds"), _e("c3", "DB", "T3"), _e("f1", "T1", "T3", "FEEDS")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    pr_id = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="ana", title="Refunds")
    assert set(await _changes(svc, gid, d)) == {"T1", "T2", "T3", "c3", "f1"}

    # Accepting the new edge accepts the new entity it joins, and that entity's link to its parent.
    dry = await svc.decide_changes(pr_id=pr_id, actor="bo", verdict="accepted", entity_ids=["f1"],
                                   containment_edge_types=CONT, dry_run=True)
    assert dry["dryRun"] and {i["entityId"] for i in dry["implied"]} == {"T3", "c3"}
    summary = await svc.review_decision_summary(pr_id=pr_id, containment_edge_types=CONT)
    assert summary["accepted"] == 0 and summary["undecided"] == 5          # a dry run decided nothing
    await svc.decide_changes(pr_id=pr_id, actor="bo", verdict="accepted", entity_ids=["f1"],
                             containment_edge_types=CONT, expected_head_commit_id=summary["headCommitId"])
    # Rejecting the new entity would reject the edge accepted with it: refused, unless forced.
    with pytest.raises(DecisionConflict) as conflict:
        await svc.decide_changes(pr_id=pr_id, actor="bo", verdict="rejected", entity_ids=["T3"],
                                 containment_edge_types=CONT)
    assert {o["entityId"] for o in conflict.value.overrides} == {"f1", "c3"}
    await svc.decide_changes(pr_id=pr_id, actor="bo", verdict="rejected", entity_ids=["T2"],
                             reason="Keep the lowercase name", containment_edge_types=CONT)
    summary = await svc.review_decision_summary(pr_id=pr_id, containment_edge_types=CONT)
    assert (summary["accepted"], summary["rejected"], summary["undecided"], summary["missing"]) == (3, 1, 1, 0)
    page = await svc.review_change_entries(pr_id=pr_id, containment_edge_types=CONT, decision="rejected")
    [t2] = page["entries"]
    assert t2["entityId"] == "T2" and t2["decision"]["reason"] == "Keep the lowercase name"
    undecided = await svc.review_change_entries(pr_id=pr_id, containment_edge_types=CONT, decision="undecided")
    assert [e["entityId"] for e in undecided["entries"]] == ["T1"]
    # "Accept all shown" of the undecided ones decides just those.
    shown = await svc.decide_changes(pr_id=pr_id, actor="bo", verdict="accepted", containment_edge_types=CONT,
                                     filter={"decision": "undecided"}, dry_run=True)
    assert shown["decided"] == 1

    # An edit since makes a decision stale.
    await svc.decide_changes(pr_id=pr_id, actor="bo", verdict="accepted", entity_ids=["T1"], containment_edge_types=CONT)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_n("T1", "orders", "Daily orders, net", op="update")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    summary = await svc.review_decision_summary(pr_id=pr_id, containment_edge_types=CONT)
    assert (summary["accepted"], summary["stale"]) == (3, 1)
    stale = await svc.review_change_entries(pr_id=pr_id, containment_edge_types=CONT, decision="stale")
    assert [e["entityId"] for e in stale["entries"]] == ["T1"]

    # What is accepted needs a change whose acceptance went stale: named, not merged.
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_n("T3", "refunds", "Returns", op="update")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    with pytest.raises(ReviewIncomplete) as incomplete:
        await svc.merge_mr(mr_id=pr_id, actor="cy", message="Refunds", containment_edge_types=CONT, mode="accepted")
    assert incomplete.value.needs == ["T3"]
    await svc.decide_changes(pr_id=pr_id, actor="bo", verdict="accepted", entity_ids=["T3"], containment_edge_types=CONT)

    # A review with a rejection merges only what is accepted.
    with pytest.raises(ChangesRejected):
        await svc.merge_mr(mr_id=pr_id, actor="cy", message="all", containment_edge_types=CONT)
    commit_id = await svc.merge_mr(mr_id=pr_id, actor="cy", message="Refunds", containment_edge_types=CONT,
                                   mode="accepted")
    assert commit_id
    async with db.graphver_session() as s:
        row = await s.get(models.MergeRequestORM, pr_id)
        assert (row.status, row.merged_via) == ("merged", "review_partial")
        draft = await s.get(models.BranchORM, d)
        assert draft.status == "open"
        g = await s.get(models.GraphORM, gid)
        assert draft.base_commit_seq == g.main_head_commit_seq
    # Main has exactly what was accepted.
    window = await svc.change_entries(graph_id=gid, origin=ChangeOrigin(from_seq=g.main_head_commit_seq - 1,
                                                                        to_seq=g.main_head_commit_seq),
                                      containment_edge_types=CONT)
    assert {e["entityId"]: e["status"] for e in window["entries"]} == {"T3": "added", "c3": "added", "f1": "added"}
    # The draft keeps the rest, and still reads whole.
    assert await _changes(svc, gid, d) == {"T1": "modified", "T2": "modified"}
    state = await svc.entity_indexes(graph_id=gid, branch_id=d)
    assert {"T1", "T2", "T3", "DB"} <= state["node_eids"] and {"c3", "f1"} <= state["edge_eids"]

    # The rest merges on a review of its own; nothing accepted there merges nothing in part.
    pr2 = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="ana", title="The rest")
    with pytest.raises(NothingAccepted):
        await svc.merge_mr(mr_id=pr2, actor="cy", message="none", containment_edge_types=CONT, mode="accepted")
    await svc.merge_mr(mr_id=pr2, actor="cy", message="The rest", containment_edge_types=CONT)
    async with db.graphver_session() as s:
        assert (await s.get(models.BranchORM, d)).status == "merged"
        n = await s.scalar(select(func.count()).select_from(models.ReviewDecisionORM).where(
            models.ReviewDecisionORM.graph_id == gid))
        assert n == 5
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_review_partial_merge_e2e():
    asyncio.run(_run())
