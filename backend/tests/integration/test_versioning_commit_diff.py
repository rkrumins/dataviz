"""Per-commit hierarchical diff (the History tab drill-down) — Postgres.

Each commit's drill-down reuses the same containment-tree engine as the draft/PR diff, scoped to
exactly the rows that commit wrote. This pins the load-bearing invariant — a commit's hierarchical
summary's GLOBAL counts equal the flat ``diff_commits`` tally for the same window — across create /
edit / delete / genesis commits, plus correct nesting and a draft commit (whose 'before' is the
composed base, not empty).
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


def _u(eid, name, etype="Column"):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name}}


def _e(eid, s, t):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "CONTAINS", "sourceEntityId": s, "targetEntityId": t}}


def _flat_counts(flat):
    return {"added": len(flat["added"]), "modified": len(flat["modified"]), "removed": len(flat["removed"])}


def _grp(summary):
    return {g["key"]: g for g in summary["groups"]}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # A sequence of distinct main commits: seed, add, edit, delete.
    c_seed = await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=CONT, ops=[
        _n("DOM", "Domain", etype="Dataset"), _n("T1", "t1"),
        _n("C1", "c1", etype="Column"), _n("C2", "c2", etype="Column"),
        _e("e_d1", "DOM", "T1"), _e("e_t1c1", "T1", "C1"), _e("e_t1c2", "T1", "C2"),
    ])
    c_add = await svc.apply_ops(graph_id=gid, actor="u", message="add T2+C3", containment_edge_types=CONT, ops=[
        _n("T2", "t2"), _e("e_d2", "DOM", "T2"),
        _n("C3", "c3", etype="Column"), _e("e_t1c3", "T1", "C3"),
    ])
    c_edit = await svc.apply_ops(graph_id=gid, actor="u", message="rename C1", containment_edge_types=CONT,
                                 ops=[_u("C1", "c1_renamed")])
    c_del = await svc.apply_ops(graph_id=gid, actor="u", message="drop C2", containment_edge_types=CONT,
                                ops=[{"op": "delete", "entity_kind": "node", "entity_id": "C2", "payload": None}])

    seq = {m["commit_id"]: m["commit_seq"] for m in await svc.commit_log(graph_id=gid, branch_id=main, limit=100)}

    # INVARIANT: every commit's hierarchical summary global counts == the flat diff_commits tally.
    for cid in (c for c in (c_seed, c_add, c_edit, c_del) if c):
        s = seq[cid]
        flat = await svc.diff_commits(graph_id=gid, branch_id=main, from_seq=s - 1, to_seq=s)
        summ = await svc.diff_commit_summary(graph_id=gid, commit_id=cid, containment_edge_types=CONT)
        assert summ["counts"] == _flat_counts(flat), (cid, summ["counts"], _flat_counts(flat))

    # ---- structural: the add commit nests the new entities under their real containers ----
    add = await svc.diff_commit_summary(graph_id=gid, commit_id=c_add, containment_edge_types=CONT)
    assert "DOM" in _grp(add), _grp(add)                          # unchanged ancestor as a group
    dom_kids = {e["key"]: e for e in (await svc.diff_commit_children(
        graph_id=gid, commit_id=c_add, container_key="DOM", containment_edge_types=CONT))["entries"]}
    assert dom_kids["T2"]["status"] == "added"                   # new table nests under DOM
    assert dom_kids["T1"]["kind"] == "container"                 # existing table carries the new column
    t1_kids = {e["key"]: e for e in (await svc.diff_commit_children(
        graph_id=gid, commit_id=c_add, container_key="T1", containment_edge_types=CONT))["entries"]}
    assert t1_kids["C3"]["status"] == "added", t1_kids

    # ---- structural: edit of an existing column nests under its (unchanged) table via as-of skeleton ----
    edit = await svc.diff_commit_summary(graph_id=gid, commit_id=c_edit, containment_edge_types=CONT)
    assert "DOM" in _grp(edit) and _grp(edit)["DOM"]["counts"]["modified"] == 1, _grp(edit)
    e_t1 = {e["key"]: e for e in (await svc.diff_commit_children(
        graph_id=gid, commit_id=c_edit, container_key="T1", containment_edge_types=CONT))["entries"]}
    assert e_t1["C1"]["status"] == "modified" and e_t1["C1"]["after"]["displayName"] == "c1_renamed"

    # ---- structural: delete shows the removed column (rose) under its surviving table. A lone
    # leaf-delete has no live seed for the upward climb, so the tree roots at the immediate
    # surviving parent (T1), not the full chain to DOM — same as the branch-diff delete path. ----
    dele = await svc.diff_commit_summary(graph_id=gid, commit_id=c_del, containment_edge_types=CONT)
    assert "T1" in _grp(dele) and _grp(dele)["T1"]["counts"]["removed"] >= 1, _grp(dele)
    d_t1 = {e["key"]: e for e in (await svc.diff_commit_children(
        graph_id=gid, commit_id=c_del, container_key="T1", containment_edge_types=CONT))["entries"]}
    assert d_t1["C2"]["status"] == "removed" and d_t1["C2"]["deleted"] is True

    # ---- a DRAFT commit: the invariant holds for drafts too, and the head skeleton nests the
    # change under its base-resident container. An EDIT of a base-inherited entity reads as
    # "modified" against its true base value (the per-commit/flat diff resolve 'before' from
    # main@base_commit_seq — a base entity has no row on the draft before this commit). ----
    d = await svc.open_draft(graph_id=gid, owner="u2")
    c_draft = await svc.apply_ops(graph_id=gid, branch_id=d, actor="u2", message="draft edit C3",
                                  containment_edge_types=CONT, ops=[_u("C3", "c3_draft")])
    dseq = {m["commit_id"]: m["commit_seq"] for m in await svc.commit_log(graph_id=gid, branch_id=d)}[c_draft]
    flat_d = await svc.diff_commits(graph_id=gid, branch_id=d, from_seq=dseq - 1, to_seq=dseq)
    dsum = await svc.diff_commit_summary(graph_id=gid, commit_id=c_draft, containment_edge_types=CONT)
    assert dsum["counts"] == _flat_counts(flat_d), (dsum["counts"], _flat_counts(flat_d))   # invariant
    dd = {e["key"]: e for e in (await svc.diff_commit_children(
        graph_id=gid, commit_id=c_draft, container_key="T1", containment_edge_types=CONT))["entries"]}
    assert dd["C3"]["status"] == "modified" and dd["C3"]["key"] == "C3", dd                 # not "added"
    assert dd["C3"]["before"]["displayName"] == "c3" and dd["C3"]["after"]["displayName"] == "c3_draft", dd

    # ---- a DRAFT DELETE of a base-inherited node must show as REMOVED, not an empty diff. This is
    # the reported bug: 'before' was read only from the draft branch, so a base entity's delete
    # collapsed to None→None, net_delta dropped it, and the per-commit diff rendered empty ("No
    # changes in this commit") despite a real −N stats badge. 'before' now comes from the base. ----
    d2 = await svc.open_draft(graph_id=gid, owner="u3")
    c_drop = await svc.apply_ops(graph_id=gid, branch_id=d2, actor="u3", message="draft drop T2",
                                 containment_edge_types=CONT,
                                 ops=[{"op": "delete", "entity_kind": "node", "entity_id": "T2", "payload": None}])
    drop_seq = {m["commit_id"]: m["commit_seq"] for m in await svc.commit_log(graph_id=gid, branch_id=d2)}[c_drop]
    flat_drop = await svc.diff_commits(graph_id=gid, branch_id=d2, from_seq=drop_seq - 1, to_seq=drop_seq)
    drop_sum = await svc.diff_commit_summary(graph_id=gid, commit_id=c_drop, containment_edge_types=CONT)
    assert drop_sum["counts"] == _flat_counts(flat_drop), (drop_sum["counts"], _flat_counts(flat_drop))  # invariant
    assert drop_sum["groups"], "draft delete of a base entity must not render an empty diff"
    assert drop_sum["counts"]["removed"] >= 1, drop_sum["counts"]
    drop_kids = {e["key"]: e for e in (await svc.diff_commit_children(
        graph_id=gid, commit_id=c_drop, container_key="DOM", containment_edge_types=CONT))["entries"]}
    assert drop_kids["T2"]["status"] == "removed" and drop_kids["T2"]["deleted"] is True, drop_kids

    # unknown commit → domain error (404 at the endpoint)
    try:
        await svc.diff_commit_summary(graph_id=gid, commit_id="cmt_nope", containment_edge_types=CONT)
        assert False, "expected ValueError for unknown commit"
    except ValueError:
        pass

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_commit_diff_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning per-commit hierarchical diff e2e: OK")
