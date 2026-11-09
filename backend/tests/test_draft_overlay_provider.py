"""DraftOverlayProvider — the invariant + sparse-delta overlay, proven deterministically (no infra).

A draft opened off main must read IDENTICALLY to main until it changes something; then only the
changed entities differ. We prove this against a stub "main" provider with a fixed graph: an empty
delta is a byte-for-byte pass-through (the invariant), and add/remove/edit deltas patch exactly the
affected nodes/edges/rollups and nothing else. The delta-computation service methods
(``branch_overlay_delta``, and the containment chains rollups are placed by) are stubbed here and
exercised against live Postgres elsewhere — this test pins the provider's overlay *application* logic.
"""
import asyncio

import pytest

from backend.common.models.graph import (
    AggregatedEdgeInfo, AggregatedEdgeResult, ChildrenWithEdgesResult, EdgeQuery, GraphNode,
    NodeQuery, TopLevelNodesResult, TraceFocus, TraceResult,
)
from backend.app.providers.draft_overlay_provider import (
    DraftOverlayProvider, _DeltaCache, _OverlayDelta,
)


# The stub tree's containment chains: A ⊃ A.c, B ⊃ B.c.
CHAINS = {"A.c": ["A"], "B.c": ["B"], "A": [], "B": []}


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

    def set_node_identity(self, identity_property=None, name_property=None):
        self.identity = (identity_property, name_property)

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

    async def get_ancestor_chains(self, urns):
        return {u: CHAINS[u] for u in urns if u in CHAINS}

    async def expand_aggregated(self, *a, **kw):
        return TraceResult(nodes=list(self.nodes.values()), edges=[],
                           focus=TraceFocus(urn="A", level=0, entityType="Table"), effectiveLevel=0)


class FakeSvc:
    def __init__(self, delta, payloads=None):
        self._delta = delta
        self._payloads = payloads or {}            # entity id -> the draft's value, reader-shaped
        self.version = (object(),)                 # a fresh draft per stub: nothing cached is shared
        self.builds = 0
        self.loads = []

    async def overlay_version(self, *, graph_id, branch_id):
        return self.version

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        self.builds += 1
        return self._delta

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids):
        self.loads.append(list(entity_ids))
        return [self._payloads[e] for e in entity_ids if e in self._payloads]

    async def ancestor_chains(self, *, graph_id, branch_id, urns, containment_edge_types, as_of_seq=None):
        return {u: CHAINS[u] for u in urns if u in CHAINS}


_EMPTY = {"nodesUpsert": [], "nodesRemove": [], "edgesUpsert": [], "edgesRemove": []}


def _mk(base, delta):
    p = DraftOverlayProvider(base, svc=FakeSvc(delta), graph_id="g", branch_id="d")
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

    # ── a base that cannot do closures (StubMain, like VersionedBranchProvider
    #    on a stale projection) ⇒ the overlay says so the way every sibling
    #    read does, rather than reaching for a method that is not there and
    #    turning a 501 into an AttributeError 500. ────────────────────────────
    with pytest.raises(NotImplementedError):
        await p.trace_closure("A", 1, 1, ["LINEAGE"], ["CONTAINS"], 100, 1000)

    # ── added lineage edge ⇒ that rollup +1, nothing else moves ─────────────────
    p2 = _mk(base, {**_EMPTY, "edgesUpsert": [
        {"id": "lin2", "sourceUrn": "A.c", "targetUrn": "B.c", "edgeType": "LINEAGE", "confidence": 1.0, "properties": {}}]})
    agg2 = await p2.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, ["CONTAINS"], ["LINEAGE"])
    assert {(e.source_urn, e.target_urn): e.edge_count for e in agg2.aggregated_edges} == {("A", "B"): 2}

    # ── removed base lineage edge ⇒ rollup drops to 0 (edge disappears) ─────────
    p3 = _mk(base, {**_EMPTY, "edgesRemove": [
        {"id": "lin1", "sourceUrn": "A.c", "targetUrn": "B.c", "edgeType": "LINEAGE", "confidence": 1.0, "properties": {}}]})
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


def test_set_node_identity_reaches_the_base_provider():
    """The mapping must survive the overlay hop.

    ContextEngine._inject_identity is hasattr-gated, so a missing passthrough
    here does not raise — it silently leaves the shared, cached base provider
    on the PREVIOUS source's mapping, and an id-keyed source read through a
    draft hydrates as an empty graph. Also pin the reset: passing None is a
    real instruction ("restore the platform defaults"), not a no-op.
    """
    base = StubMain()
    p = _mk(base, _EMPTY)

    p.set_node_identity("asset_id", "asset_name")
    assert base.identity == ("asset_id", "asset_name")

    p.set_node_identity(None, None)
    assert base.identity == (None, None)


def test_a_lineage_delta_keeps_the_base_answers_freshness():
    """With a lineage delta the overlay rebuilt the result from four fields,
    dropping the rest: a base that gave up part of its read lost its
    degraded detail and truncation reason, was cached as complete for the
    full TTL, and an unmaterialized base never told the draft canvas so."""
    from backend.app.services.graph_cache import _is_incomplete_result

    class _ShortMain(StubMain):
        async def get_aggregated_edges_between(self, *a, **kw):
            base = await super().get_aggregated_edges_between(*a, **kw)
            return base.model_copy(update={
                "truncated": True, "stale": True, "stale_reason": "unmaterialized",
                "stamp_version": 2, "regime": "boundary", "truncation_reason": "timeout",
                "degraded_detail": {"kind": "timeout", "degradedBatches": 1},
            })

    p = _mk(_ShortMain(), {**_EMPTY, "edgesUpsert": [
        {"id": "lin2", "sourceUrn": "A.c", "targetUrn": "B.c", "edgeType": "LINEAGE", "confidence": 1.0, "properties": {}}]})
    agg = asyncio.run(p.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, ["CONTAINS"], ["LINEAGE"]))

    assert {(e.source_urn, e.target_urn): e.edge_count for e in agg.aggregated_edges} == {("A", "B"): 2}
    assert agg.total_source_edges == 2
    assert (agg.truncated, agg.stale, agg.stale_reason) == (True, True, "unmaterialized")
    assert (agg.stamp_version, agg.regime, agg.last_materialized_at) == (2, "boundary", "t0")
    assert agg.truncation_reason == "timeout" and agg.degraded_detail == {"kind": "timeout", "degradedBatches": 1}
    assert _is_incomplete_result(agg)


class _CountingMain(StubMain):
    """Main's degree counts for its one flow, A.c → B.c: the columns count it,
    and the tables hold its roll-up cells (A out, B in)."""

    def __init__(self):
        super().__init__()
        self.asked = []
        self.urns_asked = []

    async def get_node_degrees(self, urns, edge_types=None, *, include_rollups=False):
        self.asked.append(include_rollups)
        self.urns_asked.append(list(urns))
        flows = {"A.c": (0, 1), "B.c": (1, 0)}
        cells = {"A": (0, 1), "B": (1, 0), "A.c": (0, 1), "B.c": (1, 0)}
        out = {}
        for u in urns:
            if u == "lost" or u not in self.nodes:
                continue                                     # its bucket failed: unknown
            i, o = flows.get(u, (0, 0))
            out[u] = {"in": i, "out": o}
            if include_rollups:
                ri, ro = cells.get(u, (0, 0))
                out[u].update(rollupIn=ri, rollupOut=ro)
        return out


class _ChainSvc(FakeSvc):
    """The draft's containment chains, as the branch reader walks them."""

    CHAINS = {"A.c": ["A"], "B.c": ["B"], "A": [], "B": [], "N.c": ["N"], "N": []}

    def __init__(self, delta):
        super().__init__(delta)
        self.chains_asked = []

    async def ancestor_chains(self, *, graph_id, branch_id, urns, containment_edge_types, as_of_seq=None):
        self.chains_asked.append(sorted(urns))
        return {u: self.CHAINS[u] for u in urns if u in self.CHAINS}


def _lin(eid, s, t, etype="LINEAGE"):
    return {"id": eid, "sourceUrn": s, "targetUrn": t, "edgeType": etype, "confidence": 1.0, "properties": {}}


def _counting_draft(delta):
    svc = _ChainSvc(delta)
    p = DraftOverlayProvider(_CountingMain(), svc=svc, graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p, svc


URNS = ["A", "B", "A.c", "B.c", "lost"]


def test_a_draft_counts_lineage_through_its_base():
    """/nodes/degree was a 501 on every draft, so on a draft no card had a
    lineage marker unless a line of it was drawn. A draft that changed no
    lineage reads main's counts exactly, roll-up presence and unknowns included."""
    p, svc = _counting_draft(_EMPTY)
    got = asyncio.run(p.get_node_degrees(URNS, ["LINEAGE"], include_rollups=True))
    assert got == asyncio.run(_CountingMain().get_node_degrees(URNS, ["LINEAGE"], include_rollups=True))
    assert "lost" not in got                                  # absent stays unknown
    assert svc.chains_asked == []                              # nothing to roll up, nothing walked
    # A plain ask is passed on plain: a base that knows no roll-ups still answers it.
    assert asyncio.run(p.get_node_degrees(["A.c"], ["LINEAGE"])) == {"A.c": {"in": 0, "out": 1}}
    assert p._base.asked == [True, False]


def test_a_draft_counts_its_own_flows_on_top_of_main():
    """The draft removed main's A.c → B.c and added B.c → A.c: the columns'
    counts move by those flows, and each added flow gives its ends and their
    containers a roll-up that way. A removed flow leaves main's flag alone —
    other flows may hold that cell, and a flag left set keeps a marker solid,
    never falsely hollow. A flow of a type not counted moves nothing."""
    p, svc = _counting_draft({**_EMPTY,
                              "edgesUpsert": [_lin("lin2", "B.c", "A.c"), _lin("x", "A.c", "B.c", "OTHER")],
                              "edgesRemove": [_lin("lin1", "A.c", "B.c")]})
    got = asyncio.run(p.get_node_degrees(URNS, ["lineage"], include_rollups=True))
    assert got == {
        "A.c": {"in": 1, "out": 0, "rollupIn": 1, "rollupOut": 1},
        "B.c": {"in": 0, "out": 1, "rollupIn": 1, "rollupOut": 1},
        "A": {"in": 0, "out": 0, "rollupIn": 1, "rollupOut": 1},
        "B": {"in": 0, "out": 0, "rollupIn": 1, "rollupOut": 1},
    }
    assert svc.chains_asked == [["A.c", "B.c"]]              # one walk, for the added flow's ends


def test_a_draft_answers_what_it_created_from_its_own_flows():
    """The draft created N, N.c inside it, and a flow A.c -> N.c. They are
    not in main's graph, so asking main about them cost a full-scan degree
    query on FalkorDB, which on a large graph passed its deadline and left
    them out: unknown, asked again on the canvas's backoff for as long as the
    draft was open. Their only lineage is the draft's own, so the draft
    answers them itself and never asks main."""
    new = {"urn": "N", "entityType": "Table", "displayName": "N"}
    p, svc = _counting_draft({**_EMPTY,
                              "nodesNew": ["N", "N.c"],
                              "nodesUpsert": [new, {**new, "urn": "N.c", "entityType": "Column"}],
                              "edgesUpsert": [_lin("lin2", "A.c", "N.c"),
                                              _lin("n>c", "N", "N.c", "CONTAINS")]})
    got = asyncio.run(p.get_node_degrees([*URNS, "N", "N.c"], ["LINEAGE"], include_rollups=True))
    assert p._base.urns_asked == [URNS]
    assert got["N.c"] == {"in": 1, "out": 0, "rollupIn": 1, "rollupOut": 0}
    assert got["N"] == {"in": 0, "out": 0, "rollupIn": 1, "rollupOut": 0}
    assert got["A.c"] == {"in": 0, "out": 2, "rollupIn": 0, "rollupOut": 1}
    assert "lost" not in got

    got = asyncio.run(p.get_node_degrees(["N", "N.c"], ["LINEAGE"]))
    assert got == {"N": {"in": 0, "out": 0}, "N.c": {"in": 1, "out": 0}}
    assert len(p._base.urns_asked) == 1                      # nothing of main's to ask


def test_a_failed_rollup_walk_keeps_the_counts():
    """The walk that places the draft's added flows under their containers
    failed, and the whole /nodes/degree chunk was a 500: the counts main had
    answered were lost with it, and the canvas marked every card of the chunk
    missed. As when main's own probe fails, the counts stand and only the
    roll-up flags are left out, so the canvas asks for them again."""
    class _WalkFails(_ChainSvc):
        async def ancestor_chains(self, **kw):
            raise RuntimeError("connection reset")

    p = DraftOverlayProvider(_CountingMain(), svc=_WalkFails({**_EMPTY, "edgesUpsert": [_lin("lin2", "B.c", "A.c")]}),
                             graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    got = asyncio.run(p.get_node_degrees(URNS, ["LINEAGE"], include_rollups=True))
    assert got == {"A": {"in": 0, "out": 0}, "B": {"in": 0, "out": 0},
                   "A.c": {"in": 1, "out": 1}, "B.c": {"in": 1, "out": 1}}


def test_a_draft_over_a_base_that_cannot_count_says_so():
    """A draft on a stale projection is served by the versioned reader, which
    cannot count: the draft says so as its other unsupported reads do (a 501
    at the route), rather than an AttributeError."""
    p = _mk(StubMain(), _EMPTY)
    with pytest.raises(NotImplementedError):
        asyncio.run(p.get_node_degrees(["A"], ["LINEAGE"], include_rollups=True))


# ── An edge the overlay changed: served with its value, counted where it runs ────────────────
def _was(e, **base):
    """``e`` as a lazy overlay entry (its id, type and ends) over an edge the base holds too: at
    ``base``'s ends (``s``, ``t``), its own unless given."""
    return {**{k: e[k] for k in ("id", "sourceUrn", "targetUrn", "edgeType")}, "lazy": True,
            "was": {"sourceUrn": base.get("s", e["sourceUrn"]),
                    "targetUrn": base.get("t", e["targetUrn"]), "edgeType": e["edgeType"]}}


class _EdgesMain(_CountingMain):
    """Main holding A.c → B.c (lin1) and A ⊃ A.c (cA), each with properties of its own."""
    LIN = {**_lin("lin1", "A.c", "B.c"), "properties": {"w": "main"}}
    CONT = {**_lin("cA", "A", "A.c", "CONTAINS"), "properties": {"p": "main"}}

    async def get_edges(self, query: EdgeQuery):
        from backend.common.models.graph import GraphEdge
        return [GraphEdge(**self.LIN), GraphEdge(**self.CONT)]

    async def get_children_with_edges(self, parent_urn, **kw):
        from backend.common.models.graph import GraphEdge
        res = await super().get_children_with_edges(parent_urn, **kw)
        cont = [GraphEdge(**self.CONT)] if parent_urn == "A" else []
        return res.model_copy(update={"containment_edges": cont})

    async def trace_at_level(self, urn, *a, **kw):
        from backend.common.models.graph import GraphEdge
        res = await super().trace_at_level(urn, *a, **kw)
        return res.model_copy(update={"edges": [GraphEdge(**self.LIN)]})


class _EdgeSvc(_ChainSvc):
    """Loads the overlay's value of an edge."""

    def __init__(self, delta, values):
        super().__init__(delta)
        self.values = values

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node"):
        self.loads.append(list(entity_ids))
        return [self.values[e] for e in entity_ids if e in self.values] if kind == "edge" else []


def _edged(delta, values):
    svc = _EdgeSvc(delta, values)
    p = DraftOverlayProvider(_EdgesMain(), svc=svc, graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p, svc


def test_an_edge_changed_where_it_runs_is_served_and_counted_as_main_counts_it():
    """An edge the overlay holds as a value of its own, between the ends main has it at — a
    draft's own property edit, the rewind of one main made after the draft's base, a fork's
    either way — reads with the overlay's value everywhere it is served, and moves no count:
    no rollup, degree or child count. Before, each was counted once more."""
    async def run():
        p, svc = _edged({**_EMPTY, "edgesUpsert": [_was(_EdgesMain.LIN), _was(_EdgesMain.CONT)]},
                        {"lin1": {**_EdgesMain.LIN, "properties": {"w": "overlay"}},
                         "cA": {**_EdgesMain.CONT, "properties": {"p": "overlay"}}})
        main = _EdgesMain()
        agg = await p.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, ["CONTAINS"], ["LINEAGE"])
        assert [(e.source_urn, e.target_urn, e.edge_count) for e in agg.aggregated_edges] == [("A", "B", 1)]
        assert svc.chains_asked == []                        # nothing to place
        assert await p.get_node_degrees(URNS, ["LINEAGE"], include_rollups=True) == \
            await main.get_node_degrees(URNS, ["LINEAGE"], include_rollups=True)
        assert (await p.get_node("A")).child_count == 1
        kids = await p.get_children_with_edges("A")
        assert kids.total_children == 1 and [c.urn for c in kids.children] == ["A.c"]
        assert [(e.id, e.properties) for e in kids.containment_edges] == [("cA", {"p": "overlay"})]
        assert {e.id: e.properties for e in await p.get_edges(EdgeQuery())} == {
            "lin1": {"w": "overlay"}, "cA": {"p": "overlay"}}
        trace = await p.trace_at_level("A", 0, 1, 1, ["LINEAGE"], ["CONTAINS"], 100, 1000)
        assert [(e.id, e.properties) for e in trace.edges] == [("lin1", {"w": "overlay"})]
    asyncio.run(run())


def test_an_edge_the_overlay_moved_is_counted_where_it_runs_now():
    """A changed edge whose ends moved counts where the overlay has it and no longer where main
    holds it: its rollup and degrees move with it, and so does a child from one parent to the
    other."""
    async def run():
        flow = _was(_lin("lin1", "B.c", "A.c"), s="A.c", t="B.c")
        cont = _was(_lin("cA", "B", "A.c", "CONTAINS"), s="A")
        p, svc = _edged({**_EMPTY, "edgesUpsert": [flow, cont]}, {})
        agg = await p.get_aggregated_edges_between(["A", "B"], ["A", "B"], None, ["CONTAINS"], ["LINEAGE"])
        # Off where main counted it (A, B), on where it runs now (B, A).
        assert [(e.source_urn, e.target_urn, e.edge_count) for e in agg.aggregated_edges] == [("B", "A", 1)]
        got = await p.get_node_degrees(["A.c", "B.c"], ["LINEAGE"])
        assert got == {"A.c": {"in": 1, "out": 0}, "B.c": {"in": 0, "out": 1}}
        assert ((await p.get_node("A")).child_count, (await p.get_node("B")).child_count) == (0, 2)
    asyncio.run(run())

# ── A large draft: modified nodes come by name, and a read loads just the ones it serves ─────
_MODIFIED = {**_EMPTY, "nodesModified": [
    {"urn": "A", "entityId": "e0"}, {"urn": "A.c", "entityId": "e1"}, {"urn": "B.c", "entityId": "e2"}]}
_DRAFT_VALUES = {"e0": {"urn": "A", "entityType": "Table", "displayName": "A v2"},
                 "e1": {"urn": "A.c", "entityType": "Column", "displayName": "A.c v2"},
                 "e2": {"urn": "B.c", "entityType": "Column", "displayName": "B.c v2"}}


def _prov(svc):
    p = DraftOverlayProvider(StubMain(), svc=svc, graph_id="g", branch_id="d")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def test_a_read_loads_only_the_modified_nodes_it_serves():
    """A draft that modified 100k nodes must not load 100k payloads to serve one page."""
    async def run():
        svc = FakeSvc(_MODIFIED, payloads=_DRAFT_VALUES)
        p = _prov(svc)
        kids = (await p.get_children_with_edges("A")).children
        assert [(c.urn, c.display_name) for c in kids] == [("A.c", "A.c v2")]
        assert svc.loads == [["e1"]]
        assert (await p.get_node("B.c")).display_name == "B.c v2"
        assert (await p.get_node("B.c")).display_name == "B.c v2"
        assert svc.loads == [["e1"], ["e2"]], "a request loads a node once"
        assert (await p.get_node("B")).display_name == "B"
        assert svc.loads == [["e1"], ["e2"]], "an unmodified node loads nothing"
    asyncio.run(run())


def test_every_read_serves_the_drafts_value_of_a_modified_node():
    async def run():
        p = _prov(FakeSvc(_MODIFIED, payloads=_DRAFT_VALUES))
        names = {n.urn: n.display_name for n in await p.get_nodes(NodeQuery())}
        assert names == {"A": "A v2", "B": "B", "A.c": "A.c v2", "B.c": "B.c v2"}
        assert [n.display_name for n in await p.search_nodes("B.c")] == ["B.c v2"]
        top = {n.urn: n for n in (await p.get_top_level_or_orphan_nodes()).nodes}
        assert (top["A"].display_name, top["A"].child_count) == ("A v2", 1), "keeps main's childCount"
        assert (await p.get_node("A")).child_count == 1
        assert (await p.resolve_identities(["A.c", "B"]))["A.c"]["name"] == "A.c v2"
    asyncio.run(run())


def test_reads_share_one_delta_until_the_draft_moves():
    """Rebuilding the delta per read cost every read of a large draft seconds and a gigabyte."""
    async def run():
        svc = FakeSvc(_MODIFIED, payloads=_DRAFT_VALUES)
        await asyncio.gather(*(_prov(svc).get_node("A") for _ in range(5)))
        assert svc.builds == 1, "five reads at once build it once"
        await _prov(svc).get_node("A")
        assert svc.builds == 1, "a later read reuses it"
        svc.version = (object(),)                        # the draft took a commit
        await _prov(svc).get_node("A")
        assert svc.builds == 2
    asyncio.run(run())


# ── The cache: bounded by what its deltas hold, a fork's next delta extending its last ──────
def _sized(n: int):
    async def build():
        return _OverlayDelta({"nodesRemove": [{"urn": f"u{i}", "entityId": f"e{i}"}
                                              for i in range(n)]}, [])
    return build


def test_the_cache_holds_as_many_deltas_as_their_entries_allow():
    """Two deltas were all a process kept: many drafts and forks read at once evicted each other
    on every read. It keeps what fits GRAPHVER_OVERLAY_CACHE_ENTRIES together, the least recently
    read going first, and always the newest, whatever its size."""
    async def run():
        cache = _DeltaCache(max_entries=10)
        for g in ("a", "b", "c"):
            await cache.get((g, "d", 1, ()), _sized(3))
        assert [k[0] for k in cache._items] == ["a", "b", "c"]
        await cache.get(("a", "d", 1, ()), _sized(3))            # read again: the most recent
        await cache.get(("e", "d", 1, ()), _sized(3))            # 12 > 10: b, the coldest, goes
        assert [k[0] for k in cache._items] == ["c", "a", "e"]
        await cache.get(("f", "d", 1, ()), _sized(50))           # alone past the bound: kept
        assert [k[0] for k in cache._items] == ["f"]
    asyncio.run(run())


def test_a_newer_delta_of_a_draft_takes_its_older_ones_place():
    async def run():
        cache = _DeltaCache(max_entries=100)
        await cache.get(("g", "d", 1, ()), _sized(3))
        await cache.get(("g", "d2", 1, ()), _sized(3))
        await cache.get(("g", "d", 2, ()), _sized(3))
        assert list(cache._items) == [("g", "d2", 1, ()), ("g", "d", 2, ())]
    asyncio.run(run())


class _ForkSvc(FakeSvc):
    """A fork's main: each patch set says what it is of, and the service is handed the last."""

    def __init__(self):
        super().__init__(_EMPTY)
        self.handed = []

    async def branch_overlay_delta(self, *, graph_id, branch_id, extend=None):
        self.handed.append(extend)
        self.builds += 1
        return {**_EMPTY, "since": {"rootHead": self.builds}}


def test_a_forks_next_delta_is_handed_its_last_to_extend():
    """When only its root moved, a fork's patch set is the last one extended by the root's
    window: the build is handed the patch set the cache holds of the fork. A draft's is built
    afresh, as before (its patch set says nothing of what it is of)."""
    async def run():
        svc = _ForkSvc()

        def fork():
            return DraftOverlayProvider(StubMain(), svc=svc, graph_id="g_ext", branch_id="m",
                                        fork=True)
        await fork().get_node("A")
        svc.version = (object(),)                                # its root moved
        await fork().get_node("A")
        assert svc.handed == [None, {**_EMPTY, "nodesModified": [], "nodesNew": [],
                                     "since": {"rootHead": 1}}]
        draft = FakeSvc(_EMPTY)
        await DraftOverlayProvider(StubMain(), svc=draft, graph_id="g_ext", branch_id="d").get_node("A")
        assert draft.builds == 1                                 # no extend handed (none to give)
    asyncio.run(run())

def test_a_forks_delta_keeps_its_patch_set_compact_for_the_next_extension():
    """A fork's delta kept its patch set as built, a dict per entry beside the index built from
    it, for the next extension: 1,043 bytes an entry with the index, where the index alone holds
    737. It keeps what the extension needs, each entry's fields as a tuple over the strings the
    index holds already (865 bytes an entry with the index), and the extension gets the patch set
    back as it was built."""
    import copy as _copy
    raw = {"nodesUpsert": [{"urn": "N", "entityId": "eN", "entityType": "Table", "displayName": "N",
                            "qualifiedName": None, "lazy": True}],
           "nodesModified": [{"entityId": "e1", "urn": "A.c", "entityType": "Column",
                              "displayName": "c", "qualifiedName": "A.c"},
                             {"entityId": "e4", "urn": "B.d", "entityType": "Column",
                              "displayName": "d", "qualifiedName": None, "baseUrn": "B.e"}],
           "nodesRemove": [{"entityId": "e2", "urn": "B.c"}],
           "edgesUpsert": [{"id": "f1", "sourceUrn": "A.c", "targetUrn": "N", "edgeType": "FLOWS",
                            "lazy": True},
                           {"id": "f2", "sourceUrn": "A.c", "targetUrn": "N", "edgeType": "FLOWS",
                            "lazy": True,
                            "was": {"sourceUrn": "A.c", "targetUrn": "A", "edgeType": "FLOWS"}}],
           "edgesRemove": [{"id": "f3", "sourceUrn": "B.c", "targetUrn": "A.c", "edgeType": "FLOWS"}],
           "nodesNew": ["N"], "since": {"head": "c1", "layers": [3, 1], "rootHead": 7}}
    d = _OverlayDelta(_copy.deepcopy(raw), ["CONTAINS"])
    kept = [x for key in ("nodesUpsert", "nodesModified", "nodesRemove", "edgesUpsert", "edgesRemove")
            for x in d.raw[key]]
    assert len(kept) == 7 and not any(isinstance(x, dict) for x in kept)
    from backend.app.providers.draft_overlay_provider import _unkept
    assert _unkept(d.raw) == raw
    assert _OverlayDelta(_copy.deepcopy({**raw, "since": None}), ["CONTAINS"]).raw is None  # a draft's


def test_the_overlay_caches_default_holds_under_half_a_gigabyte():
    """GRAPHVER_OVERLAY_CACHE_ENTRIES bounds the entries a process's cached deltas hold together.
    At about 1.2 KB an entry (measured: 0.74 KB a draft's, 0.87 KB a fork's, before allocator
    slack and the chains a rollup read keeps), its old default of 1,000,000 let one web process
    hold 1.2 GB. Its default keeps them under 512 MB."""
    import re
    from backend.app.services.versioning import config
    with open(config.__file__) as f:
        source = f.read()
    default = int(re.search(r'"GRAPHVER_OVERLAY_CACHE_ENTRIES", "(\d+)"', source).group(1))
    assert default * 1_200 <= 512 * 2 ** 20, default


if __name__ == "__main__":
    asyncio.run(_run())
    print("draft overlay invariant + sparse delta: OK")
