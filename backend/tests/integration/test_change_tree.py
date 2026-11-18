"""Changes top-down against Postgres: a draft's changes laid out in the containment tree they sit
in — unchanged ancestors named, removed entities where they were, a relationship under its source
— a level at a time, most-changed first, paged; the path of any change; a review's tree with its
decisions; a window of main's revisions. Built once per version of the change list."""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.change_index import ChangeOrigin
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


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="ana", message="seed", containment_edge_types=CONT, ops=[
        _n("DB", "warehouse"), _n("S1", "sales"), _n("T1", "orders"), _n("T2", "payments"),
        _n("C1", "amount"), _n("C2", "legacy"),
        _e("e1", "DB", "S1"), _e("e2", "S1", "T1"), _e("e3", "S1", "T2"), _e("e4", "T1", "C1"), _e("e5", "T1", "C2")])
    d = await svc.open_draft(graph_id=gid, owner="ana")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="ana", ops=[
        _n("C1", "Amount", op="update", unit="eur"), _del("C2"),
        _n("C3", "currency"), _e("e6", "T1", "C3"), _e("f1", "T1", "T2", "FEEDS")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="ana", containment_edge_types=CONT)
    origin = ChangeOrigin(branch_id=d)

    top = await svc.change_tree_level(graph_id=gid, origin=origin, containment_edge_types=CONT)
    assert [i["id"] for i in top["items"]] == ["DB"] and top["path"] == []
    assert top["items"][0]["name"] == "warehouse" and top["items"][0]["hasChildren"]
    s1 = (await svc.change_tree_level(graph_id=gid, origin=origin, containment_edge_types=CONT, parent="DB"))["items"]
    assert [i["id"] for i in s1] == ["S1"]
    t1 = await svc.change_tree_level(graph_id=gid, origin=origin, containment_edge_types=CONT, parent="S1")
    assert [i["id"] for i in t1["items"]] == ["T1"]                    # T2 changed nothing under it
    inside = t1["items"][0]["inside"]
    # Added: a column, its link, a relationship; edited: a column; removed: a column and its link.
    assert (inside["added"], inside["modified"], inside["removed"]) == (3, 1, 2)
    assert [p["name"] for p in t1["path"]] == ["warehouse", "sales"]
    cols = await svc.change_tree_level(graph_id=gid, origin=origin, containment_edge_types=CONT, parent="T1",
                                       summary=True)
    by = {i["id"]: i for i in cols["items"]}
    assert {"C1", "C2", "C3"} <= set(by)                              # the removed column where it was
    assert by["C1"]["change"]["status"] == "modified" and by["C1"]["change"]["fields"]["changed"] >= 1
    assert by["C2"]["change"]["status"] == "removed"
    assert any(i["change"]["kind"] == "edge" for i in cols["items"] if "change" in i)   # the relationship from T1
    paged = await svc.change_tree_level(graph_id=gid, origin=origin, containment_edge_types=CONT, parent="T1",
                                        limit=2)
    assert len(paged["items"]) == 2 and paged["hasMore"] and paged["total"] == len(cols["items"])
    # A search finds changes anywhere, each saying where it sits.
    found = await svc.change_entries(graph_id=gid, origin=origin, containment_edge_types=CONT, q="currency", paths=True)
    assert [(e["entityId"], e["path"]) for e in found["entries"]] == [("C3", ["warehouse", "sales", "orders"])]
    path = await svc.change_tree_path(graph_id=gid, origin=origin, containment_edge_types=CONT, entity_id="C3")
    assert [p["id"] for p in path["path"]] == ["DB", "S1", "T1"]
    assert [p["at"] for p in path["path"]] == [0, 0, 0] and path["at"] == [i["id"] for i in cols["items"]].index("C3")

    pr = await svc.open_draft_mr(graph_id=gid, branch_id=d, actor="ana", title="Columns")
    await svc.decide_changes(pr_id=pr, actor="bo", verdict="rejected", entity_ids=["C2"], reason="Keep it",
                             containment_edge_types=CONT)
    review = await svc.change_tree_level(graph_id=gid, origin=origin, containment_edge_types=CONT, parent="T1",
                                         decisions_for=pr)
    rev = {i["id"]: i for i in review["items"]}
    assert rev["C2"]["change"]["decision"]["verdict"] == "rejected"
    found = await svc.review_change_entries(pr_id=pr, containment_edge_types=CONT, q="currency", paths=True)
    assert [(e["entityId"], e["path"]) for e in found["entries"]] == [("C3", ["warehouse", "sales", "orders"])]

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_changes_top_down():
    asyncio.run(_run())
