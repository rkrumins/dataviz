"""Branch-aware draft reads over the versioned store (journey Phase G) — needs Postgres.

The second journey-breaking gap was that the normal graph reads only ever saw ``main`` — a
user could not actually *work* in a draft. get_nodes/get_node/get_edges/search_from_state
compose the shared ``main`` base with a draft's tiny overlay (and time-travel via as_of) as
bounded Postgres queries, so a draft read shows the draft's view (created/renamed/deleted),
``main`` reads are unaffected, the draft stays isolated from later ``main`` commits, and an
as-of read returns the historical view.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService


def _n(eid, name=None, etype="Dataset"):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": etype, "displayName": name or eid}}


def _e(eid, s, t, etype="FLOWS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": s, "targetEntityId": t}}


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = G["graph_id"], G["main_branch_id"]

    # main: A(Alpha), B(Beta), C(Gamma/Table) + A-FLOWS->B
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        _n("A", "Alpha"), _n("B", "Beta"), _n("C", "Gamma", etype="Table"),
        _e("e_ab", "A", "B")])
    base_seq = (await svc.get_graph(gid))["main_head_commit_seq"]

    # open a draft and edit ONLY in the draft: add D, rename B->Beta2, delete C, add B-FLOWS->D
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="draft edits", ops=[
        _n("D", "Delta"),
        {"op": "update", "entity_kind": "node", "entity_id": "B",
         "payload": {"urn": "B", "entityType": "Dataset", "displayName": "Beta2"}},
        {"op": "delete", "entity_kind": "node", "entity_id": "C", "payload": None},
        _e("e_bd", "B", "D")])

    async def names(branch, **kw):
        return {r["displayName"] for r in await svc.get_nodes_from_state(graph_id=gid, branch_id=branch, **kw)}

    # main is untouched by the draft; the draft composes base + overlay (B renamed, C gone, D added)
    assert await names(main) == {"Alpha", "Beta", "Gamma"}
    assert await names(draft) == {"Alpha", "Beta2", "Delta"}
    # entity-type filter on the draft (C/Table is deleted anyway; D is a Dataset)
    assert await names(draft, entity_types=["Dataset"]) == {"Alpha", "Beta2", "Delta"}
    assert await names(draft, entity_types=["Table"]) == set()
    # case-insensitive substring search on the draft — a rename and an overlay-only add both surface
    assert await names(draft, search_query="beta") == {"Beta2"}
    assert {r["displayName"] for r in await svc.search_from_state(graph_id=gid, branch_id=draft, query="delta")} == {"Delta"}

    # single-node read: the draft sees the rename / deletion, main sees the originals
    assert (await svc.get_node_from_state(graph_id=gid, branch_id=draft, urn="B"))["displayName"] == "Beta2"
    assert (await svc.get_node_from_state(graph_id=gid, branch_id=main, urn="B"))["displayName"] == "Beta"
    assert await svc.get_node_from_state(graph_id=gid, branch_id=draft, urn="C") is None
    assert (await svc.get_node_from_state(graph_id=gid, branch_id=main, urn="C"))["displayName"] == "Gamma"

    # edges: the draft sees the new B->D edge, main does not
    async def edge_ids(branch, **kw):
        return {e["id"] for e in await svc.get_edges_from_state(graph_id=gid, branch_id=branch, **kw)}
    assert await edge_ids(main) == {"e_ab"}
    assert await edge_ids(draft) == {"e_ab", "e_bd"}
    assert await edge_ids(draft, any_urns=["B"]) == {"e_ab", "e_bd"}     # incident to B
    assert await edge_ids(draft, edge_types=["FLOWS"]) == {"e_ab", "e_bd"}
    bd = next(e for e in await svc.get_edges_from_state(graph_id=gid, branch_id=draft, any_urns=["D"]) if e["id"] == "e_bd")
    assert bd["sourceUrn"] == "B" and bd["targetUrn"] == "D"            # endpoints resolved to urns

    # advance main AFTER the draft was opened: delete A (cascades to e_ab)
    await svc.apply_ops(graph_id=gid, actor="u", message="del A on main",
                        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "A", "payload": None}])
    assert await names(main) == {"Beta", "Gamma"}                       # main moved on
    assert await names(main, as_of_seq=base_seq) == {"Alpha", "Beta", "Gamma"}  # as-of = history
    assert await names(draft) == {"Alpha", "Beta2", "Delta"}            # draft pinned to its base — isolated

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_reads_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning branch-aware draft reads e2e: OK")
