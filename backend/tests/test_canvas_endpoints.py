"""Batched canvas endpoints (WS5): one bootstrap request returns roots +
edges + aggregated in a single payload; one expand request returns children
+ the aggregated DELTA touching only the new children (with the expanded
parent excluded per the double-count rule), and freshness propagates from
the aggregated read.

The endpoints are called directly with a fake engine and no workspace scope
(so they bypass GraphCache and exercise the composition logic — the wave
gathering, delta filtering, exclusion rule, freshness plumbing).
"""
import asyncio

from fastapi import Response

from backend.app.api.v1.endpoints.canvas import (
    canvas_bootstrap,
    canvas_expand,
    _merge_aggregated,
)
from backend.app.models.canvas import CanvasBootstrapRequest, CanvasExpandRequest
from backend.common.models.graph import (
    AggregatedEdgeInfo,
    AggregatedEdgeResult,
    ChildrenWithEdgesResult,
    GraphEdge,
    GraphNode,
    TopLevelNodesResult,
)


def _node(urn):
    return GraphNode(urn=urn, displayName=urn, entityType="Node")


def _agg(pairs, **kw):
    return AggregatedEdgeResult(
        aggregatedEdges=[
            AggregatedEdgeInfo(
                id=f"agg-{s}-{t}", sourceUrn=s, targetUrn=t, edgeCount=w,
                edgeTypes=["FLOWS_TO"], confidence=1.0, sourceEdgeIds=[],
            )
            for s, t, w in pairs
        ],
        totalSourceEdges=sum(w for _, _, w in pairs),
        **kw,
    )


class _FakeEngine:
    """Records the aggregated requests it receives; no workspace scope so
    the endpoints skip GraphCache and run compute() directly."""

    def __init__(self, roots=None, children=None, agg_for=None):
        self._roots = roots or []
        self._children = children or []
        self._agg_for = agg_for or (lambda req: _agg([]))
        self.agg_requests = []
        self.edge_requests = []
        self.provider = object()

    async def get_top_level_or_orphan_nodes(self, **kw):
        return TopLevelNodesResult(
            nodes=self._roots, totalCount=len(self._roots), hasMore=False,
            rootTypeCount=len(self._roots), orphanCount=0,
        )

    async def get_edges(self, query):
        self.edge_requests.append(query)
        return [GraphEdge(id="e1", sourceUrn=query.source_urns[0],
                          targetUrn=query.source_urns[-1], edgeType="FLOWS_TO")]

    async def get_aggregated_edges(self, request):
        self.agg_requests.append(request)
        return self._agg_for(request)

    async def get_children_with_edges(self, urn, **kw):
        return ChildrenWithEdgesResult(
            children=self._children, containmentEdges=[], lineageEdges=[],
            totalChildren=len(self._children), hasMore=False,
        )


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── _merge_aggregated ────────────────────────────────────────────────


def test_merge_dedupes_and_ors_stale():
    a = _agg([("x", "y", 2)], stale=False, regime="boundary", stampVersion=2)
    b = _agg([("x", "y", 2), ("z", "y", 3)], stale=True, staleReason="unmaterialized")
    merged = _merge_aggregated([a, b])
    pairs = {(e.source_urn, e.target_urn): e.edge_count for e in merged.aggregated_edges}
    assert pairs == {("x", "y"): 2, ("z", "y"): 3}  # deduped
    assert merged.stale is True and merged.stale_reason == "unmaterialized"
    assert merged.regime == "boundary"


def test_merge_all_none_returns_none():
    assert _merge_aggregated([None, None]) is None


# ── bootstrap ────────────────────────────────────────────────────────


def test_bootstrap_returns_roots_edges_and_aggregated_in_one_payload():
    roots = [_node("urn:a"), _node("urn:b")]
    eng = _FakeEngine(roots=roots, agg_for=lambda r: _agg(
        [("urn:a", "urn:b", 4)], stale=False, regime="boundary", stampVersion=2))
    result = _run(canvas_bootstrap(
        Response(), CanvasBootstrapRequest(), eng, session=None))
    assert [n.urn for n in result.roots.nodes] == ["urn:a", "urn:b"]
    assert result.edges  # edges-among-roots leg ran (>=2 roots)
    assert result.aggregated is not None
    assert {(e.source_urn, e.target_urn) for e in result.aggregated.aggregated_edges} == {
        ("urn:a", "urn:b")}
    assert result.freshness.regime == "boundary"
    assert result.freshness.stale is False


def test_bootstrap_skips_edges_leg_for_single_root():
    eng = _FakeEngine(roots=[_node("urn:solo")])
    result = _run(canvas_bootstrap(
        Response(), CanvasBootstrapRequest(), eng, session=None))
    assert result.edges == []  # <2 roots → no edges query
    assert eng.edge_requests == []


def test_bootstrap_include_aggregated_false_skips_aggregated():
    eng = _FakeEngine(roots=[_node("urn:a"), _node("urn:b")])
    result = _run(canvas_bootstrap(
        Response(), CanvasBootstrapRequest(includeAggregated=False), eng, session=None))
    assert result.aggregated is None
    assert eng.agg_requests == []


# ── expand ───────────────────────────────────────────────────────────


def test_expand_delta_excludes_parent_and_queries_both_directions():
    children = [_node("urn:c1"), _node("urn:c2")]
    eng = _FakeEngine(children=children, agg_for=lambda r: _agg([]))
    _run(canvas_expand(Response(), CanvasExpandRequest(
        parentUrn="urn:parent",
        visibleUrns=["urn:parent", "urn:sibling"],
    ), eng))
    # Two directional aggregated reads (fan-out + fan-in).
    assert len(eng.agg_requests) == 2
    fanout, fanin = eng.agg_requests
    # Fan-out sources ARE the new children; targets = visible ∪ new, MINUS
    # the expanded parent (double-count exclusion).
    assert set(fanout.source_urns) == {"urn:c1", "urn:c2"}
    assert "urn:parent" not in fanout.target_urns
    assert "urn:sibling" in fanout.target_urns
    assert set(fanin.target_urns) == {"urn:c1", "urn:c2"}
    assert "urn:parent" not in fanin.source_urns


def test_expand_no_children_skips_aggregated():
    eng = _FakeEngine(children=[])
    result = _run(canvas_expand(Response(), CanvasExpandRequest(
        parentUrn="urn:parent", visibleUrns=["urn:x"]), eng))
    assert result.aggregated_delta is None
    assert eng.agg_requests == []


def test_expand_propagates_freshness():
    children = [_node("urn:c1")]
    eng = _FakeEngine(children=children, agg_for=lambda r: _agg(
        [], stale=True, staleReason="unmaterialized", regime="unknown", stampVersion=1))
    result = _run(canvas_expand(Response(), CanvasExpandRequest(
        parentUrn="urn:parent", visibleUrns=[]), eng))
    assert result.freshness.stale is True
    assert result.freshness.stale_reason == "unmaterialized"
