"""Writing a draft through VersionedBranchProvider (journey Phase G) — Postgres.

The cohesion claim: the *same* graph provider that reads a draft also writes it, so the normal
``/nodes/create`` / ``/edges`` / ``/save`` path (engine -> provider.create_node/create_edge/
update_edge/delete_edge/save_custom_graph) edits a draft with no separate versioning API. Each
write becomes one audited commit on the branch via apply_ops; reads then compose it over the base.
This asserts read-your-writes on the draft AND that none of it leaks onto main.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.common.models.graph import NodeQuery, EdgeQuery, GraphNode, GraphEdge


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

    # main: DOM contains T1
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        _n("DOM", "Domain", etype="Domain"), _n("T1", "T1name"), _e("e_d1", "DOM", "T1", "CONTAINS")])

    draft = await svc.open_draft(graph_id=gid, owner="u")
    prov = VersionedBranchProvider(svc, graph_id=gid, branch_id=draft, actor="editor")
    main_prov = VersionedBranchProvider(svc, graph_id=gid, branch_id=main, actor="u")

    # create a node on the draft (under DOM via a containment edge), then a lineage edge — the
    # same calls ContextEngine.create_node / create_edge make on the provider.
    assert await prov.create_node(
        GraphNode(urn="T9", entityType="Table", displayName="T9name"),
        containment_edge=GraphEdge(id="e_d9", sourceUrn="DOM", targetUrn="T9", edgeType="CONTAINS")) is True
    assert await prov.create_edge(
        GraphEdge(id="e_19", sourceUrn="T1", targetUrn="T9", edgeType="FLOWS")) is True

    # read-your-writes on the draft
    assert {n.urn for n in await prov.get_nodes(NodeQuery())} == {"DOM", "T1", "T9"}
    assert {e.id for e in await prov.get_edges(EdgeQuery())} == {"e_d1", "e_d9", "e_19"}

    # update + delete an edge on the draft
    upd = await prov.update_edge("e_19", {"weight": 5})
    assert upd is not None and upd.properties.get("weight") == 5 and upd.edge_type == "FLOWS"
    assert await prov.delete_edge("e_19") is True
    assert await prov.delete_edge("e_missing") is False                 # absent → False (→404)
    assert {e.id for e in await prov.get_edges(EdgeQuery())} == {"e_d1", "e_d9"}

    # save_custom_graph appends another node+edge to the draft (the canvas "save")
    assert await prov.save_custom_graph(
        [GraphNode(urn="T10", entityType="Table", displayName="T10name")],
        [GraphEdge(id="e_d10", sourceUrn="DOM", targetUrn="T10", edgeType="CONTAINS")]) is True
    assert {n.urn for n in await prov.get_nodes(NodeQuery())} == {"DOM", "T1", "T9", "T10"}

    # MAIN is untouched by every draft write above
    assert {n.urn for n in await main_prov.get_nodes(NodeQuery())} == {"DOM", "T1"}
    assert {e.id for e in await main_prov.get_edges(EdgeQuery())} == {"e_d1"}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_writes_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft writes e2e: OK")
