"""Discarding a draft's saved changes, and sending a review back, against Postgres:

* a restore is ONE ``restore`` commit that puts each chosen change back where the draft began — a
  new entity gone with its new links, a removed one back with the links it lost, an edit undone —
  and the change list no longer lists them; a dry run says what it would take, writing nothing; a
  stale head is refused;
* a review sent back does not merge until the draft changes (or the reviewer withdraws); approving
  withdraws the reviewer's own request."""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.change_index import ChangeOrigin
from backend.app.services.versioning.errors import ChangesRequested, DraftMoved
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]


def _n(eid, name, op="create", **props):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": name, "properties": props}}


def _e(eid, s, t, etype="CONTAINS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


def _del(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


async def _changed(svc, gid, d):
    page = await svc.change_entries(graph_id=gid, origin=ChangeOrigin(branch_id=d), containment_edge_types=CONT, limit=500)
    return {e["entityId"]: e["status"] for e in page["entries"]}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", containment_edge_types=CONT, ops=[
        _n("DB", "warehouse"), _n("T1", "orders"), _n("C1", "amount", unit="usd"), _n("C2", "legacy"),
        _e("e1", "DB", "T1"), _e("e4", "T1", "C1"), _e("e5", "T1", "C2")])
    d = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[
        _n("C1", "amount", op="update", unit="eur"), _del("C2"), _n("C3", "currency"), _e("e6", "T1", "C3")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    before = await _changed(svc, gid, d)
    assert before == {"C1": "modified", "C2": "removed", "C3": "added", "e5": "removed", "e6": "added"}

    # A dry run says what discarding the new column takes with it — its link — writing nothing.
    dry = await svc.restore_draft_changes(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT,
                                          entity_ids=["C3"], dry_run=True)
    assert dry["restored"] == 2 and dry["implied"] == [{"entityId": "e6", "impliedBy": "C3"}] and dry["commitId"] is None
    assert await _changed(svc, gid, d) == before
    # A stale head is refused.
    with pytest.raises(DraftMoved):
        await svc.restore_draft_changes(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT,
                                        entity_ids=["C3"], expected_head_commit_id="c_not_it")

    # One commit: the new column and its link gone, the removed column back with its link, the edit undone.
    out = await svc.restore_draft_changes(graph_id=gid, branch_id=d, actor="bo", containment_edge_types=CONT,
                                          entity_ids=["C3", "C2", "C1"], expected_head_commit_id=dry["headCommitId"])
    assert out["restored"] == 5 and out["commitId"]
    assert await _changed(svc, gid, d) == {}
    async with svc._session() as s:
        from backend.app.services.versioning.models import CommitORM
        c = await s.get(CommitORM, (gid, out["commitId"]))
        assert c.kind == "restore" and c.branch_id == d and c.actor == "bo"

    # Sent back: the review waits for the draft to change, then merges.
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_n("C1", "amount", op="update", unit="gbp")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    pr = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="ana", title="Units")
    meta = await svc.request_changes(pr_id=pr, actor="bo", reason="Use ISO codes")
    assert meta["changes_requested"]["by"] == "bo" and meta["changes_requested"]["reason"] == "Use ISO codes"
    with pytest.raises(ChangesRequested):
        await svc.merge_mr(mr_id=pr, actor="bo", message="Units", containment_edge_types=CONT)
    # Approving withdraws the reviewer's own request …
    meta = await svc.approve_pr(pr_id=pr, actor="bo")
    assert meta["changes_requested"] is None
    await svc.request_changes(pr_id=pr, actor="bo", reason="Still not ISO")
    # … and so does the author changing the draft.
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[_n("C1", "amount", op="update", unit="GBP")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    async with svc._session() as s:
        from backend.app.services.versioning.models import MergeRequestORM
        assert (await svc._pr_meta(s, await s.get(MergeRequestORM, pr)))["changes_requested"] is None
    assert await svc.merge_mr(mr_id=pr, actor="bo", message="Units", containment_edge_types=CONT)

    # Merge what is accepted, then discard what was rejected: nothing undecided stays behind.
    d2 = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d2, actor="ana", ops=[
        _n("T1", "Orders", op="update"), _n("C4", "fx_rate"), _e("e7", "T1", "C4")])
    await svc.checkpoint(graph_id=gid, branch_id=d2, actor="ana", containment_edge_types=CONT)
    pr2 = await svc.open_draft_mr(graph_id=gid, branch_id=d2, actor="ana", title="Rates")
    await svc.decide_changes(pr_id=pr2, actor="bo", verdict="accepted", entity_ids=["T1"], containment_edge_types=CONT)
    await svc.decide_changes(pr_id=pr2, actor="bo", verdict="rejected", entity_ids=["C4"], reason="Not yet",
                             containment_edge_types=CONT)
    await svc.merge_mr(mr_id=pr2, actor="bo", message="Rates", containment_edge_types=CONT, mode="accepted")
    assert set(await _changed(svc, gid, d2)) == {"C4", "e7"}
    out = await svc.discard_rejected(pr_id=pr2, actor="bo", containment_edge_types=CONT)
    assert out["restored"] == 2 and await _changed(svc, gid, d2) == {}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_restore_and_send_back():
    asyncio.run(_run())
