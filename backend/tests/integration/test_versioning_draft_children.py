"""Branch-aware children-with-edges over the versioned store (journey Phase G) — Postgres.

The graph UI navigates by expanding a parent's containment children (with their cross-child
lineage edges) in one round trip. get_children_with_edges_from_state is the draft/as-of
counterpart: the parent's OUT containment edges name the children, the page's cross-edges name
the lineage, all bounded by degree and composed over the shared main base + the draft overlay —
so a draft's added/renamed/deleted children (and cascaded edges) show up, main is untouched.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]
LIN = ["FLOWS"]


def _n(eid, name=None, etype="Table"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name or eid}}


def _e(eid, s, t, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # main: DOM contains T1, T2 ; lineage T1-FLOWS->T2
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        _n("DOM", "Domain", etype="Domain"), _n("T1", "T1name"), _n("T2", "T2name"),
        _e("e_d1", "DOM", "T1", "CONTAINS"), _e("e_d2", "DOM", "T2", "CONTAINS"),
        _e("e_12", "T1", "T2", "FLOWS")])

    async def cwe(branch):
        return await svc.get_children_with_edges_from_state(
            graph_id=gid, branch_id=branch, parent_urn="DOM",
            containment_edge_types=CONT, lineage_edge_types=LIN)

    # main: two children, two containment edges, one lineage edge
    r = await cwe(main)
    assert {c["urn"] for c in r["children"]} == {"T1", "T2"}
    assert {e["id"] for e in r["containmentEdges"]} == {"e_d1", "e_d2"}
    assert {e["id"] for e in r["lineageEdges"]} == {"e_12"}
    assert r["totalChildren"] == 2 and r["hasMore"] is False

    # draft: add T3 under DOM, rename T1, delete T2 (cascades e_d2 + e_12), add lineage T1->T3
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="draft edits", ops=[
        _n("T3", "T3name"), _e("e_d3", "DOM", "T3", "CONTAINS"),
        {"op": "update", "entity_kind": "node", "entity_id": "T1",
         "payload": {"urn": "T1", "entityType": "Table", "displayName": "T1renamed"}},
        {"op": "delete", "entity_kind": "node", "entity_id": "T2", "payload": None},
        _e("e_13", "T1", "T3", "FLOWS")])

    # draft composes the overlay: T2 gone, T3 added, T1 renamed; e_12 cascaded out; e_13 in
    rd = await cwe(draft)
    assert {c["urn"] for c in rd["children"]} == {"T1", "T3"}
    assert next(c for c in rd["children"] if c["urn"] == "T1")["displayName"] == "T1renamed"
    assert {e["id"] for e in rd["containmentEdges"]} == {"e_d1", "e_d3"}
    assert {e["id"] for e in rd["lineageEdges"]} == {"e_13"}
    assert rd["totalChildren"] == 2

    # main is unchanged by the draft
    rm = await cwe(main)
    assert {c["urn"] for c in rm["children"]} == {"T1", "T2"}
    assert {e["id"] for e in rm["lineageEdges"]} == {"e_12"}

    # an unknown parent → empty result
    empty = await svc.get_children_with_edges_from_state(
        graph_id=gid, branch_id=draft, parent_urn="NOPE", containment_edge_types=CONT)
    assert empty["children"] == [] and empty["totalChildren"] == 0

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_children_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning branch-aware children-with-edges e2e: OK")
