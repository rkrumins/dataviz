"""VersionedGraphReader through the real ContextEngine read stack (journey Phase G) — Postgres.

The Phase G claim is that a draft is served by the SAME ContextEngine/endpoints with no change
to the read stack — only the provider differs. This drives an actual ContextEngine whose
provider is a VersionedGraphReader bound to a draft and asserts the engine's read methods
(get_nodes_query / search_nodes / get_edges / get_children_with_edges) return the draft's
composed view, while a reader bound to main returns main's view. No FalkorDB involved — a draft
never instantiates one; this is all bounded Postgres over the shared base + the tiny overlay.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService
from backend.app.providers.versioned_graph_reader import VersionedGraphReader
from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import NodeQuery, EdgeQuery


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

    # main: DOM contains T1, T2 ; lineage T1->T2
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[
        _n("DOM", "Domain", etype="Domain"), _n("T1", "T1name"), _n("T2", "T2name"),
        _e("e_d1", "DOM", "T1", "CONTAINS"), _e("e_d2", "DOM", "T2", "CONTAINS"),
        _e("e_12", "T1", "T2", "FLOWS")])

    # draft: add T3 under DOM, delete T2 (cascades), lineage T1->T3
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(graph_id=gid, branch_id=draft, actor="u", message="draft", ops=[
        _n("T3", "T3name"), _e("e_d3", "DOM", "T3", "CONTAINS"),
        {"op": "delete", "entity_kind": "node", "entity_id": "T2", "payload": None},
        _e("e_13", "T1", "T3", "FLOWS")])

    # the engine reads the DRAFT entirely through the reader-as-provider — stack unchanged
    reader = VersionedGraphReader(svc, graph_id=gid, branch_id=draft)
    eng = ContextEngine(provider=reader)

    nodes = await eng.get_nodes_query(NodeQuery())
    assert {n.urn for n in nodes} == {"DOM", "T1", "T3"}                  # T2 gone, T3 added
    assert all(isinstance(n.entity_type, str) for n in nodes)            # real GraphNode models

    found = await eng.search_nodes("t3", limit=10)
    assert {n.urn for n in found} == {"T3"}

    edges = await eng.get_edges(EdgeQuery())
    assert {e.id for e in edges} == {"e_d1", "e_d3", "e_13"}             # e_d2/e_12 cascaded out

    cwe = await eng.get_children_with_edges("DOM", edge_types=["CONTAINS"], lineage_edge_types=["FLOWS"])
    assert {c.urn for c in cwe.children} == {"T1", "T3"}
    assert {e.id for e in cwe.containment_edges} == {"e_d1", "e_d3"}
    assert {e.id for e in cwe.lineage_edges} == {"e_13"}

    # a single-node read resolves a real model
    t1 = await eng.get_node("T1")
    assert t1 is not None and t1.display_name == "T1name"

    # get_children: DOM's containment children on the draft are T1, T3 (T2 deleted)
    kids = await reader.get_children("DOM", edge_types=["CONTAINS"])
    assert {k.urn for k in kids} == {"T1", "T3"}

    # get_top_level_or_orphan_nodes: only DOM lacks an incoming containment edge.
    # Containment types arrive via the same set_* push-down ContextEngine uses.
    reader.set_containment_edge_types(["CONTAINS"])
    top = await reader.get_top_level_or_orphan_nodes(root_entity_types=["Domain"])
    assert {n.urn for n in top.nodes} == {"DOM"}
    assert top.root_type_count == 1 and top.orphan_count == 0
    assert top.nodes[0].child_count == 2                                 # DOM contains T1, T3

    # trace_at_level (RAW lineage): downstream from T1 over FLOWS reaches T3 (draft),
    # not T2 (deleted); the containment ancestor chain (DOM) rides along for the canvas invariant.
    tr = await reader.trace_at_level(
        urn="T1", level=0, upstream_depth=5, downstream_depth=5,
        lineage_edge_types=["FLOWS"], containment_edge_types=["CONTAINS"],
        max_nodes=100, timeout_ms=2000, include_containment_edges=True)
    assert {n.urn for n in tr.nodes} == {"T1", "T3", "DOM"}              # T2 absent
    assert {e.id for e in tr.edges} == {"e_13"}                         # raw lineage on the draft
    assert "T3" in tr.downstream_urns and not tr.upstream_urns
    assert {e.id for e in tr.containment_edges} == {"e_d1", "e_d3"}     # ancestor chain present
    assert not tr.truncated

    # expand_aggregated (RAW): drilling DOM's subtree surfaces the intra-domain raw lineage.
    ex = await reader.expand_aggregated(
        source_urn="DOM", target_urn="DOM", next_level=1,
        lineage_edge_types=["FLOWS"], containment_edge_types=["CONTAINS"],
        max_nodes=100, timeout_ms=2000, use_raw_edges=True, include_containment_edges=True)
    assert {e.id for e in ex.edges} == {"e_13"}
    assert {"T1", "T3"} <= {n.urn for n in ex.nodes}

    # an engine bound to MAIN sees main's view (the draft changed nothing on main)
    meng = ContextEngine(provider=VersionedGraphReader(svc, graph_id=gid, branch_id=main))
    assert {n.urn for n in await meng.get_nodes_query(NodeQuery())} == {"DOM", "T1", "T2"}
    assert {e.id for e in await meng.get_edges(EdgeQuery())} == {"e_d1", "e_d2", "e_12"}

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_draft_reader_engine_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning draft reader through ContextEngine e2e: OK")
