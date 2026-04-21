from typing import List, Optional, Any
import asyncio
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Body, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.graph import (
    GraphNode, GraphEdge, LineageResult,
    NodeQuery, EdgeQuery, GraphSchemaStats,
    AggregatedEdgeRequest, AggregatedEdgeResult,
    CreateNodeRequest, CreateNodeResult,
    CreateEdgeRequest, UpdateEdgeRequest, EdgeMutationResult,
    BatchCommandRequest, BatchCommandResult, BatchResponse,
    ChildrenWithEdgesResult, TopLevelNodesResult,
)
from backend.common.interfaces.provider import ProviderConfigurationError
from backend.app.services.context_engine import ContextEngine
from backend.app.db.engine import get_db_session
from backend.app.providers.manager import provider_manager

router = APIRouter()


# ------------------------------------------------------------------ #
# Dependency: resolve ContextEngine for the active connection         #
# ------------------------------------------------------------------ #

async def get_context_engine(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID. Prefer workspace-scoped routes."),
    session: AsyncSession = Depends(get_db_session),
) -> ContextEngine:
    """
    FastAPI dependency that resolves the appropriate ContextEngine.

    Priority:
    - `ws_id` (path param from /v1/{ws_id}/graph routes) → workspace-scoped engine
      - `dataSourceId` (optional query param) → targets specific data source within workspace
    - `connectionId` (query param, legacy) → connection-scoped engine
    - Neither → rejected; graph scope must be explicit

    Error boundary: ContextEngine.for_workspace/for_connection normalize
    all provider connectivity errors to ProviderUnavailable, which the
    global exception handler at main.py converts to HTTP 503 with
    Retry-After. KeyError (data source not found) becomes HTTP 404.
    """
    try:
        if ws_id:
            return await ContextEngine.for_workspace(
                ws_id, provider_manager, session, data_source_id=dataSourceId
            )
        if connectionId:
            return await ContextEngine.for_connection(connectionId, provider_manager, session)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    # ProviderUnavailable propagates to FastAPI exception handler → 503
    raise HTTPException(
        status_code=400,
        detail="scope_required: workspace_id or connection_id is required",
    )


# ------------------------------------------------------------------ #
# Helper: resolve data source ID from workspace (DB-only, no provider)#
# ------------------------------------------------------------------ #

async def _resolve_data_source_id(
    session: AsyncSession,
    ws_id: Optional[str],
    data_source_id: Optional[str],
) -> Optional[str]:
    """Resolve the data source ID for a workspace without touching the provider.
    Returns the explicit data_source_id if given, otherwise looks up the primary
    data source for the workspace.  Returns None if nothing can be resolved.
    """
    if data_source_id:
        return data_source_id
    if not ws_id:
        return None
    from backend.app.db.repositories.data_source_repo import get_primary_data_source
    ds = await get_primary_data_source(session, ws_id)
    return ds.id if ds else None


# ------------------------------------------------------------------ #
# Graph endpoints                                                     #
# ------------------------------------------------------------------ #

@router.post("/trace", response_model=LineageResult, response_model_by_alias=True)
async def get_lineage_trace(
    urn: str = Body(..., embed=True),
    direction: str = Body("both", embed=True),
    depth: int = Body(3, embed=True),
    upstream_depth: Optional[int] = Body(None, embed=True, alias="upstreamDepth"),
    downstream_depth: Optional[int] = Body(None, embed=True, alias="downstreamDepth"),
    granularity: Optional[str] = Body(None, embed=True),
    aggregate_edges: bool = Body(True, embed=True, alias="aggregateEdges"),
    exclude_containment_edges: bool = Body(True, embed=True, alias="excludeContainmentEdges"),
    include_inherited_lineage: bool = Body(True, embed=True, alias="includeInheritedLineage"),
    lineage_edge_types: Optional[List[str]] = Body(None, embed=True, alias="lineageEdgeTypes"),
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Unified Lineage Trace Endpoint.

    Supports:
    - Separate upstream/downstream depth configuration
    - Server-side aggregation and filtering by granularity
    - Containment edge filtering (for pure data lineage)
    - Inherited lineage from children (aggregate child lineage to parent)
    - Ontology-driven edge classification (no hardcoded edge types)
    - Optional lineage edge type filtering (trace only specific relationship types)
    - Optional connectionId to target a specific registered graph connection
    """
    effective_upstream = upstream_depth if upstream_depth is not None else (depth if direction in ["upstream", "both"] else 0)
    effective_downstream = downstream_depth if downstream_depth is not None else (depth if direction in ["downstream", "both"] else 0)
    if effective_upstream == 0 and effective_downstream == 0:
        effective_upstream = depth if direction in ["upstream", "both"] else 0
        effective_downstream = depth if direction in ["downstream", "both"] else 0

    return await engine.get_lineage(
        urn,
        effective_upstream,
        effective_downstream,
        granularity=granularity,
        aggregate_edges=aggregate_edges,
        exclude_containment_edges=exclude_containment_edges,
        include_inherited_lineage=include_inherited_lineage,
        lineage_edge_types=lineage_edge_types,
    )


@router.get(
    "/nodes/top-level",
    response_model=TopLevelNodesResult,
    response_model_by_alias=True,
)
async def get_top_level_nodes(
    entityTypes: Optional[List[str]] = Query(
        None,
        description="Restrict to these entity type IDs. None = all types.",
    ),
    searchQuery: Optional[str] = Query(
        None,
        description="Case-insensitive substring match against displayName/urn.",
    ),
    limit: int = Query(100, ge=1, le=1000),
    cursor: Optional[str] = Query(
        None,
        description="Keyset cursor (displayName of the last node on the previous page).",
    ),
    includeChildCount: bool = Query(True, description="Populate child_count on each node."),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Return instances that have no incoming containment edge.

    "Top-level" is defined **structurally**: a node ``n`` is top-level iff
    there is no edge ``(n' -[:CONTAINMENT_EDGE]-> n)`` for any configured
    containment type. The result therefore mixes:
      - Instances of ontology root types (Domain, Platform, …)
      - Orphan instances of non-root types (e.g. a Table with no schema parent,
        perhaps from a broken or incremental import)

    The response's ``rootTypeCount`` and ``orphanCount`` fields let the UI
    distinguish the two classes (e.g. an "orphan" badge in the wizard tree).

    Containment edge types are resolved from the ontology bound to the active
    data source. If the ontology has no containment edges configured and no
    ``CONTAINMENT_EDGE_TYPES`` env override is present, the provider raises
    :class:`ProviderConfigurationError`, which is translated to HTTP 400 —
    the API must never silently fall back to hardcoded type names.

    **Route-ordering note.** This handler MUST be declared before
    ``/nodes/{urn}`` — FastAPI/Starlette matches routes in registration
    order, and the generic ``{urn}`` path would otherwise swallow
    ``/nodes/top-level`` and return 404 for a non-existent URN.
    """
    try:
        return await engine.get_top_level_or_orphan_nodes(
            entity_types=entityTypes,
            search_query=searchQuery,
            limit=limit,
            cursor=cursor,
            include_child_count=includeChildCount,
        )
    except ProviderConfigurationError as exc:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Ontology configuration error: {exc}. Configure containment "
                "edge types on the active ontology (or set CONTAINMENT_EDGE_TYPES "
                "as a deployment-level override)."
            ),
        )


@router.get("/nodes/{urn}", response_model=GraphNode, response_model_by_alias=True)
async def get_node(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    node = await engine.get_node(urn)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


@router.get("/nodes/{urn}/parent", response_model=Optional[GraphNode], response_model_by_alias=True,
             deprecated=True)
async def get_node_parent(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get parent node (containment hierarchy).

    **Deprecated:** Use `GET /nodes/{urn}/ancestors?limit=1` instead.
    """
    logger.warning("Deprecated endpoint GET /nodes/%s/parent called — use GET /nodes/%s/ancestors?limit=1", urn, urn)
    return await engine.get_parent(urn)


@router.get("/nodes/{urn}/children", response_model=List[GraphNode], response_model_by_alias=True)
async def get_node_children(
    urn: str,
    edge_types: Optional[List[str]] = Query(None, alias="edgeTypes"),
    search_query: Optional[str] = Query(None, alias="searchQuery"),
    sort_property: Optional[str] = Query("displayName", alias="sortProperty", description="Node property to sort by. Pass null to skip sorting."),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    cursor: Optional[str] = Query(None, description="Cursor for keyset pagination (displayName of last item). Takes precedence over offset."),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Lazy load children nodes."""
    return await engine.get_children(urn, edge_types=edge_types, search_query=search_query, limit=limit, offset=offset, sort_property=sort_property, cursor=cursor)


@router.get("/nodes/{urn}/children-with-edges", response_model=ChildrenWithEdgesResult, response_model_by_alias=True)
async def get_children_with_edges(
    urn: str,
    edge_types: Optional[List[str]] = Query(None, alias="edgeTypes"),
    lineage_edge_types: Optional[List[str]] = Query(None, alias="lineageEdgeTypes"),
    search_query: Optional[str] = Query(None, alias="searchQuery"),
    sort_property: Optional[str] = Query("displayName", alias="sortProperty", description="Node property to sort by. Pass null to skip sorting."),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    cursor: Optional[str] = Query(None, description="Cursor for keyset pagination (displayName of last item). Takes precedence over offset."),
    include_lineage_edges: bool = Query(True, alias="includeLineageEdges"),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get children with containment and lineage edges in a single round-trip."""
    return await engine.get_children_with_edges(
        urn, edge_types=edge_types, lineage_edge_types=lineage_edge_types,
        search_query=search_query, limit=limit, offset=offset,
        include_lineage_edges=include_lineage_edges,
        sort_property=sort_property, cursor=cursor,
    )


@router.post("/search", response_model=List[GraphNode], response_model_by_alias=True)
async def search_nodes(
    query: str = Body(..., embed=True),
    limit: int = Body(10, embed=True),
    offset: int = Body(0, embed=True),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.search_nodes(query, limit=limit, offset=offset)


@router.get("/edges", response_model=List[GraphEdge], response_model_by_alias=True,
             deprecated=True)
async def get_edges(
    edge_type: Optional[str] = Query(None, alias="edgeType"),
    source_urn: Optional[str] = Query(None, alias="sourceUrn"),
    target_urn: Optional[str] = Query(None, alias="targetUrn"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic edge query.

    **Deprecated:** Use `POST /edges/query` instead — supports bulk URN lists and complex filters.
    """
    logger.warning("Deprecated endpoint GET /edges called — use POST /edges/query")
    q = EdgeQuery(offset=offset, limit=limit)
    if edge_type:
        q.edge_types = [edge_type]
    if source_urn:
        q.source_urns = [source_urn]
    if target_urn:
        q.target_urns = [target_urn]
    return await engine.get_edges(q)


@router.get("/map/{urn}")
async def get_neighborhood_map(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get node and its immediate edges."""
    result = await engine.get_neighborhood(urn)
    if not result:
        raise HTTPException(status_code=404, detail="Node not found")
    return result


@router.get("/stats", deprecated=True)
async def get_graph_stats(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID."),
    session: AsyncSession = Depends(get_db_session),
):
    """**Deprecated:** Use `GET /introspection` instead — returns a superset of stats with full schema details."""
    logger.warning("Deprecated endpoint GET /stats called — use GET /introspection")
    from backend.app.db.repositories.stats_repo import get_data_source_stats

    # 1. Try DB cache first (no provider needed)
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if ds_id:
        try:
            stats_cache = await get_data_source_stats(session, ds_id)
            if stats_cache:
                return {
                    "nodeCount": stats_cache.node_count,
                    "edgeCount": stats_cache.edge_count,
                    "entityTypeCounts": json.loads(stats_cache.entity_type_counts),
                    "edgeTypeCounts": json.loads(stats_cache.edge_type_counts)
                }
        except Exception:
            pass  # Cache lookup or parse failed — fall through to provider

    # 2. Only try provider if cache miss.
    # ContextEngine normalizes connectivity errors to ProviderUnavailable,
    # caught by the global exception handler → 503 with Retry-After.
    engine = await ContextEngine.for_workspace(
        ws_id, provider_manager, session, data_source_id=dataSourceId
    ) if ws_id else await ContextEngine.for_connection(connectionId, provider_manager, session)
    return await engine.get_stats()


@router.get("/nodes", response_model=List[GraphNode], response_model_by_alias=True,
             deprecated=True)
async def get_nodes(
    entity_type: Optional[str] = Query(None, alias="entityType"),
    tag: Optional[str] = Query(None),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic node query.

    **Deprecated:** Use `POST /nodes/query` instead — supports complex filters and bulk operations.
    """
    logger.warning("Deprecated endpoint GET /nodes called — use POST /nodes/query")
    q = NodeQuery(
        entity_types=[entity_type] if entity_type else None,
        tags=[tag] if tag else None,
        limit=limit,
        offset=offset,
    )
    return await engine.get_nodes_query(q)


@router.get("/nodes/{urn}/ancestors", response_model=List[GraphNode], response_model_by_alias=True)
async def get_node_ancestors(
    urn: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.get_ancestors(urn, limit=limit, offset=offset)


@router.get("/nodes/{urn}/descendants", response_model=List[GraphNode], response_model_by_alias=True)
async def get_node_descendants(
    urn: str,
    depth: int = Query(5, ge=1),
    entity_type: Optional[str] = Query(None, alias="entityType"),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    entity_types = [entity_type] if entity_type else None
    return await engine.get_descendants(urn, depth=depth, entity_types=entity_types, limit=limit, offset=offset)


@router.get("/nodes/by-tag/{tag}", response_model=List[GraphNode], response_model_by_alias=True,
             deprecated=True)
async def get_nodes_by_tag_endpoint(
    tag: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    """**Deprecated:** Use `POST /nodes/query` with `tags` filter instead."""
    logger.warning("Deprecated endpoint GET /nodes/by-tag/%s called — use POST /nodes/query with tags filter", tag)
    return await engine.get_nodes_by_tag(tag, limit=limit, offset=offset)


@router.get("/nodes/by-layer/{layer_id}", response_model=List[GraphNode], response_model_by_alias=True)
async def get_nodes_by_layer_endpoint(
    layer_id: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.get_nodes_by_layer(layer_id, limit=limit, offset=offset)


class InternalEdgeQuery(BaseModel):
    """Fetch edges where BOTH source and target are in the provided URN set."""
    urns: List[str]
    edge_types: Optional[List[str]] = Field(None, alias="edgeTypes")
    limit: int = Field(5000)
    class Config:
        populate_by_name = True


@router.post("/edges/between", response_model=List[GraphEdge], response_model_by_alias=True)
async def get_edges_between(
    query: InternalEdgeQuery = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Fetch edges where both source and target are in the URN set.

    Uses source_urns + target_urns AND-semantics in the Cypher query so only
    edges connecting nodes within the set are returned — no over-fetch or
    Python post-filter needed.
    """
    return await engine.get_edges(EdgeQuery(
        source_urns=query.urns,
        target_urns=query.urns,
        edge_types=query.edge_types,
        limit=query.limit,
    ))


@router.post("/edges/query", response_model=List[GraphEdge], response_model_by_alias=True)
async def query_edges(
    query: EdgeQuery = Body(..., embed=True),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Advanced edge query (bulk fetch)."""
    return await engine.get_edges(query)


@router.post("/nodes/query", response_model=List[GraphNode], response_model_by_alias=True)
async def query_nodes(
    query: NodeQuery = Body(..., embed=True),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Advanced node query (bulk fetch, complex filters)."""
    return await engine.get_nodes_query(query)


@router.get("/metadata/entity-types", response_model=List[str])
async def get_entity_types(
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get distinct entity types in the graph."""
    values = await engine.get_distinct_values("entityType")
    return [str(v) for v in values]


@router.get("/metadata/tags", response_model=List[str])
async def get_tags(
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get distinct tags in the graph."""
    values = await engine.get_distinct_values("tags")
    return [str(v) for v in values]


@router.get("/metadata/distinct/{property}")
async def get_distinct_values(
    property: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic endpoint to get distinct values for filters."""
    return await engine.get_distinct_values(property)


class SaveGraphRequest(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]


@router.post("/save")
async def save_graph(
    request: SaveGraphRequest,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Save custom graph nodes and edges."""
    success = await engine.save_custom_graph(request.nodes, request.edges)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to save graph")
    return {"status": "success", "message": "Graph saved successfully"}


def _freshness_headers(updated_at_iso: Optional[str]) -> dict:
    """Build X-Cache-* headers so the frontend can show a staleness banner.

    Returns empty dict if no timestamp. Otherwise emits:
      * X-Cache-Updated-At: ISO timestamp of last successful refresh
      * X-Cache-Age-Seconds: integer seconds since refresh
      * X-Cache-Source: "postgres" (persisted) or "live" (just computed)
    """
    if not updated_at_iso:
        return {"X-Cache-Source": "live"}
    try:
        from datetime import datetime, timezone
        ts = datetime.fromisoformat(updated_at_iso)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        age = int((datetime.now(timezone.utc) - ts).total_seconds())
        return {
            "X-Cache-Updated-At": updated_at_iso,
            "X-Cache-Age-Seconds": str(max(0, age)),
            "X-Cache-Source": "postgres",
        }
    except Exception:
        return {"X-Cache-Source": "postgres"}


@router.get("/introspection")
async def get_graph_introspection(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID."),
    session: AsyncSession = Depends(get_db_session),
):
    """Get detailed schema statistics for the graph.

    Prefers the Postgres stats cache (populated by the background stats
    service). Falls back to a live provider call only when no cache
    exists. Emits ``X-Cache-*`` response headers so the frontend can
    surface cache freshness in the UI.
    """
    from backend.app.db.repositories.stats_repo import get_data_source_stats

    # 1. Try DB cache first (no provider needed — always fast, even on 1M+ graphs)
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if ds_id:
        try:
            stats_cache = await get_data_source_stats(session, ds_id)
            if stats_cache and stats_cache.schema_stats and stats_cache.schema_stats != "{}":
                payload = GraphSchemaStats.model_validate(json.loads(stats_cache.schema_stats))
                return JSONResponse(
                    content=payload.model_dump(by_alias=True),
                    headers=_freshness_headers(stats_cache.updated_at),
                )
        except Exception:
            pass  # Cache lookup or parse failed — fall through to provider

    # 2. Only try provider if cache miss (first-ever request for this data source).
    engine = await ContextEngine.for_workspace(
        ws_id, provider_manager, session, data_source_id=dataSourceId
    ) if ws_id else await ContextEngine.for_connection(connectionId, provider_manager, session)
    result = await engine.get_schema_stats()
    return JSONResponse(
        content=result.model_dump(by_alias=True),
        headers=_freshness_headers(None),
    )


@router.get("/metadata/ontology", deprecated=True)
async def get_ontology_metadata(
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID."),
    session: AsyncSession = Depends(get_db_session),
):
    """Get ontology metadata including containment edge types and entity hierarchies.

    **Deprecated:** Use `GET /metadata/schema` instead — returns a superset including ontology, entity types, and relationship definitions.
    """
    logger.warning("Deprecated endpoint GET /metadata/ontology called — use GET /metadata/schema")
    from backend.app.db.repositories.stats_repo import get_data_source_stats

    # 1. Try DB cache first (no provider needed)
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if ds_id:
        try:
            stats_cache = await get_data_source_stats(session, ds_id)
            if stats_cache and stats_cache.ontology_metadata and stats_cache.ontology_metadata != "{}":
                return JSONResponse(
                    content=json.loads(stats_cache.ontology_metadata),
                    headers={"Cache-Control": "private, max-age=300"},
                )
        except Exception:
            pass  # Cache lookup or parse failed — fall through to provider

    # 2. Only try provider if cache miss.
    engine = await ContextEngine.for_workspace(
        ws_id, provider_manager, session, data_source_id=dataSourceId
    ) if ws_id else await ContextEngine.for_connection(connectionId, provider_manager, session)
    result = await engine.get_ontology_metadata()
    return JSONResponse(
        content=result.model_dump(by_alias=True),
        headers={"Cache-Control": "private, max-age=300"},
    )


def _schema_etag(payload: dict) -> str:
    """Compute a weak ETag over the JSON-serialized schema payload.

    Uses SHA-256 over canonical JSON (sorted keys, no whitespace) so that
    semantically-identical responses produce identical ETags regardless of
    dict key order. Emitted as a weak validator because the payload is a
    deterministic serialisation, not a byte-exact representation.
    """
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f'W/"{digest}"'


def _schema_response(
    payload: dict, request: Request, *, freshness: Optional[dict] = None,
) -> Response:
    """Build a cache-aware JSONResponse with ETag/If-None-Match handling.

    Returns 304 Not Modified with an empty body when the client's
    If-None-Match header matches the computed ETag. Otherwise returns
    200 with the payload and the ETag header attached.

    ``freshness`` — optional dict of ``X-Cache-*`` headers (see
    :func:`_freshness_headers`) to surface cache staleness to the client.
    """
    etag = _schema_etag(payload)
    if_none_match = request.headers.get("if-none-match")
    headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
    }
    if freshness:
        headers.update(freshness)
    if if_none_match and if_none_match == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=payload, headers=headers)


@router.get("/metadata/schema")
async def get_graph_schema(
    request: Request,
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    connectionId: Optional[str] = Query(None, description="Legacy connection ID."),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Get complete graph schema including entity types, relationship types,
    visual configurations, and hierarchy rules.
    This enables frontend to dynamically load schema from backend.

    Responds with a weak ETag computed from the canonical payload. Clients
    that send a matching If-None-Match header get a 304 Not Modified with
    no body — use this to avoid re-parsing unchanged schemas on refetch.
    """
    from backend.app.db.repositories.stats_repo import get_data_source_stats

    # 1. Try DB cache first (no provider needed — always fast, even on 1M+ graphs)
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if ds_id:
        try:
            stats_cache = await get_data_source_stats(session, ds_id)
            if stats_cache and stats_cache.graph_schema and stats_cache.graph_schema != "{}":
                return _schema_response(
                    json.loads(stats_cache.graph_schema), request,
                    freshness=_freshness_headers(stats_cache.updated_at),
                )
        except Exception:
            pass  # Cache lookup or parse failed — fall through to provider

    # 2. Only try provider if cache miss (first-ever request for this data source).
    engine = await ContextEngine.for_workspace(
        ws_id, provider_manager, session, data_source_id=dataSourceId
    ) if ws_id else await ContextEngine.for_connection(connectionId, provider_manager, session)
    result = await engine.get_graph_schema()
    return _schema_response(
        result.model_dump(by_alias=True), request,
        freshness=_freshness_headers(None),
    )


# ── Async introspection refresh ──────────────────────────────────────
# On large graphs (1M+ nodes/edges), a live introspection can take
# minutes. The background stats service normally keeps the Postgres
# cache fresh on a 5-minute interval. This endpoint lets the frontend
# explicitly trigger a refresh without blocking the HTTP request: the
# actual work runs in a FastAPI BackgroundTask, the caller gets 202.

_refresh_jobs: dict[str, dict] = {}  # job_id -> {status, ds_id, started_at, error}
_refresh_locks: dict[str, asyncio.Lock] = {}  # per-ds_id lock


async def _run_refresh(job_id: str, ds_id: str, workspace_id: str) -> None:
    """Background task: recompute schema_stats / ontology / graph_schema
    for a data source and upsert to Postgres. Never raises — errors are
    recorded in the job status dict so the frontend can surface them.
    """
    from backend.app.db.engine import get_async_session
    from backend.app.db.repositories.stats_repo import upsert_data_source_stats

    # One refresh at a time per data source — prevents thundering herd
    # if the user mashes the refresh button.
    lock = _refresh_locks.setdefault(ds_id, asyncio.Lock())
    if lock.locked():
        _refresh_jobs[job_id] = {
            "status": "skipped",
            "data_source_id": ds_id,
            "reason": "A refresh is already running for this data source.",
        }
        return

    async with lock:
        try:
            async with get_async_session() as session:
                engine = await ContextEngine.for_workspace(
                    workspace_id, provider_manager, session, data_source_id=ds_id
                )
                provider = engine.provider
                stats, schema_stats_obj, ontology_obj, schema_obj = await asyncio.gather(
                    provider.get_stats(),
                    provider.get_schema_stats(),
                    engine.get_ontology_metadata(),
                    engine.get_graph_schema(),
                )
                await upsert_data_source_stats(
                    session=session,
                    ds_id=ds_id,
                    node_count=stats.get("nodeCount", 0),
                    edge_count=stats.get("edgeCount", 0),
                    entity_type_counts=json.dumps(stats.get("entityTypeCounts", {})),
                    edge_type_counts=json.dumps(stats.get("edgeTypeCounts", {})),
                    schema_stats=schema_stats_obj.model_dump_json(by_alias=True),
                    ontology_metadata=ontology_obj.model_dump_json(by_alias=True),
                    graph_schema=schema_obj.model_dump_json(by_alias=True),
                )
                await session.commit()
            _refresh_jobs[job_id] = {
                "status": "completed",
                "data_source_id": ds_id,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as exc:
            logger.warning("Introspection refresh failed for %s: %s", ds_id, exc)
            _refresh_jobs[job_id] = {
                "status": "failed",
                "data_source_id": ds_id,
                "error": str(exc)[:500],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }


@router.post("/introspection/refresh", status_code=202)
async def refresh_introspection(
    background_tasks: BackgroundTasks,
    ws_id: Optional[str] = None,
    dataSourceId: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db_session),
):
    """Trigger a non-blocking refresh of the schema/introspection cache.

    Returns ``202 Accepted`` with a job ID. Poll
    ``GET /introspection/refresh/{job_id}`` to check status. The actual
    introspection runs as a FastAPI BackgroundTask; the HTTP request
    returns immediately so the frontend UI never blocks.

    Idempotency: only one refresh per data source runs at a time. A
    second request while one is in flight is recorded as "skipped".
    """
    ds_id = await _resolve_data_source_id(session, ws_id, dataSourceId)
    if not ds_id or not ws_id:
        raise HTTPException(status_code=400, detail="ws_id and dataSourceId required")

    job_id = str(uuid.uuid4())
    _refresh_jobs[job_id] = {
        "status": "pending",
        "data_source_id": ds_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    background_tasks.add_task(_run_refresh, job_id, ds_id, ws_id)
    return {"job_id": job_id, "status": "pending", "data_source_id": ds_id}


@router.get("/introspection/refresh/{job_id}")
async def get_refresh_status(job_id: str):
    """Poll the status of a background introspection refresh."""
    job = _refresh_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or expired")
    return job


@router.post("/edges/aggregated", response_model=AggregatedEdgeResult, response_model_by_alias=True)
async def get_aggregated_edges(
    request: AggregatedEdgeRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Get aggregated edges between containers.
    Returns summarized edge information showing lineage connections
    at a higher granularity level (e.g., between datasets instead of columns).
    """
    return await engine.get_aggregated_edges(request)


@router.post("/edges/aggregated/materialize")
async def materialize_aggregated_edges(
    engine: ContextEngine = Depends(get_context_engine),
    batch_size: int = Body(1000, embed=True),
):
    """
    Trigger batch materialization of AGGREGATED edges.
    Scans all lineage edges and creates/updates [:AGGREGATED] relationships
    between ancestor pairs at equivalent hierarchy levels.

    This should be run after data ingestion or as a periodic maintenance task.
    """
    ontology = await engine.get_ontology_metadata()
    try:
        stats = await engine.materialize_aggregated_edges(
            batch_size=batch_size,
            containment_edge_types=list(ontology.containment_edge_types),
            lineage_edge_types=list(ontology.lineage_edge_types),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return JSONResponse(content=stats)


@router.post("/nodes/create", response_model=CreateNodeResult, response_model_by_alias=True)
async def create_node(
    request: CreateNodeRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Create a new node with optional containment edge.
    If parentUrn is provided, automatically creates a CONTAINS edge
    based on ontology rules.
    """
    return await engine.create_node(request)


# ─── Edge CRUD ────────────────────────────────────────────────────────────────

@router.post("/edges", response_model=EdgeMutationResult, response_model_by_alias=True, status_code=201)
async def create_edge(
    request: CreateEdgeRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Create a directed edge between two existing nodes.

    Validates source/target entity types against the active ontology.
    If idempotencyKey is supplied and a matching edge already exists it is returned unchanged.
    """
    return await engine.create_edge(request)


@router.patch("/edges/{edge_id}", response_model=EdgeMutationResult, response_model_by_alias=True)
async def update_edge(
    edge_id: str,
    request: UpdateEdgeRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Update mutable properties of an existing edge. Edge type is immutable."""
    return await engine.update_edge(edge_id, request)


@router.delete("/edges/{edge_id}", status_code=204)
async def delete_edge(
    edge_id: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Delete an edge by ID."""
    success = await engine.delete_edge(edge_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Edge '{edge_id}' not found")


# ─── Preflight / guided-create APIs ─────────────────────────────────────────

class AllowedChildOption(BaseModel):
    entity_type: str = Field(alias="entityType")
    label: str
    description: Optional[str] = None
    allowed: bool
    reason: Optional[str] = None     # Non-null when allowed=False (explains why)

    class Config:
        populate_by_name = True


class AllowedEdgeOption(BaseModel):
    edge_type: str = Field(alias="edgeType")
    label: str
    description: Optional[str] = None
    allowed: bool
    reason: Optional[str] = None

    class Config:
        populate_by_name = True


@router.post("/commands/batch", response_model=BatchResponse, response_model_by_alias=True)
async def batch_commands(
    request: BatchCommandRequest = Body(...),
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Execute a batch of graph mutation commands.

    Each command is one of:
      create_node, update_node, delete_node,
      create_edge, update_edge, delete_edge

    Commands are executed in order. If fail_fast=true (default), execution
    stops on the first failure and returns partial results. If fail_fast=false,
    all commands are attempted and results are collected.

    All node/edge mutations are validated against the active ontology before
    any write is attempted.  Validation failures count as command failures.
    """
    from backend.common.models.graph import CreateNodeRequest as _CNR, CreateEdgeRequest as _CER
    from backend.common.models.graph import UpdateEdgeRequest as _UER

    results: List[BatchCommandResult] = []
    succeeded = 0
    failed = 0

    for cmd in request.commands:
        try:
            if cmd.op == "create_node":
                node_req = _CNR(**cmd.payload)
                res = await engine.create_node(node_req)
                if res.success:
                    succeeded += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=True,
                        createdUrn=res.node.urn if res.node else None,
                    ))
                else:
                    failed += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=False, error=res.error,
                    ))
            elif cmd.op == "create_edge":
                edge_req = _CER(**cmd.payload)
                res = await engine.create_edge(edge_req)
                if res.success:
                    succeeded += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=True,
                        createdEdgeId=res.edge.id if res.edge else None,
                    ))
                else:
                    failed += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=False, error=res.error,
                        warnings=res.warnings,
                    ))
            elif cmd.op == "delete_edge":
                edge_id = cmd.payload.get("edgeId") or cmd.payload.get("edge_id", "")
                ok = await engine.delete_edge(edge_id)
                if ok:
                    succeeded += 1
                    results.append(BatchCommandResult(ref=cmd.ref, op=cmd.op, success=True))
                else:
                    failed += 1
                    results.append(BatchCommandResult(
                        ref=cmd.ref, op=cmd.op, success=False,
                        error=f"Edge '{edge_id}' not found",
                    ))
            else:
                failed += 1
                results.append(BatchCommandResult(
                    ref=cmd.ref, op=cmd.op, success=False,
                    error=f"Unsupported op: {cmd.op}",
                ))
        except Exception as exc:
            failed += 1
            results.append(BatchCommandResult(
                ref=cmd.ref, op=cmd.op, success=False, error=str(exc),
            ))

        if request.fail_fast and failed > 0:
            # Fill remaining commands as skipped
            remaining = request.commands[len(results):]
            for skipped in remaining:
                results.append(BatchCommandResult(
                    ref=skipped.ref, op=skipped.op, success=False,
                    error="Skipped: batch aborted due to earlier failure (fail_fast=true)",
                ))
            break

    return BatchResponse(
        results=results,
        total=len(request.commands),
        succeeded=succeeded,
        failed=failed,
    )


@router.get("/nodes/{urn}/allowed-children", response_model=List[AllowedChildOption], response_model_by_alias=True)
async def get_allowed_children(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Return all entity types from the active ontology with an indication of
    whether each may be created as a child of this node.

    Used to populate and disable options in the guided create panel.
    """
    return await engine.get_allowed_children(urn)


@router.get("/nodes/{urn}/allowed-edges", response_model=List[AllowedEdgeOption], response_model_by_alias=True)
async def get_allowed_edges(
    urn: str,
    direction: str = Query("outgoing", description="outgoing | incoming | both"),
    engine: ContextEngine = Depends(get_context_engine),
):
    """
    Return all relationship types from the active ontology with an indication of
    whether each may be created from (or to) this node.

    Used to populate and disable options in the guided edge creator.
    """
    return await engine.get_allowed_edges(urn, direction=direction)
