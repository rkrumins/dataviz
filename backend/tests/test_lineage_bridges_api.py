"""``POST /graph/lineage/bridges`` and ``/lineage/bridges/path`` — end to end.

Route → real ``ContextEngine`` → the generic ``get_edges`` adapter → the
walker, over an in-memory provider holding the chain the feature exists for:
tables A…G, one column each, lineage between the columns. Plus the draft
overlay (a hop the DRAFT created must be visible), the synthetic-rollup strip,
the flag gate, the contract's bounds, and the cache / fair-share registration
a new walk endpoint needs to be protected like the others.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import pytest
from httpx import AsyncClient

from backend.app.services.context_engine import ContextEngine
from backend.app.services.feature_flags import feature_flags
from backend.common.models.graph import (
    EdgeQuery, GraphEdge, GraphNode, LineageBridgesRequest, OntologyMetadata,
)
from backend.tests.test_api_graph import _StubProvider

TABLES = "ABCDEFG"


class _ChainProvider(_StubProvider):
    """Tables A..G each CONTAIN one column; FLOWS runs column to column; an
    :AGGREGATED rollup A→G sits on top the way the aggregation worker writes
    one — a bridge that walked it would claim A reaches G directly."""

    def __init__(self) -> None:
        super().__init__()
        self._nodes = {}
        self._edges = []
        self.parent: Dict[str, str] = {}
        for t in TABLES:
            self._nodes[t] = GraphNode(urn=t, displayName=f"Table {t}", entityType="table")
            self._nodes[f"{t}.c"] = GraphNode(urn=f"{t}.c", displayName=f"{t} col", entityType="column")
            self.parent[f"{t}.c"] = t
            self._edges.append(GraphEdge(id=f"ct-{t}", sourceUrn=t, targetUrn=f"{t}.c", edgeType="CONTAINS"))
        for a, b in zip(TABLES, TABLES[1:]):
            self._edges.append(GraphEdge(id=f"f-{a}{b}", sourceUrn=f"{a}.c", targetUrn=f"{b}.c", edgeType="FLOWS"))
        self._edges.append(GraphEdge(id="agg-AG", sourceUrn="A", targetUrn="G", edgeType="AGGREGATED"))

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return OntologyMetadata(
            containmentEdgeTypes=["CONTAINS"],
            lineageEdgeTypes=["FLOWS", "AGGREGATED"],
            edgeTypeMetadata={}, entityTypeHierarchy={}, rootEntityTypes=[],
        )

    async def get_edges(self, query: EdgeQuery = None) -> List[GraphEdge]:
        out = []
        for e in self._edges:
            if query.source_urns and e.source_urn not in query.source_urns:
                continue
            if query.target_urns and e.target_urn not in query.target_urns:
                continue
            if query.edge_types and e.edge_type not in query.edge_types:
                continue
            out.append(e)
        return out[: query.limit or len(out)]

    async def get_ancestor_chains(self, urns: List[str]) -> Dict[str, List[str]]:
        out = {}
        for u in urns:
            chain, cur = [], self.parent.get(u)
            while cur:
                chain.append(cur)
                cur = self.parent.get(cur)
            out[u] = chain
        return out


class _FastPathProvider(_ChainProvider):
    """A provider with its own walk — the engine must hand it the request."""

    def __init__(self) -> None:
        super().__init__()
        self.asked: Optional[Dict[str, Any]] = None

    async def lineage_bridges(self, **kwargs):
        from backend.common.models.graph import LineageBridgesResult
        self.asked = kwargs
        return LineageBridgesResult()


def _flag(on: bool) -> None:
    """``viewSubsetsEnabled`` is experimental and seeded OFF; primed in the
    cache, which is the path the gate reads in production."""
    feature_flags._cache = {**(feature_flags._cache or {}), "viewSubsetsEnabled": on}
    feature_flags._cache_ts = time.monotonic()


@pytest.fixture(autouse=True)
def subsets_on():
    _flag(True)
    yield
    _flag(False)


async def _post(client: AsyncClient, engine: ContextEngine, path: str, body):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    try:
        return await client.post(f"/api/v1/test-ws/graph/lineage/{path}", json=body)
    finally:
        app.dependency_overrides.pop(get_context_engine, None)


def _members(*urns: str, inherits: bool = True):
    return [{"urn": u, "inheritsChildren": inherits} for u in urns]


async def test_picking_a_c_f_keeps_two_virtual_hops(test_client: AsyncClient):
    resp = await _post(test_client, ContextEngine(provider=_ChainProvider()), "bridges", {
        "members": _members("F", "A", "C"),
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["links"] == [
        {"source": "A", "target": "C", "hops": 2},
        {"source": "C", "target": "F", "hops": 3},
    ]
    assert body["incomplete"] == [] and body["truncated"] is False
    assert set(body) == {"links", "incomplete", "depthLimited", "truncated", "truncationReason", "stats"}
    assert set(body["stats"]) == {"seeds", "interiorNodes", "edgesRead", "forwardDepth", "backwardDepth", "elapsedMs"}
    assert resp.headers.get("X-Provider-Health") == "unknown"


async def test_a_rollup_is_never_walked_as_lineage(test_client: AsyncClient):
    """The A→G :AGGREGATED cell must not become an A→G link."""
    resp = await _post(test_client, ContextEngine(provider=_ChainProvider()), "bridges", {
        "members": _members("A", "G"), "maxHops": 3,
    })
    assert resp.json()["links"] == []


async def test_upstream_from_an_origin(test_client: AsyncClient):
    resp = await _post(test_client, ContextEngine(provider=_ChainProvider()), "bridges", {
        "members": _members("A", "C", "F"), "origins": ["F"], "direction": "upstream",
    })
    assert resp.json()["links"] == [{"source": "C", "target": "F", "hops": 3}]


@pytest.mark.parametrize("body", [
    {"members": []},
    {"members": _members("A"), "maxHops": 21},
    {"members": _members("A"), "maxHops": 0},
    {"members": _members("A"), "maxNodes": 50},
    {"members": _members("A"), "origins": ["Z"]},
    {"members": _members("A"), "direction": "sideways"},
    {"members": _members(*[f"u{i}" for i in range(2001)])},
])
async def test_the_contract_is_bounded(test_client: AsyncClient, body):
    resp = await _post(test_client, ContextEngine(provider=_ChainProvider()), "bridges", body)
    assert resp.status_code == 422, body


async def test_refused_while_the_flag_is_off(test_client: AsyncClient):
    _flag(False)
    resp = await _post(test_client, ContextEngine(provider=_ChainProvider()), "bridges", {
        "members": _members("A", "C"),
    })
    assert resp.status_code == 403
    assert "viewSubsetsEnabled" in resp.text


async def test_a_provider_with_its_own_walk_gets_the_request(test_client: AsyncClient):
    provider = _FastPathProvider()
    resp = await _post(test_client, ContextEngine(provider=provider), "bridges", {
        "members": [{"urn": "C", "inheritsChildren": False}, {"urn": "A"}],
        "origins": ["A"], "maxHops": 4,
    })
    assert resp.status_code == 200
    asked = provider.asked
    assert asked["members"] == {"A": True, "C": False}
    assert asked["origins"] == ["A"] and asked["max_hops"] == 4
    assert asked["lineage_edge_types"] == ["FLOWS"]          # AGGREGATED stripped
    assert asked["containment_edge_types"] == ["CONTAINS"]


async def test_the_hidden_steps_behind_a_hop(test_client: AsyncClient):
    resp = await _post(test_client, ContextEngine(provider=_ChainProvider()), "bridges/path", {
        "members": _members("A", "C", "F"), "source": "C", "target": "F",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["hops"] == 3
    assert body["hiddenUrns"] == ["D.c", "E.c"]
    assert body["endpointUrns"] == ["C.c", "F.c"]
    assert [(e["sourceUrn"], e["targetUrn"]) for e in body["edges"]] == [
        ("C.c", "D.c"), ("D.c", "E.c"), ("E.c", "F.c"),
    ]
    assert body["ancestorChains"]["D.c"] == ["D"]
    assert {n["urn"] for n in body["nodes"]} >= {"D.c", "E.c", "D", "E"}


@pytest.mark.parametrize("body", [
    {"members": _members("A", "C"), "source": "A", "target": "Z"},
    {"members": _members("A", "C"), "source": "A", "target": "A"},
])
async def test_a_path_needs_two_distinct_members(test_client: AsyncClient, body):
    resp = await _post(test_client, ContextEngine(provider=_ChainProvider()), "bridges/path", body)
    assert resp.status_code == 422


async def test_a_draft_edge_creates_a_hop_the_draft_can_see():
    """The overlay's ``get_edges`` is main plus the draft, so a flow the DRAFT
    added (B.c → F.c, a shortcut) is a hop on the draft and not on main."""
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider

    class _Svc:
        async def branch_overlay_delta(self, *, graph_id, branch_id):
            return {"edgesUpsert": [
                {"id": "draft-BF", "sourceUrn": "B.c", "targetUrn": "F.c", "edgeType": "FLOWS"},
            ]}

    base = _ChainProvider()
    overlay = DraftOverlayProvider(base, svc=_Svc(), graph_id="g", branch_id="br_1")
    overlay.set_containment_edge_types(["CONTAINS"])
    request = LineageBridgesRequest(members=[{"urn": "A"}, {"urn": "F"}])

    main_engine = ContextEngine(provider=base)
    on_main = await main_engine.lineage_bridges(request)
    # A draft reader does not introspect; in production its ontology comes from
    # the data source's assignment. Give it main's, as that would.
    draft_engine = ContextEngine(provider=overlay)
    draft_engine._resolved_ontology_cache = await main_engine._resolve_ontology()
    draft_engine._resolved_ontology_cache_ts = time.monotonic()
    on_draft = await draft_engine.lineage_bridges(request)
    assert [(l.source, l.target, l.hops) for l in on_main.links] == [("A", "F", 5)]
    assert [(l.source, l.target, l.hops) for l in on_draft.links] == [("A", "F", 2)]   # A.c→B.c→F.c


def test_both_endpoints_are_cached_like_the_other_walks():
    from backend.app.services import graph_cache

    for endpoint in (graph_cache.ENDPOINT_LINEAGE_BRIDGES, graph_cache.ENDPOINT_LINEAGE_BRIDGE_PATH):
        assert graph_cache._ENABLED_ENDPOINTS[endpoint] is True
        assert graph_cache._resolve_ttl(None, endpoint) == graph_cache._DEFAULT_LINEAGE_BRIDGES_TTL
        # Raw lineage only: a rollup rebuild must not invalidate them.
        assert endpoint not in graph_cache._ROLLUP_ENDPOINTS


def test_both_endpoints_are_fair_shared():
    from backend.app.services import fair_share

    assert fair_share.ENDPOINT_LINEAGE_BRIDGES in fair_share._CONFIGS
    assert fair_share.ENDPOINT_LINEAGE_BRIDGE_PATH in fair_share._CONFIGS


def test_a_budget_cut_keeps_the_full_ttl_and_a_failure_does_not():
    """Only a cap is a pure function of (graph, request)."""
    from backend.app.services.graph_cache import _is_incomplete_result
    from backend.common.models.graph import LineageBridgesResult

    assert not _is_incomplete_result(LineageBridgesResult(truncated=True, truncationReason="max_nodes"))
    assert not _is_incomplete_result(LineageBridgesResult(truncated=True, truncationReason="degree_cap"))
    assert _is_incomplete_result(LineageBridgesResult(truncated=True, truncationReason="timeout"))
    assert _is_incomplete_result(LineageBridgesResult(truncated=True, truncationReason="expand_failed"))
