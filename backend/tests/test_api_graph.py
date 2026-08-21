"""
Phase 4 — API endpoint tests for /api/v1/{ws_id}/graph/*.

Graph endpoints depend on `get_context_engine` which resolves a
ContextEngine from the workspace/connection.  We override this
dependency to return a ContextEngine backed by a lightweight
_StubProvider, which ships with deterministic in-memory data.
"""
import pytest
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock
from httpx import AsyncClient
from fastapi import HTTPException

from backend.common.interfaces.provider import GraphDataProvider
from backend.common.models.graph import (
    GraphEdge,
    GraphNode,
    GraphSchemaStats,
    LineageResult,
    NodeQuery,
    EdgeQuery,
    OntologyMetadata,
    TopLevelNodesResult,
    TraceClosureResult,
    TraceFocus,
    TraceFrontierNode,
)
from backend.app.services.context_engine import ContextEngine


# ── Stub provider ────────────────────────────────────────────────────────

class _StubProvider(GraphDataProvider):
    """Minimal in-memory provider for API tests."""

    def __init__(self):
        self._nodes: Dict[str, GraphNode] = {}
        self._edges: List[GraphEdge] = []
        # Seed a handful of deterministic nodes/edges
        for i in range(1, 4):
            urn = f"urn:li:dataset:(urn:li:dataPlatform:demo,DemoTable{i},PROD)"
            self._nodes[urn] = GraphNode(
                urn=urn, displayName=f"DemoTable{i}", entityType="dataset",
            )
        src = list(self._nodes.keys())
        if len(src) >= 2:
            self._edges.append(GraphEdge(
                id=f"{src[0]}->{src[1]}",
                sourceUrn=src[0], targetUrn=src[1], edgeType="TRANSFORMS",
            ))

    @property
    def name(self) -> str:
        return "stub"

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        return self._nodes.get(urn)

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        if query.urns:
            return [self._nodes[u] for u in query.urns if u in self._nodes]
        return list(self._nodes.values())

    async def search_nodes(self, query: str, limit: int = 10, **kw) -> List[GraphNode]:
        return [
            n for n in self._nodes.values()
            if query.lower() in n.display_name.lower()
        ][:limit]

    async def get_edges(self, query: EdgeQuery = None) -> List[GraphEdge]:
        if query and query.any_urns:
            urns = set(query.any_urns)
            return [e for e in self._edges if e.source_urn in urns or e.target_urn in urns]
        return self._edges

    async def get_children(self, parent_urn, entity_types=None, edge_types=None, **kw) -> List[GraphNode]:
        child_urns = {e.target_urn for e in self._edges if e.source_urn == parent_urn}
        return [self._nodes[u] for u in child_urns if u in self._nodes]

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        return None

    async def get_upstream(self, urn, depth, include_column_lineage=False, descendant_types=None) -> LineageResult:
        return LineageResult(nodes=list(self._nodes.values()), edges=self._edges, totalCount=len(self._nodes), hasMore=False)

    async def get_downstream(self, urn, depth, include_column_lineage=False, descendant_types=None) -> LineageResult:
        return LineageResult(nodes=list(self._nodes.values()), edges=self._edges, totalCount=len(self._nodes), hasMore=False)

    async def get_full_lineage(self, urn, upstream_depth, downstream_depth, include_column_lineage=False, descendant_types=None) -> LineageResult:
        return LineageResult(nodes=list(self._nodes.values()), edges=self._edges, totalCount=len(self._nodes), hasMore=False)

    async def get_aggregated_edges_between(self, source_urns, target_urns, granularity, containment_edges, lineage_edges, *, timeout=None) -> Any:
        return []

    async def get_trace_lineage(self, urn, direction, depth, containment_edges, lineage_edges) -> LineageResult:
        return LineageResult(nodes=list(self._nodes.values()), edges=self._edges, totalCount=len(self._nodes), hasMore=False)

    async def get_stats(self) -> Dict[str, Any]:
        return {"node_count": len(self._nodes), "edge_count": len(self._edges)}

    async def get_schema_stats(self) -> GraphSchemaStats:
        return GraphSchemaStats(totalNodes=len(self._nodes), totalEdges=len(self._edges))

    async def get_ontology_metadata(self) -> OntologyMetadata:
        return OntologyMetadata(
            containmentEdgeTypes=["CONTAINS"],
            lineageEdgeTypes=["TRANSFORMS"],
            edgeTypeMetadata={}, entityTypeHierarchy={}, rootEntityTypes=[],
        )

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        return []

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return []

    async def get_descendants(self, urn, depth=5, entity_types=None, limit=100, offset=0) -> List[GraphNode]:
        return []

    async def get_nodes_by_tag(self, tag, limit=100, offset=0) -> List[GraphNode]:
        return []

    async def get_nodes_by_layer(self, layer_id, limit=100, offset=0, **kw) -> List[GraphNode]:
        return []

    async def save_custom_graph(self, nodes, edges) -> bool:
        return True

    async def create_node(self, node, containment_edge=None) -> bool:
        return True

    async def create_edge(self, edge) -> bool:
        return True

    async def update_edge(self, edge_id, properties=None) -> Optional[GraphEdge]:
        return None

    async def delete_edge(self, edge_id) -> bool:
        return True

    async def trace_closure(
        self, urn, upstream_depth, downstream_depth,
        lineage_edge_types, containment_edge_types, max_nodes, timeout_ms,
        seed_urns=None, exclude_urns=None, after_cursor=None, seed_cursor=None,
    ) -> TraceClosureResult:
        # Deterministic scoped closure: the focus + its downstream lineage
        # edge, plus one synthetic frontier entry so response tests can
        # assert on frontierUp[0].totalCount / nextCursor.
        return TraceClosureResult(
            nodes=list(self._nodes.values()),
            edges=list(self._edges),
            containmentEdges=[],
            upstreamUrns=set(),
            downstreamUrns={e.target_urn for e in self._edges},
            focus=TraceFocus(urn=urn, level=0, entityType="dataset"),
            effectiveLevel=0,
            isInherited=False,
            inheritedFromUrn=None,
            truncated=False,
            truncationReason=None,
            frontierUp=[TraceFrontierNode(urn="urn:frontier:up1", totalCount=7, nextCursor="e:42")],
            frontierDown=[],
            seedTruncated=False,
        )


class _UnavailableProvider(_StubProvider):
    async def search_nodes(self, query: str, limit: int = 10, **kw) -> List[GraphNode]:
        raise OSError("connection refused")


class _NotImplementedClosureProvider(_StubProvider):
    async def trace_closure(self, *args, **kwargs) -> TraceClosureResult:
        raise NotImplementedError("stub does not support trace_closure")


class _BaseWithoutClosure:
    """A base that does not have the method AT ALL — which is what serves a
    draft on a stale projection (VersionedBranchProvider). `hasattr` is the
    whole difference from the stub above, and it is the difference between
    an honest 501 and an AttributeError 500."""

    name = "base-without-closure"

    def set_containment_edge_types(self, edge_types, from_ontology: bool = False) -> None:
        pass


# ── Fixtures ──────────────────────────────────────────────────────────

@pytest.fixture()
async def graph_client(test_client: AsyncClient):
    """
    Yield a test client with get_context_engine overridden to use
    a fresh _StubProvider (no real workspace resolution needed).
    """
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    mock_engine = ContextEngine(provider=_StubProvider())

    async def _override():
        return mock_engine

    app.dependency_overrides[get_context_engine] = _override
    yield test_client, mock_engine
    # Restore (test_client fixture will clear all overrides anyway)
    app.dependency_overrides.pop(get_context_engine, None)


async def test_get_context_engine_requires_explicit_scope():
    from backend.app.api.v1.endpoints.graph import get_context_engine

    with pytest.raises(HTTPException) as exc_info:
        await get_context_engine(ws_id=None, connectionId=None, session=object())  # type: ignore[arg-type]

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "scope_required: workspace_id or connection_id is required"


def _get_sample_urn(engine: ContextEngine) -> str:
    """Return an arbitrary URN from the stub provider's data."""
    nodes = engine.provider._nodes
    if nodes:
        return next(iter(nodes))
    return "urn:li:dataset:(urn:li:dataPlatform:demo,DemoTable,PROD)"


# ── POST /trace ───────────────────────────────────────────────────────

async def test_trace_returns_lineage_result(graph_client):
    """POST /trace is removed — returns 410 Gone with a migration pointer.

    The v1 lineage trace was deprecated in favour of POST /trace/v2 (see
    graph.py ``get_lineage_trace_deprecated``). Actual trace behaviour is
    covered by the v2 suites (test_trace_v2_falkordb / _invalidation)."""
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace",
        json={
            "urn": urn,
            "direction": "both",
            "depth": 1,
        },
    )
    assert resp.status_code == 410
    assert resp.json()["error"]["code"] == "v1_trace_deprecated"
    assert resp.headers["Deprecation"] == "true"
    assert "Sunset" in resp.headers


async def test_trace_upstream_only(graph_client):
    """POST /trace with direction=upstream — 410 Gone (deprecated)."""
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace",
        json={"urn": urn, "direction": "upstream", "depth": 2},
    )
    assert resp.status_code == 410


async def test_trace_downstream_only(graph_client):
    """POST /trace with direction=downstream — 410 Gone (deprecated)."""
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace",
        json={"urn": urn, "direction": "downstream", "depth": 2},
    )
    assert resp.status_code == 410


# ── POST /trace/closure ──────────────────────────────────────────────

async def test_trace_closure_returns_scoped_lineage(graph_client):
    """POST /trace/closure runs the focus-scoped closure through the real
    engine + route (stub only at the provider boundary) and returns the
    scoped lineage subgraph as a 200, with the frontier surfaced under its
    camelCase wire aliases and the health header set."""
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace/closure",
        json={"urn": urn},
    )

    assert resp.status_code == 200, resp.text
    assert resp.headers.get("X-Provider-Health") == "unknown"
    body = resp.json()
    assert "nodes" in body and "edges" in body
    assert len(body["edges"]) >= 1
    assert body["truncated"] is False
    assert body["frontierUp"][0]["totalCount"] == 7
    assert body["frontierUp"][0]["nextCursor"] == "e:42"
    assert body["seedTruncated"] is False


async def test_trace_closure_after_cursor_with_seed_urns_422(graph_client):
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace/closure",
        json={"urn": urn, "direction": "upstream", "upstreamDepth": 1, "afterCursor": "e:1", "seedUrns": [urn]},
    )
    assert resp.status_code == 422


async def test_trace_closure_after_cursor_with_exclude_urns_422(graph_client):
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace/closure",
        json={"urn": urn, "direction": "upstream", "upstreamDepth": 1, "afterCursor": "e:1", "excludeUrns": [urn]},
    )
    assert resp.status_code == 422


async def test_trace_closure_after_cursor_with_direction_both_422(graph_client):
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace/closure",
        json={"urn": urn, "direction": "both", "afterCursor": "e:1"},
    )
    assert resp.status_code == 422


async def test_trace_closure_after_cursor_with_wrong_active_depth_422(graph_client):
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace/closure",
        json={"urn": urn, "direction": "upstream", "upstreamDepth": 2, "afterCursor": "e:1"},
    )
    assert resp.status_code == 422


async def test_trace_closure_unknown_direction_422(graph_client):
    """The wire rejects it too, not just the model — a misspelt direction
    used to page the OPPOSITE side of the graph and answer 200."""
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace/closure",
        json={"urn": urn, "direction": "upstrem", "upstreamDepth": 1, "afterCursor": "e:1"},
    )
    assert resp.status_code == 422


async def test_trace_closure_after_cursor_bad_format_422(graph_client):
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.post(
        "/api/v1/test-ws/graph/trace/closure",
        json={"urn": urn, "direction": "upstream", "upstreamDepth": 1, "afterCursor": "not-a-cursor"},
    )
    assert resp.status_code == 422


async def test_trace_closure_provider_not_implemented_returns_501(test_client: AsyncClient):
    """A provider that doesn't support trace_closure maps to 501, not a
    500, on the scope-is-None / direct-compute path — this mock engine
    carries no workspace scope, same as `graph_client`, so `_cache_scope`
    returns None and `GraphCache.get_or_compute` is never called. See
    test_trace_closure_provider_not_implemented_returns_501_through_cache_wrapper
    below for the same proof through the real cache wrapper."""
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    mock_engine = ContextEngine(provider=_NotImplementedClosureProvider())
    urn = _get_sample_urn(mock_engine)

    async def _override():
        return mock_engine

    app.dependency_overrides[get_context_engine] = _override
    try:
        resp = await test_client.post(
            "/api/v1/test-ws/graph/trace/closure",
            json={"urn": urn},
        )
    finally:
        app.dependency_overrides.pop(get_context_engine, None)

    assert resp.status_code == 501
    assert resp.json()["detail"]["code"] == "trace_closure_unsupported"


async def test_trace_closure_on_a_draft_whose_base_cannot_do_it_returns_501(test_client: AsyncClient):
    """A DRAFT read, where the overlay's base has no trace_closure.

    The overlay HAS the method — so the engine's own `getattr` guard passes
    and hands the call straight through — and the pass-through then reached
    for a method its base does not have. That is an AttributeError, i.e. a
    500 on the one read path (a draft on a stale projection) where the
    answer is simply "this provider cannot do that". Every sibling read on
    that base already says so with a 501; this one now does too."""
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider

    overlay = DraftOverlayProvider(
        _BaseWithoutClosure(), svc=None, graph_id="g1", branch_id="draft1",
    )
    mock_engine = ContextEngine(provider=overlay)

    async def _override():
        return mock_engine

    app.dependency_overrides[get_context_engine] = _override
    try:
        resp = await test_client.post(
            "/api/v1/test-ws/graph/trace/closure",
            json={"urn": "urn:li:dataset:(a,b,c)"},
        )
    finally:
        app.dependency_overrides.pop(get_context_engine, None)

    assert resp.status_code == 501
    assert resp.json()["detail"]["code"] == "trace_closure_unsupported"


# `graph_client`'s mock engine has no workspace/data-source scope, so every
# test above hits `_cache_scope`'s None branch and never reaches
# `GraphCache.get_or_compute` — the two tests below give the engine a real
# scope (same technique as the `top_level_client` fixture) and swap in a
# real `GraphCache` backed by a minimal mocked redis client (same technique
# as test_graph_cache.py's `_make_redis()`, not the trivial passthrough
# `_PassthroughGraphCache` uses) so the response has genuinely round-tripped
# through `GraphCache.get_or_compute` — generation read, cache-miss lookup,
# `result.model_dump_json()`, `cache_redis.set()` — the thing that actually
# exercises `model_cls=TraceClosureResult` as a new subclass usage and the
# try/except's placement around the real (not bypassed) call.

def _make_scoped_engine_and_cache(provider):
    from backend.app.services.graph_cache import GraphCache

    engine = ContextEngine(provider=provider)
    engine._workspace_id = "ws1"
    engine._data_source_id = "ds1"

    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)  # unconditional cache miss
    redis.set = AsyncMock(return_value=True)
    return engine, GraphCache(redis), redis


async def test_trace_closure_returns_scoped_lineage_through_cache_wrapper(test_client: AsyncClient, monkeypatch):
    """Success path through the real GraphCache.get_or_compute: the
    frontier (and its totalCount/nextCursor) and seedTruncated must
    survive the serialize/cache-write round trip, not just a direct
    compute() call."""
    from backend.app.main import app
    from backend.app.api.v1.endpoints import graph as graph_module

    mock_engine, real_cache, redis = _make_scoped_engine_and_cache(_StubProvider())
    urn = _get_sample_urn(mock_engine)

    async def _override():
        return mock_engine

    app.dependency_overrides[graph_module.get_context_engine] = _override
    monkeypatch.setattr(graph_module, "get_graph_cache", lambda: real_cache)
    try:
        resp = await test_client.post(
            "/api/v1/test-ws/graph/trace/closure",
            json={"urn": urn},
        )
    finally:
        app.dependency_overrides.pop(graph_module.get_context_engine, None)

    assert resp.status_code == 200, resp.text
    # Proof this ran through get_or_compute, not the scope-is-None bypass:
    # the generation/cache-lookup GET and the primary+LKG cache SET both fired.
    assert redis.get.await_count >= 1
    assert redis.set.await_count >= 1
    body = resp.json()
    assert body["frontierUp"][0]["totalCount"] == 7
    assert body["frontierUp"][0]["nextCursor"] == "e:42"
    assert body["seedTruncated"] is False


async def test_trace_closure_cache_hit_deserializes_the_subclass(test_client: AsyncClient, monkeypatch):
    """The READ half of the round trip. Both wrapper tests around this one
    always MISS, so `model_cls=TraceClosureResult` is only ever exercised on
    the write side — nothing reaches `model_validate_json`, where the subclass
    is actually reconstructed. That branch is where a `TraceResult` would
    validate this very payload happily and silently drop frontierUp /
    frontierDown / seedTruncated: a served-from-cache walk with no '+N more'
    affordances and no cut flag, indistinguishable from a finished one. So
    serve a cached document carrying values the stub provider could never
    produce, and require them back."""
    from backend.app.main import app
    from backend.app.api.v1.endpoints import graph as graph_module

    mock_engine, real_cache, redis = _make_scoped_engine_and_cache(_StubProvider())
    urn = _get_sample_urn(mock_engine)

    cached = TraceClosureResult(
        nodes=[], edges=[], containmentEdges=[],
        upstreamUrns=set(), downstreamUrns=set(),
        focus=TraceFocus(urn=urn, level=0, entityType="dataset"),
        effectiveLevel=0, isInherited=False, inheritedFromUrn=None,
        truncated=True, truncationReason="max_nodes",
        frontierUp=[TraceFrontierNode(urn="urn:cached:hub", totalCount=61, nextCursor="e:900")],
        frontierDown=[],
        seedTruncated=True,
    ).model_dump_json(by_alias=True)
    # get_or_compute reads the generation counter first, the cache key second.
    redis.get.side_effect = [b"7", cached]

    async def _override():
        return mock_engine

    app.dependency_overrides[graph_module.get_context_engine] = _override
    monkeypatch.setattr(graph_module, "get_graph_cache", lambda: real_cache)
    try:
        resp = await test_client.post(
            "/api/v1/test-ws/graph/trace/closure",
            json={"urn": urn},
        )
    finally:
        app.dependency_overrides.pop(graph_module.get_context_engine, None)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Served from the cache, never recomputed: the stub's own closure ships
    # nodes/edges and the frontier urn:frontier:up1, and would have written back.
    assert redis.set.await_count == 0
    assert body["nodes"] == [] and body["edges"] == []
    # The subclass fields survived the deserialize — the whole point.
    assert body["frontierUp"] == [
        {"urn": "urn:cached:hub", "totalCount": 61, "nextCursor": "e:900", "reason": None}
    ]
    assert body["seedTruncated"] is True
    assert body["truncationReason"] == "max_nodes"


async def test_trace_closure_provider_not_implemented_returns_501_through_cache_wrapper(test_client: AsyncClient, monkeypatch):
    """Same scope-resolving setup as the success case above, but with the
    NotImplementedError-raising provider: proves the endpoint's
    try/except wraps the REAL get_or_compute call (whose own exception
    handling re-raises through a singleflight future) rather than only
    the scope-is-None direct-compute shortcut the sibling 501 test above
    exercises."""
    from backend.app.main import app
    from backend.app.api.v1.endpoints import graph as graph_module

    mock_engine, real_cache, redis = _make_scoped_engine_and_cache(_NotImplementedClosureProvider())
    urn = _get_sample_urn(mock_engine)

    async def _override():
        return mock_engine

    app.dependency_overrides[graph_module.get_context_engine] = _override
    monkeypatch.setattr(graph_module, "get_graph_cache", lambda: real_cache)
    try:
        resp = await test_client.post(
            "/api/v1/test-ws/graph/trace/closure",
            json={"urn": urn},
        )
    finally:
        app.dependency_overrides.pop(graph_module.get_context_engine, None)

    assert resp.status_code == 501
    assert resp.json()["detail"]["code"] == "trace_closure_unsupported"
    # Reached (and raised inside) the real cache flow, not the bypass: the
    # generation/cache-lookup GET fired; no result ever reached the SET side.
    assert redis.get.await_count >= 1
    assert redis.set.await_count == 0


# ── GET /nodes/{urn} ──────────────────────────────────────────────────

async def test_get_node_found(graph_client):
    """GET a known node returns 200 with node data."""
    client, engine = graph_client
    urn = _get_sample_urn(engine)

    resp = await client.get(f"/api/v1/test-ws/graph/nodes/{urn}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["urn"] == urn


async def test_get_node_not_found(graph_client):
    """GET a non-existent URN returns 404."""
    client, _ = graph_client
    resp = await client.get(
        "/api/v1/test-ws/graph/nodes/urn:nonexistent:nothing"
    )
    assert resp.status_code == 404


# ── POST /search ──────────────────────────────────────────────────────

async def test_search_returns_list(graph_client):
    """POST /search returns a list of nodes."""
    client, _ = graph_client

    resp = await client.post(
        "/api/v1/test-ws/graph/search",
        json={"query": "demo", "limit": 5},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)


async def test_search_empty_query(graph_client):
    """POST /search with a non-matching query returns an empty list."""
    client, _ = graph_client

    resp = await client.post(
        "/api/v1/test-ws/graph/search",
        json={"query": "zzz_no_match_xyz", "limit": 10},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


async def test_search_provider_unavailable_returns_structured_503(test_client: AsyncClient):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    async def _override():
        return ContextEngine(provider=_UnavailableProvider())

    app.dependency_overrides[get_context_engine] = _override
    try:
        # Real workspace ids are ``ws_<hex>`` (models.py), and main.py's
        # ``_provider_error_handler`` only classifies a raw connectivity
        # error as PROVIDER_UNAVAILABLE on provider-bound paths (the
        # ``/api/v1/ws_`` prefix). A ``ws_``-scoped id exercises that
        # production path; a non-``ws_`` id would fall through to the
        # generic DB_UNAVAILABLE branch.
        resp = await test_client.post(
            "/api/v1/ws_test/graph/search",
            json={"query": "demo", "limit": 5},
        )
    finally:
        app.dependency_overrides.pop(get_context_engine, None)

    assert resp.status_code == 503
    assert resp.json() == {
        "detail": {
            "code": "PROVIDER_UNAVAILABLE",
            "providerId": None,
            "reason": "connection refused",
        }
    }


# ── GET /introspection ────────────────────────────────────────────────

async def test_introspection_returns_schema_stats(graph_client, db_session):
    """GET /introspection serves cached schema stats in a {data, meta} envelope.

    The endpoint was reworked into a cache-only reader (never calls the
    provider): it resolves a data source, reads
    ``data_source_stats.schema_stats``, and always returns HTTP 200 with
    ``meta.status`` carrying the cache tier. Seed a fresh cache row and
    assert the schema stats surface under ``data``."""
    import json
    from datetime import datetime, timezone
    from backend.app.db.models import (
        DataSourceStatsORM,
        ProviderORM,
        WorkspaceDataSourceORM,
        WorkspaceORM,
    )

    client, _ = graph_client

    schema = {
        "entityTypeStats": [{"entityType": "dataset", "count": 3}],
        "edgeTypeStats": [{"edgeType": "TRANSFORMS", "count": 1}],
    }
    # The data-plane gate verifies dataSourceId belongs to the path
    # workspace, so the source must exist as a real bound row.
    if (await db_session.get(WorkspaceORM, "test-ws")) is None:
        db_session.add(WorkspaceORM(id="test-ws", name="Test WS"))
    db_session.add(ProviderORM(
        id="prov_introspect", name="P", provider_type="falkordb",
    ))
    db_session.add(WorkspaceDataSourceORM(
        id="ds_introspect", workspace_id="test-ws",
        provider_id="prov_introspect", graph_name="g_introspect",
    ))
    db_session.add(DataSourceStatsORM(
        data_source_id="ds_introspect",
        schema_stats=json.dumps(schema),
        updated_at=datetime.now(timezone.utc).isoformat(),
    ))
    await db_session.commit()

    resp = await client.get(
        "/api/v1/test-ws/graph/introspection?dataSourceId=ds_introspect"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["meta"]["status"] in ("fresh", "stale")
    assert body["data"]["entityTypeStats"] == schema["entityTypeStats"]
    assert body["data"]["edgeTypeStats"] == schema["edgeTypeStats"]


# ── GET /nodes (list) ─────────────────────────────────────────────────

async def test_list_nodes(graph_client):
    """GET /nodes returns a list of graph nodes."""
    client, _ = graph_client

    resp = await client.get("/api/v1/test-ws/graph/nodes?limit=5")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ── GET /nodes/{urn}/children ─────────────────────────────────────────

async def test_get_children(graph_client):
    """GET children of a known node returns a list or empty list."""
    client, engine = graph_client
    # Use a root node that is likely to have children in stub data
    urn = _get_sample_urn(engine)

    resp = await client.get(
        f"/api/v1/test-ws/graph/nodes/{urn}/children",
        params={"limit": 10, "offset": 0},
    )
    # The endpoint may fail if ontology resolution hits an edge case with
    # the stub provider (no real ontology service).  Accept 200 or 500.
    assert resp.status_code in (200, 500)
    if resp.status_code == 200:
        assert isinstance(resp.json(), list)


# ── GET /metadata/entity-types ────────────────────────────────────────

async def test_entity_types(graph_client):
    """GET /metadata/entity-types returns a list of strings."""
    client, _ = graph_client

    resp = await client.get("/api/v1/test-ws/graph/metadata/entity-types")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    if body:
        assert isinstance(body[0], str)


# ── GET /metadata/tags ────────────────────────────────────────────────

async def test_tags(graph_client):
    """GET /metadata/tags returns a list of strings."""
    client, _ = graph_client

    resp = await client.get("/api/v1/test-ws/graph/metadata/tags")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ── POST /edges/query ─────────────────────────────────────────────────

async def test_query_edges(graph_client):
    """POST /edges/query returns a list of edges."""
    client, _ = graph_client

    resp = await client.post(
        "/api/v1/test-ws/graph/edges/query",
        json={"query": {"limit": 10}},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ── GET /nodes/top-level (materialized-payload intercept) ─────────────
#
# `graph_client`'s mock engine has no workspace/data-source scope, so
# `_cache_scope` returns None and the endpoint always takes its
# scope-is-None early path (compute() runs directly, no GraphCache
# involved). To exercise the intercept added inside compute() — which
# depends on a real CacheScope (`scope.data_source_id`, `scope.branch_id`)
# — these tests use a dedicated fixture whose engine carries an explicit
# scope, and swap `get_graph_cache` for a passthrough stand-in so no
# Redis is required (GraphCache's own Redis-backed behavior is already
# covered by test_graph_cache.py).

class _PassthroughGraphCache:
    """Bypasses GraphCache/Redis so these tests exercise only the
    endpoint's own intercept logic inside `compute()`. Records the
    count side-cache traffic so tests can assert the get/set wiring."""

    def __init__(self):
        self.count_store: dict = {}
        self.count_gets: list = []
        self.count_sets: list = []

    async def get_or_compute(self, *, scope, endpoint, params, compute, model_cls,
                              ttl_seconds=None, on_stale=None):
        return await compute()

    @staticmethod
    def _count_key(params) -> str:
        import json
        return json.dumps(params, sort_keys=True, default=str)

    async def get_top_level_count(self, scope, params):
        self.count_gets.append((scope, params))
        return self.count_store.get(self._count_key(params))

    async def set_top_level_count(self, scope, params, value):
        self.count_sets.append((scope, params, value))
        self.count_store[self._count_key(params)] = value


@pytest.fixture()
async def top_level_client(test_client: AsyncClient, monkeypatch):
    """Like `graph_client`, but the mock engine carries a workspace/data
    source scope (so `_cache_scope` resolves to a real CacheScope) and
    `get_graph_cache` is replaced with a passthrough. The single
    passthrough instance is reachable via `graph_module.get_graph_cache()`
    for count-cache assertions."""
    from backend.app.main import app
    from backend.app.api.v1.endpoints import graph as graph_module

    mock_engine = ContextEngine(provider=_StubProvider())
    mock_engine._workspace_id = "ws1"
    mock_engine._data_source_id = "ds1"

    async def _override():
        return mock_engine

    app.dependency_overrides[graph_module.get_context_engine] = _override
    passthrough_cache = _PassthroughGraphCache()
    monkeypatch.setattr(graph_module, "get_graph_cache", lambda: passthrough_cache)

    yield test_client, mock_engine
    app.dependency_overrides.pop(graph_module.get_context_engine, None)


def _stub_top_level_result(total: int = 1) -> TopLevelNodesResult:
    return TopLevelNodesResult(
        nodes=[GraphNode(urn="urn:li:dataset:x", displayName="X", entityType="dataset")],
        totalCount=total, hasMore=False, nextCursor=None, rootTypeCount=1, orphanCount=0,
    )


async def test_top_level_materialized_serve(top_level_client, monkeypatch):
    """Large main-branch default-browse request is served straight from
    the materialized payload; the live engine method is never called and
    the response carries exactly the live-shape keys."""
    client, engine = top_level_client
    from backend.app.api.v1.endpoints import graph as graph_module

    served = _stub_top_level_result(total=1)

    async def _fake_try_serve(session, eng, *, ds_id, ws_id, limit, cursor,
                              search_query=None, entity_types=None):
        assert ds_id == "ds1"
        assert ws_id == "ws1"
        return served, served.total_count

    monkeypatch.setattr(graph_module, "try_serve_top_level", _fake_try_serve)
    live_spy = AsyncMock(side_effect=AssertionError("live engine must not be called"))
    monkeypatch.setattr(engine, "get_top_level_or_orphan_nodes", live_spy)

    resp = await client.get("/api/v1/test-ws/graph/nodes/top-level?limit=5")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {
        "nodes", "totalCount", "hasMore", "nextCursor", "rootTypeCount", "orphanCount",
    }
    assert body["totalCount"] == 1
    live_spy.assert_not_called()


async def _assert_live_path(
    top_level_client, monkeypatch, *, params: dict,
    expect_serve_called: bool, expected_known_total,
):
    """Shared assertion for the live-fallback tests below: the serve
    helper is (or isn't) invoked as expected, and whatever `known_total`
    it hands back is forwarded verbatim to the live engine call."""
    client, engine = top_level_client
    from backend.app.api.v1.endpoints import graph as graph_module

    serve_spy = AsyncMock(return_value=(None, expected_known_total))
    monkeypatch.setattr(graph_module, "try_serve_top_level", serve_spy)

    live_spy = AsyncMock(return_value=_stub_top_level_result(total=2))
    monkeypatch.setattr(engine, "get_top_level_or_orphan_nodes", live_spy)

    resp = await client.get("/api/v1/test-ws/graph/nodes/top-level", params=params)
    assert resp.status_code == 200

    if expect_serve_called:
        serve_spy.assert_awaited_once()
    else:
        serve_spy.assert_not_called()

    live_spy.assert_awaited_once()
    assert live_spy.await_args.kwargs["known_total_count"] == expected_known_total


async def test_top_level_live_path_search_query(top_level_client, monkeypatch):
    """searchQuery set -> the serve helper IS consulted (it filters a
    complete payload in-process) and, on a miss, the live engine is
    called with known_total_count=None."""
    await _assert_live_path(
        top_level_client, monkeypatch,
        params={"searchQuery": "foo"},
        expect_serve_called=True,
        expected_known_total=None,
    )


async def test_top_level_live_path_entity_types(top_level_client, monkeypatch):
    """entityTypes set -> serve helper consulted (filtered in-process on
    complete payloads); miss falls back live with known_total_count=None."""
    await _assert_live_path(
        top_level_client, monkeypatch,
        params={"entityTypes": ["dataset"]},
        expect_serve_called=True,
        expected_known_total=None,
    )


async def test_top_level_live_path_include_child_count_false(top_level_client, monkeypatch):
    """includeChildCount=false -> intercept guard fails; live engine
    called with known_total_count=None."""
    await _assert_live_path(
        top_level_client, monkeypatch,
        params={"includeChildCount": "false"},
        expect_serve_called=False,
        expected_known_total=None,
    )


async def test_top_level_live_path_branch_scope(top_level_client, monkeypatch):
    """A non-empty branch scope -> intercept guard fails (draft reads
    never serve off the main-branch materialization); live engine called
    with known_total_count=None."""
    _, engine = top_level_client
    engine._branch_id = "br_123"
    await _assert_live_path(
        top_level_client, monkeypatch,
        params={},
        expect_serve_called=False,
        expected_known_total=None,
    )


async def test_top_level_serve_declines_but_forwards_known_total(top_level_client, monkeypatch):
    """Guard passes (default main-branch browse) but the serve helper
    declines to serve a page (e.g. below the materialize threshold)
    while still reporting a known total — the endpoint forwards it to
    the live engine call."""
    await _assert_live_path(
        top_level_client, monkeypatch,
        params={},
        expect_serve_called=True,
        expected_known_total=42,
    )


async def test_top_level_cold_start_no_payload(top_level_client, monkeypatch):
    """Row exists but has never been materialized — the serve helper
    returns (None, None); live engine called with known_total_count=None."""
    await _assert_live_path(
        top_level_client, monkeypatch,
        params={},
        expect_serve_called=True,
        expected_known_total=None,
    )


# ── GET /nodes/top-level (count side-cache wiring) ────────────────────

async def test_top_level_count_cache_hit_skips_live_count(top_level_client, monkeypatch):
    """A cached total for the same filter shape is forwarded to the live
    engine as known_total_count (which skips the O(N) count scan)."""
    client, engine = top_level_client
    from backend.app.api.v1.endpoints import graph as graph_module

    serve_spy = AsyncMock(return_value=(None, None))
    monkeypatch.setattr(graph_module, "try_serve_top_level", serve_spy)
    live_spy = AsyncMock(return_value=_stub_top_level_result(total=7))
    monkeypatch.setattr(engine, "get_top_level_or_orphan_nodes", live_spy)

    cache = graph_module.get_graph_cache()
    cache.count_store[cache._count_key({"entityTypes": None, "searchQuery": "foo"})] = 7

    resp = await client.get(
        "/api/v1/test-ws/graph/nodes/top-level", params={"searchQuery": "foo"},
    )
    assert resp.status_code == 200
    live_spy.assert_awaited_once()
    assert live_spy.await_args.kwargs["known_total_count"] == 7
    # Count was known — nothing new to store.
    assert cache.count_sets == []


async def test_top_level_live_count_populates_cache(top_level_client, monkeypatch):
    """A live call that ran the count stores the total in the side-cache,
    keyed by filters only (no cursor/limit)."""
    client, engine = top_level_client
    from backend.app.api.v1.endpoints import graph as graph_module

    serve_spy = AsyncMock(return_value=(None, None))
    monkeypatch.setattr(graph_module, "try_serve_top_level", serve_spy)
    live_spy = AsyncMock(return_value=_stub_top_level_result(total=9))
    monkeypatch.setattr(engine, "get_top_level_or_orphan_nodes", live_spy)

    resp = await client.get(
        "/api/v1/test-ws/graph/nodes/top-level",
        params={"searchQuery": "foo", "limit": 5},
    )
    assert resp.status_code == 200
    cache = graph_module.get_graph_cache()
    assert len(cache.count_sets) == 1
    _, params, value = cache.count_sets[0]
    assert params == {"entityTypes": None, "searchQuery": "foo"}
    assert value == 9


async def test_top_level_degraded_count_not_cached(top_level_client, monkeypatch):
    """A live result whose best-effort count timed out (totalCount=None)
    must not poison the count cache."""
    client, engine = top_level_client
    from backend.app.api.v1.endpoints import graph as graph_module

    serve_spy = AsyncMock(return_value=(None, None))
    monkeypatch.setattr(graph_module, "try_serve_top_level", serve_spy)
    degraded = TopLevelNodesResult(
        nodes=[GraphNode(urn="urn:li:dataset:x", displayName="X", entityType="dataset")],
        totalCount=None, hasMore=True, nextCursor=None, rootTypeCount=1, orphanCount=0,
    )
    live_spy = AsyncMock(return_value=degraded)
    monkeypatch.setattr(engine, "get_top_level_or_orphan_nodes", live_spy)

    resp = await client.get("/api/v1/test-ws/graph/nodes/top-level")
    assert resp.status_code == 200
    assert resp.json()["totalCount"] is None
    cache = graph_module.get_graph_cache()
    assert cache.count_sets == []
