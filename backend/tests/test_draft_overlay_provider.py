"""DraftOverlayProvider — the invariant + sparse-delta overlay, proven deterministically (no infra).

A draft opened off main must read IDENTICALLY to main until it changes something; then only the
changed entities differ. We prove this against a stub "main" provider with a fixed graph: an empty
delta is a byte-for-byte pass-through (the invariant), and add/remove/edit deltas patch exactly the
affected nodes/edges/rollups and nothing else. The delta-computation service methods
(``branch_overlay_delta`` / ``aggregated_overlay_adjust``) are stubbed here and exercised against live
Postgres elsewhere — this test pins the provider's overlay *application* logic.
"""
import asyncio

import pytest

from backend.common.models.graph import (
    AggregatedEdgeInfo, AggregatedEdgeResult, ChildrenWithEdgesResult, EdgeQuery, GraphNode,
    NodeQuery, TopLevelNodesResult, TraceFocus, TraceResult,
)
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider


class StubMain:
    """A fixed "main": tables A, B each with one column, and a rolled-up A→B lineage edge."""
    name = "stub-main"

    def __init__(self):
        self.nodes = {
            "A": GraphNode(urn="A", entityType="Table", displayName="A", childCount=1),
            "B": GraphNode(urn="B", entityType="Table", displayName="B", childCount=1),
            "A.c": GraphNode(urn="A.c", entityType="Column", displayName="A.c"),
            "B.c": GraphNode(urn="B.c", entityType="Column", displayName="B.c"),
        }
        self.agg = [AggregatedEdgeInfo(id="agg-A-B", sourceUrn="A", targetUrn="B",
                                       edgeCount=1, edgeTypes=["LINEAGE"], confidence=1.0, sourceEdgeIds=[])]

    def set_containment_edge_types(self, ets, from_ontology=False):
        pass

    async def get_node(self, urn):
        return self.nodes.get(urn)

    async def get_nodes(self, query: NodeQuery):
        ns = list(self.nodes.values())
        if query.urns:
            ns = [n for n in ns if n.urn in set(query.urns)]
        if query.entity_types:
            ns = [n for n in ns if n.entity_type in set(query.entity_types)]
        return ns

    async def search_nodes(self, query, limit=10, offset=0):
        return [n for n in self.nodes.values() if query.lower() in n.display_name.lower()]

    async def get_edges(self, query: EdgeQuery):
        return []

    async def get_children_with_edges(self, parent_urn, **kw):
        kids = [n for n in self.nodes.values() if n.urn.startswith(parent_urn + ".")]
        return ChildrenWithEdgesResult(children=kids, containmentEdges=[], lineageEdges=[],
                                       totalChildren=len(kids), hasMore=False, nextCursor=None)

    async def get_top_level_or_orphan_nodes(self, **kw):
        roots = [self.nodes["A"], self.nodes["B"]]
        return TopLevelNodesResult(nodes=roots, totalCount=2, hasMore=False, nextCursor=None,
                                   rootTypeCount=2, orphanCount=0)

    async def get_aggregated_edges_between(self, source_urns, target_urns, granularity,
                                           containment_edges, lineage_edges, *, timeout=None):
        return AggregatedEdgeResult(aggregatedEdges=list(self.agg),
                                    totalSourceEdges=sum(e.edge_count for e in self.agg),
                                    truncated=False, lastMaterializedAt="t0")

    async def trace_at_level(self, urn, *a, **kw):
        return TraceResult(nodes=list(self.nodes.values()), edges=[],
                           focus=TraceFocus(urn=urn, level=0, entityType="Table"), effectiveLevel=0)

    async def expand_aggregated(self, *a, **kw):
        return TraceResult(nodes=list(self.nodes.values()), edges=[],
                           focus=TraceFocus(urn="A", level=0, entityType="Table"), effectiveLevel=0)


class FakeSvc:
    def __init__(self, delta, adjust=None):
        self._delta, self._adjust = delta, adjust or {}

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        return self._delta

    async def aggregated_overlay_adjust(self, **kw):
        return self._adjust


_EMPTY = {"nodesUpsert": [], "nodesRemove": [], "edgesUpsert": [], "edgesRemove": []}


def _mk(base, delta, adjust=None):
    p = DraftOverlayProvider(base, svc=FakeSvc(delta, adjust), graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p


async def _run() -> None:
    base = StubMain()

    # ── INVARIANT: empty delta ⇒ every read === main ────────────────────────────
    p = _mk(base, _EMPTY)
    assert (await p.get_node("A")).urn == "A"
    assert (await p.get_node("A")).child_count == 1
    assert {n.urn for n in await p.get_nodes(NodeQuery())} == {"A", "B", "A.c", "B.c"}
    agg = await p.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, ["CONTAINS"], ["LINEAGE"])
    assert [(e.source_urn, e.target_urn, e.edge_count) for e in agg.aggregated_edges] == [("A", "B", 1)]
    assert {n.urn for n in (await p.get_top_level_or_orphan_nodes()).nodes} == {"A", "B"}
    assert {c.urn for c in (await p.get_children_with_edges("A")).children} == {"A.c"}
    assert {n.urn for n in (await p.trace_at_level("A", 0, 1, 1, ["LINEAGE"], ["CONTAINS"], 100, 1000)).nodes} \
        == {"A", "B", "A.c", "B.c"}

    # ── added lineage edge ⇒ that rollup +1, nothing else moves ─────────────────
    p2 = _mk(base, {**_EMPTY, "edgesUpsert": [
        {"id": "lin2", "sourceUrn": "A.c", "targetUrn": "B.c", "edgeType": "LINEAGE", "confidence": 1.0, "properties": {}}]},
        adjust={("A", "B"): {"weight": +1, "types": {"LINEAGE"}}})
    agg2 = await p2.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, ["CONTAINS"], ["LINEAGE"])
    assert {(e.source_urn, e.target_urn): e.edge_count for e in agg2.aggregated_edges} == {("A", "B"): 2}

    # ── removed base lineage edge ⇒ rollup drops to 0 (edge disappears) ─────────
    p3 = _mk(base, {**_EMPTY, "edgesRemove": [
        {"id": "lin1", "sourceUrn": "A.c", "targetUrn": "B.c", "edgeType": "LINEAGE", "confidence": 1.0, "properties": {}}]},
        adjust={("A", "B"): {"weight": -1, "types": {"LINEAGE"}}})
    agg3 = await p3.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, ["CONTAINS"], ["LINEAGE"])
    assert agg3.aggregated_edges == []

    # ── added node + containment edge ⇒ child appears, parent childCount +1 ─────
    p4 = _mk(base, {"nodesUpsert": [{"urn": "A.c2", "entityType": "Column", "displayName": "A.c2"}],
                    "nodesRemove": [],
                    "edgesUpsert": [{"id": "cont_new", "sourceUrn": "A", "targetUrn": "A.c2",
                                     "edgeType": "CONTAINS", "confidence": 1.0, "properties": {}}],
                    "edgesRemove": []})
    assert {c.urn for c in (await p4.get_children_with_edges("A")).children} == {"A.c", "A.c2"}
    assert (await p4.get_node("A")).child_count == 2
    assert (await p4.get_node("B")).child_count == 1                 # untouched parent unchanged
    agg4 = await p4.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, ["CONTAINS"], ["LINEAGE"])
    assert [(e.source_urn, e.target_urn, e.edge_count) for e in agg4.aggregated_edges] == [("A", "B", 1)]  # no lineage delta

    # ── deleted node ⇒ it's gone, others remain ────────────────────────────────
    p5 = _mk(base, {**_EMPTY, "nodesRemove": [{"urn": "B.c"}]})
    assert await p5.get_node("B.c") is None
    assert {n.urn for n in await p5.get_nodes(NodeQuery())} == {"A", "B", "A.c"}

    # ── MODIFIED existing node (rename) ⇒ tree UNCHANGED. Regression: the upsert from
    #    branch_overlay_delta has no childCount/parent context, so a plain replace dropped the
    #    node's childCount to 0 AND (for a child) hoisted it to top-level — i.e. ONE rename
    #    "broke the entire containment tree". `nodesNew` is empty (it's modified, not created). ──
    p6 = _mk(base, {**_EMPTY, "nodesNew": [],
                    "nodesUpsert": [{"urn": "A", "entityType": "Table", "displayName": "A_RENAMED"}]})
    assert (await p6.get_node("A")).display_name == "A_RENAMED"     # rename visible
    assert (await p6.get_node("A")).child_count == 1               # childCount PRESERVED (not 0)
    top6 = (await p6.get_top_level_or_orphan_nodes()).nodes
    assert {n.urn for n in top6} == {"A", "B"}                     # A not duplicated/hoisted
    assert next(n for n in top6 if n.urn == "A").child_count == 1  # and keeps its count at top-level
    assert {c.urn for c in (await p6.get_children_with_edges("A")).children} == {"A.c"}  # children intact

    # ── renaming a CHILD keeps it under its parent, never hoists it to top-level ─
    p7 = _mk(base, {**_EMPTY, "nodesNew": [],
                    "nodesUpsert": [{"urn": "A.c", "entityType": "Column", "displayName": "A.c_RENAMED"}]})
    assert (await p7.get_node("A.c")).display_name == "A.c_RENAMED"
    assert {n.urn for n in (await p7.get_top_level_or_orphan_nodes()).nodes} == {"A", "B"}  # A.c NOT top-level
    assert {c.urn for c in (await p7.get_children_with_edges("A")).children} == {"A.c"}      # still A's child

    # ── a CREATED orphan (nodesNew) DOES appear at top-level (the legit new-root case) ─
    p8 = _mk(base, {**_EMPTY, "nodesNew": ["Z"],
                    "nodesUpsert": [{"urn": "Z", "entityType": "Table", "displayName": "Z"}]})
    assert {n.urn for n in (await p8.get_top_level_or_orphan_nodes()).nodes} == {"A", "B", "Z"}


def test_draft_overlay_invariant_and_delta():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("draft overlay invariant + sparse delta: OK")
