"""Draft-branch childCount parity (the canvas expand chevron) — Postgres.

A node renders its expand chevron + "+N" badge only when ``childCount > 0``. On ``main`` the
FalkorDB reader computes that in every read; the Postgres draft reader must reach parity, or a
draft's nodes look like un-expandable leaves (the reported bug). This pins that ALL THREE
branch/as-of node reads carry ``childCount`` — and that it is computed over base+overlay, so a
draft that adds/removes a child sees the count move while ``main`` does not.
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


def _e(eid, s, t):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": "CONTAINS", "sourceEntityId": s, "targetEntityId": t}}


def _cc(nodes):
    return {n["entityId"]: n.get("childCount") for n in nodes}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # main: DOM ⊃ {P1, P2}; P1 ⊃ {C1, C2}.  → DOM=2 children, P1=2, P2=0.
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=CONT, ops=[
        _n("DOM", "Domain", etype="Domain"), _n("P1", "p1"), _n("P2", "p2"),
        _n("C1", "c1", etype="Column"), _n("C2", "c2", etype="Column"),
        _e("e_d1", "DOM", "P1"), _e("e_d2", "DOM", "P2"),
        _e("e_p1c1", "P1", "C1"), _e("e_p1c2", "P1", "C2"),
    ])

    # ---- parity on main (the Postgres reader matches the structural truth) ----
    tl = await svc.top_level_from_state(
        graph_id=gid, branch_id=main, containment_edge_types=CONT, root_entity_types=["Domain"])
    assert _cc(tl["nodes"]).get("DOM") == 2, tl["nodes"]

    nodes = await svc.get_nodes_from_state(
        graph_id=gid, branch_id=main, entity_types=["Table"], containment_edge_types=CONT)
    assert _cc(nodes) == {"P1": 2, "P2": 0}, _cc(nodes)

    ch = await svc.get_children_with_edges_from_state(
        graph_id=gid, branch_id=main, parent_urn="DOM", containment_edge_types=CONT)
    assert _cc(ch["children"]) == {"P1": 2, "P2": 0}, _cc(ch["children"])
    # the count is mirrored into properties (the canvas reads either)
    assert all(c["properties"].get("childCount") == c["childCount"] for c in ch["children"])

    # ---- a fresh draft (no edits) reports the SAME counts (was 0/missing before the fix) ----
    d = await svc.open_draft(graph_id=gid, owner="u")
    ch = await svc.get_children_with_edges_from_state(
        graph_id=gid, branch_id=d, parent_urn="DOM", containment_edge_types=CONT)
    assert _cc(ch["children"]) == {"P1": 2, "P2": 0}, _cc(ch["children"])
    assert _cc(await svc.get_nodes_from_state(
        graph_id=gid, branch_id=d, entity_types=["Table"], containment_edge_types=CONT)) == {"P1": 2, "P2": 0}

    # ---- overlay moves the count: add C3 under P1 → draft sees 3, main still 2 ----
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", message="add c3",
                        containment_edge_types=CONT, ops=[_n("C3", "c3", etype="Column"), _e("e_p1c3", "P1", "C3")])
    assert _cc((await svc.get_children_with_edges_from_state(
        graph_id=gid, branch_id=d, parent_urn="DOM", containment_edge_types=CONT))["children"])["P1"] == 3
    assert _cc(await svc.get_nodes_from_state(
        graph_id=gid, branch_id=d, entity_types=["Table"], containment_edge_types=CONT))["P1"] == 3
    # main is isolated from the draft overlay
    assert _cc((await svc.get_children_with_edges_from_state(
        graph_id=gid, branch_id=main, parent_urn="DOM", containment_edge_types=CONT))["children"])["P1"] == 2

    # ---- delete cascades the count down: drop C1 → P1 = {C2, C3} = 2 ----
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", message="del c1", containment_edge_types=CONT,
                        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "C1", "payload": None}])
    assert _cc((await svc.get_children_with_edges_from_state(
        graph_id=gid, branch_id=d, parent_urn="DOM", containment_edge_types=CONT))["children"])["P1"] == 2

    # ---- a single-node fetch on the draft also carries the count ----
    one = await svc.get_node_from_state(graph_id=gid, branch_id=d, urn="P1", containment_edge_types=CONT)
    assert one["childCount"] == 2, one

    # ---- no containment types ⇒ childCount present but 0 (parity with FalkorDB "0 as childCount") ----
    nodes0 = await svc.get_nodes_from_state(
        graph_id=gid, branch_id=d, entity_types=["Table"], containment_edge_types=[])
    assert nodes0 and all(n["childCount"] == 0 for n in nodes0), nodes0

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_child_counts_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft childCount parity e2e: OK")
