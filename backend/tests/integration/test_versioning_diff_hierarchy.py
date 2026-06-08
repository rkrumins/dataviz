"""Hierarchical diff + view/data-source-scoped PR access + view-scoped history — Postgres.

The canvas review layer reshapes the flat squash diff into a lazy-loadable containment tree
(business-friendly, bounded), lists PRs by originating view or by whole data source, and scopes
the change history to a view. This e2e pins the load-bearing invariants:

* the hierarchical summary's GLOBAL counts equal the flat diff's (preview ≡ diff, just reshaped);
* changes nest under their real containment parent; parent-less changes bucket by type;
* children page with accurate totals; a deleted container is marked and its subtree pages through;
* the PR/branch paths agree; PR scope filters + counts isolate by view and by data source;
* commit_log scopes to a view (across branches) vs the graph-wide branch log.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]


def _n(eid, name=None, etype="Table"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name or eid}}


def _u(eid, name, etype="Table"):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name}}


def _d(eid):
    return {"op": "delete", "entity_kind": "node", "entity_id": eid, "payload": None}


def _e(eid, s, t, kind="CONTAINS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": kind, "sourceEntityId": s, "targetEntityId": t}}


def _flat_counts(diff):
    return {"added": len(diff["added"]), "modified": len(diff["modified"]),
            "removed": len(diff["removed"])}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds_id = "ds_" + os.urandom(4).hex()
    G = await svc.create_graph(data_source_id=ds_id, workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # main: Dataset DS contains tables T1, T2; T1 contains C1, C2; T2 contains C4.
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=CONT, ops=[
        _n("DS", "Sales", etype="Dataset"),
        _n("T1", "orders"), _n("T2", "returns"),
        _n("C1", "amount", etype="Column"), _n("C2", "qty", etype="Column"),
        _n("C4", "reason", etype="Column"),
        _e("e_dt1", "DS", "T1"), _e("e_dt2", "DS", "T2"),
        _e("e_tc1", "T1", "C1"), _e("e_tc2", "T1", "C2"), _e("e_tc4", "T2", "C4"),
    ])

    # ---- branch path: edit C1, add C3 under T1, modify T2, delete T2's subtree? ----
    # Keep T2 alive here (delete is exercised separately) — edit existing + add new.
    view_id = "view_" + os.urandom(3).hex()
    draft = await svc.open_draft(graph_id=gid, owner="u", originating_view_id=view_id)
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="edits",
                        containment_edge_types=CONT, ops=[
        _u("C1", "amount_usd", etype="Column"),               # modify existing column
        _n("C3", "currency", etype="Column"), _e("e_tc3", "T1", "C3"),  # add column under T1
        _u("T2", "returns_v2"),                               # modify a table
    ])

    flat = await svc.diff_branch_vs_base(graph_id=gid, branch_id=draft)
    summ = await svc.diff_branch_summary(
        graph_id=gid, branch_id=draft, containment_edge_types=CONT)

    # INVARIANT: hierarchical global counts == flat diff counts (containment edge e_tc3 is
    # structural → suppressed from rows, but still counted globally).
    assert summ["counts"] == _flat_counts(flat), (summ["counts"], _flat_counts(flat))
    # impact: DS(1) + T1,T2(2) + C1,C3(2 relevant columns) — C2 unchanged, not relevant.
    assert summ["impact"].get("Dataset") == 1
    assert summ["impact"].get("Table") == 2
    assert summ["impact"].get("Column") == 2

    groups = {g["key"]: g for g in summ["groups"]}
    assert "DS" in groups and groups["DS"]["kind"] == "container", groups
    assert groups["DS"]["label"] == "Sales"                    # real label, not the eid
    assert groups["DS"]["childTotal"] == 2                     # T1 + T2 both changed-or-containing

    ds_children = await svc.diff_branch_children(
        graph_id=gid, branch_id=draft, container_key="DS", containment_edge_types=CONT)
    kids = {e["key"]: e for e in ds_children["entries"]}
    assert kids["T1"]["kind"] == "container" and kids["T1"]["childTotal"] == 2  # C1 mod + C3 add
    assert kids["T2"]["kind"] == "leaf" and kids["T2"]["status"] == "modified"

    t1_children = await svc.diff_branch_children(
        graph_id=gid, branch_id=draft, container_key="T1", containment_edge_types=CONT)
    t1 = {e["key"]: e for e in t1_children["entries"]}
    assert t1["C1"]["status"] == "modified" and t1["C1"]["after"]["displayName"] == "amount_usd"
    assert t1["C3"]["status"] == "added" and t1["C3"]["before"] is None
    assert "C2" not in t1                                       # unchanged → absent

    # children paging
    page = await svc.diff_branch_children(
        graph_id=gid, branch_id=draft, container_key="T1", containment_edge_types=CONT,
        limit=1, offset=1)
    assert page["total"] == 2 and len(page["entries"]) == 1

    # ---- delete path: a new draft deletes T2's whole subtree (T2 + C4) ----
    d2 = await svc.open_draft(graph_id=gid, owner="u2")
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="u2", message="drop T2",
                        containment_edge_types=CONT, ops=[_d("C4"), _d("T2")])
    dsum = await svc.diff_branch_summary(graph_id=gid, branch_id=d2, containment_edge_types=CONT)
    dgroups = {g["key"]: g for g in dsum["groups"]}
    # DS survives (unchanged) but contains a deletion → labelled container nesting the delete.
    assert "DS" in dgroups and dgroups["DS"]["label"] == "Sales", dgroups
    dkids = {e["key"]: e for e in (await svc.diff_branch_children(
        graph_id=gid, branch_id=d2, container_key="DS", containment_edge_types=CONT))["entries"]}
    assert dkids["T2"]["deleted"] is True and dkids["T2"]["status"] == "removed"
    # the deleted container's subtree pages through the same children endpoint
    t2kids = await svc.diff_branch_children(
        graph_id=gid, branch_id=d2, container_key="T2", containment_edge_types=CONT)
    assert {e["key"] for e in t2kids["entries"]} == {"C4"}
    assert t2kids["entries"][0]["status"] == "removed"

    # ---- PR path: raise an MR from the first draft; summary agrees with flat diff_pr ----
    pr_id = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="u", title="edits")
    pr_flat = await svc.diff_pr(pr_id=pr_id)
    pr_summ = await svc.diff_pr_summary(pr_id=pr_id, containment_edge_types=CONT)
    assert pr_summ["counts"] == _flat_counts(pr_flat), (pr_summ["counts"], _flat_counts(pr_flat))
    pr_groups = {g["key"]: g for g in pr_summ["groups"]}
    assert "DS" in pr_groups and pr_groups["DS"]["label"] == "Sales"

    # ---- PR scope filters + counts ----
    by_view = await svc.list_pulls(originating_view_id=view_id)
    assert [p["pr_id"] for p in by_view] == [pr_id], by_view
    assert await svc.count_pulls(originating_view_id=view_id, active_only=True) == 1
    by_ds = await svc.list_pulls(data_source_id=ds_id)
    assert pr_id in {p["pr_id"] for p in by_ds}
    assert await svc.count_pulls(data_source_id=ds_id, active_only=True) >= 1
    # isolation: an unrelated view sees nothing
    assert await svc.list_pulls(originating_view_id="view_nope") == []
    assert await svc.count_pulls(originating_view_id="view_nope", active_only=True) == 0
    # exact-status filter still works (the freshly raised MR is "mergeable", not merged)
    assert await svc.list_pulls(originating_view_id=view_id, status="merged") == []
    assert [p["pr_id"] for p in await svc.list_pulls(originating_view_id=view_id, status="mergeable")] == [pr_id]

    # ---- view-scoped commit history: publish a view-attributed draft, then scope the log ----
    hview = "view_hist_" + os.urandom(3).hex()
    hdraft = await svc.open_draft(graph_id=gid, owner="u3", originating_view_id=hview)
    await svc.apply_ops(graph_id=gid, branch_id=hdraft, actor="u3", message="hist edit",
                        containment_edge_types=CONT, ops=[_u("C2", "qty2", etype="Column")])
    await svc.publish(graph_id=gid, branch_id=hdraft, actor="u3", message="publish from view")
    view_log = await svc.commit_log(graph_id=gid, originating_view_id=hview)
    assert len(view_log) >= 1, view_log
    assert all(c.get("originating_view_id") == hview for c in view_log), view_log
    graph_log = await svc.commit_log(graph_id=gid, branch_id=main)        # graph-wide (main)
    assert len(graph_log) > len(view_log)                                 # seed + squash + ...
    assert await svc.commit_log(graph_id=gid, originating_view_id="view_none") == []

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_diff_hierarchy_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning hierarchical diff + scoped PRs + view history e2e: OK")
