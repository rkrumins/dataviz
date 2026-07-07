"""Draft ≡ main canvas-read parity — Postgres.

The load-bearing guarantee behind "a draft behaves the same as main": a freshly opened draft
(zero edits) must return results IDENTICAL to ``main`` for every read the canvas issues — roots,
node queries, children-with-edges, edges, single node, search, and trace. This pins that, plus
that the node shape carries the same fields main does (childCount + layerAssignment/sourceSystem/
lastSyncedAt), and that once edited a draft diverges ONLY by its edits while main stays untouched.

Deliberate, by-design non-parities (NOT asserted here): a draft has no materialized AGGREGATED
projection, so aggregated-edge rollups degrade to raw edges; ontology is resolved from the shared
data source, not the draft provider.
"""
import asyncio
import json
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]
LIN = ["FLOWS"]


def _n(eid, name=None, etype="Table", **extra):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name or eid, **extra}}


def _u(eid, name, etype="Table", **extra):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name, **extra}}


def _e(eid, s, t, kind="CONTAINS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": kind, "sourceEntityId": s, "targetEntityId": t}}


def _canon(o):
    """Order-independent canonical form: sort dict keys, sort lists by a stable JSON key, and
    turn sets into sorted lists — so two reads are compared by content, not list/set order."""
    if isinstance(o, dict):
        return {k: _canon(v) for k, v in sorted(o.items())}
    if isinstance(o, (set, frozenset)):
        return sorted(json.dumps(_canon(x), sort_keys=True, default=str) for x in o)
    if isinstance(o, list):
        return sorted((_canon(x) for x in o), key=lambda x: json.dumps(x, sort_keys=True, default=str))
    return o


async def _all_reads(svc, gid, bid):
    """Every canvas-critical read, against one branch."""
    return {
        "top": await svc.top_level_from_state(
            graph_id=gid, branch_id=bid, containment_edge_types=CONT, root_entity_types=["Dataset"]),
        "nodes_tables": await svc.get_nodes_from_state(
            graph_id=gid, branch_id=bid, entity_types=["Table"], containment_edge_types=CONT),
        "nodes_all": await svc.get_nodes_from_state(
            graph_id=gid, branch_id=bid, containment_edge_types=CONT, limit=100),
        "children_dom": await svc.get_children_with_edges_from_state(
            graph_id=gid, branch_id=bid, parent_urn="DOM", containment_edge_types=CONT, lineage_edge_types=LIN),
        "children_t1": await svc.get_children_with_edges_from_state(
            graph_id=gid, branch_id=bid, parent_urn="T1", containment_edge_types=CONT, lineage_edge_types=LIN),
        "edges": await svc.get_edges_from_state(graph_id=gid, branch_id=bid),
        "node_t1": await svc.get_node_from_state(
            graph_id=gid, branch_id=bid, urn="T1", containment_edge_types=CONT),
        "search_t": await svc.search_from_state(graph_id=gid, branch_id=bid, query="t1"),
        "trace_t1": await svc.trace_from_state(
            graph_id=gid, branch_id=bid, urn="T1", level=0, upstream_depth=5, downstream_depth=5,
            lineage_edge_types=LIN, containment_edge_types=CONT, max_nodes=100, include_containment_edges=True),
    }


def _dom_children(reads):
    return {c["entityId"]: c.get("childCount") for c in reads["children_dom"]["children"]}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # main: DOM(Dataset) ⊃ {T1,T2,T3}; T1 ⊃ {C1,C2}; lineage T1→T2.  T1 carries the
    # denormalised metadata fields so the node-shape passthrough is exercised.
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", containment_edge_types=CONT, ops=[
        _n("DOM", "Domain", etype="Dataset"),
        _n("T1", "t1", layerAssignment="silver", sourceSystem="pg", lastSyncedAt="2024-01-01T00:00:00Z"),
        _n("T2", "t2"), _n("T3", "t3"),
        _n("C1", "c1", etype="Column"), _n("C2", "c2", etype="Column"),
        _e("e_d1", "DOM", "T1"), _e("e_d2", "DOM", "T2"), _e("e_d3", "DOM", "T3"),
        _e("e_t1c1", "T1", "C1"), _e("e_t1c2", "T1", "C2"),
        _e("e_12", "T1", "T2", kind="FLOWS"),
    ])

    # ---- 1. an UNEDITED draft is byte-for-byte identical to main, for every read ----
    draft = await svc.open_draft(graph_id=gid, owner="u")
    main_reads = await _all_reads(svc, gid, main)
    draft_reads = await _all_reads(svc, gid, draft)
    for key in main_reads:
        assert _canon(main_reads[key]) == _canon(draft_reads[key]), f"draft≠main for read '{key}'"

    # node shape carries the same fields main does (childCount + the 3 metadata fields)
    t1 = draft_reads["node_t1"]
    assert t1["childCount"] == 2, t1
    assert t1["layerAssignment"] == "silver" and t1["sourceSystem"] == "pg" \
        and t1["lastSyncedAt"] == "2024-01-01T00:00:00Z", t1
    assert _dom_children(draft_reads) == {"T1": 2, "T2": 0, "T3": 0}, _dom_children(draft_reads)
    # lineage T1→T2 shows under DOM (both endpoints in scope); containment edges present
    assert {e["id"] for e in draft_reads["children_dom"]["lineageEdges"]} == {"e_12"}
    assert {e["id"] for e in draft_reads["children_dom"]["containmentEdges"]} == {"e_d1", "e_d2", "e_d3"}

    # ---- 2. once edited, the draft diverges ONLY by its edits; main stays untouched ----
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="edits",
                        containment_edge_types=CONT, ops=[
        _n("C3", "c3", etype="Column"), _e("e_t1c3", "T1", "C3"),   # add a child under T1
        _u("T2", "t2_renamed"),                                      # rename a table
        {"op": "delete", "entity_kind": "node", "entity_id": "T3", "payload": None},  # delete a table
    ])

    d2 = await _all_reads(svc, gid, draft)
    m2 = await _all_reads(svc, gid, main)

    # draft reflects every edit
    assert _dom_children(d2).get("T1") == 3, _dom_children(d2)        # C1,C2,C3
    assert "T3" not in _dom_children(d2), _dom_children(d2)           # deleted
    assert {c["entityId"] for c in d2["children_t1"]["children"]} == {"C1", "C2", "C3"}
    assert next(n for n in d2["nodes_tables"] if n["entityId"] == "T2")["displayName"] == "t2_renamed"

    # main is fully isolated from the draft overlay (unchanged from step 1)
    for key in main_reads:
        assert _canon(m2[key]) == _canon(main_reads[key]), f"main drifted under draft edits: '{key}'"
    assert _dom_children(m2) == {"T1": 2, "T2": 0, "T3": 0}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_parity_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft↔main read parity e2e: OK")
