from typing import List, Optional, Any
from fastapi import APIRouter, Depends, HTTPException, Query, Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.graph import (
    GraphNode, GraphEdge, LineageResult,
    NodeQuery, EdgeQuery, GraphSchemaStats,
    AggregatedEdgeRequest, AggregatedEdgeResult,
    CreateNodeRequest, CreateNodeResult,
    CreateEdgeRequest, UpdateEdgeRequest, EdgeMutationResult,
    BatchCommandRequest, BatchCommandResult, BatchResponse,
)
from backend.app.services.context_engine import context_engine, ContextEngine
from backend.app.db.engine import get_db_session
from backend.app.registry.provider_registry import provider_registry

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
    - Neither → module-level singleton (primary connection)
    """
    if ws_id:
        return await ContextEngine.for_workspace(
            ws_id, provider_registry, session, data_source_id=dataSourceId
        )
    if connectionId:
        return await ContextEngine.for_connection(connectionId, provider_registry, session)
    return context_engine


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


@router.get("/nodes/{urn}", response_model=GraphNode, response_model_by_alias=True)
async def get_node(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    node = await engine.get_node(urn)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


@router.get("/nodes/{urn}/parent", response_model=Optional[GraphNode], response_model_by_alias=True)
async def get_node_parent(
    urn: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get parent node (containment hierarchy)."""
    return await engine.provider.get_parent(urn)


@router.get("/nodes/{urn}/children", response_model=List[GraphNode], response_model_by_alias=True)
async def get_node_children(
    urn: str,
    edge_types: Optional[List[str]] = Query(None, alias="edgeTypes"),
    search_query: Optional[str] = Query(None, alias="searchQuery"),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Lazy load children nodes."""
    return await engine.get_children(urn, edge_types=edge_types, search_query=search_query, limit=limit, offset=offset)


@router.post("/search", response_model=List[GraphNode], response_model_by_alias=True)
async def search_nodes(
    query: str = Body(..., embed=True),
    limit: int = Body(10, embed=True),
    offset: int = Body(0, embed=True),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.provider.search_nodes(query, limit=limit, offset=offset)


@router.get("/edges", response_model=List[GraphEdge], response_model_by_alias=True)
async def get_edges(
    edge_type: Optional[str] = Query(None, alias="edgeType"),
    source_urn: Optional[str] = Query(None, alias="sourceUrn"),
    target_urn: Optional[str] = Query(None, alias="targetUrn"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic edge query."""
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


@router.get("/stats")
async def get_graph_stats(
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_db_session),
):
    from backend.app.db.repositories.stats_repo import get_data_source_stats
    import json
    
    # Try fetching from cache first
    ds_id = dataSourceId or engine._data_source_id
    if ds_id:
        stats_cache = await get_data_source_stats(session, ds_id)
        if stats_cache:
            try:
                return {
                    "nodeCount": stats_cache.node_count,
                    "edgeCount": stats_cache.edge_count,
                    "entityTypeCounts": json.loads(stats_cache.entity_type_counts),
                    "edgeTypeCounts": json.loads(stats_cache.edge_type_counts)
                }
            except Exception:
                pass # Fallback to runtime if JSON fails
    
    # Fallback to runtime
    return await engine.get_stats()


@router.get("/nodes", response_model=List[GraphNode], response_model_by_alias=True)
async def get_nodes(
    entity_type: Optional[str] = Query(None, alias="entityType"),
    tag: Optional[str] = Query(None),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic node query."""
    q = NodeQuery(
        entity_types=[entity_type] if entity_type else None,
        tags=[tag] if tag else None,
        limit=limit,
        offset=offset,
    )
    return await engine.provider.get_nodes(q)


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


@router.get("/nodes/by-tag/{tag}", response_model=List[GraphNode], response_model_by_alias=True)
async def get_nodes_by_tag_endpoint(
    tag: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.get_nodes_by_tag(tag, limit=limit, offset=offset)


@router.get("/nodes/by-layer/{layer_id}", response_model=List[GraphNode], response_model_by_alias=True)
async def get_nodes_by_layer_endpoint(
    layer_id: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0),
    engine: ContextEngine = Depends(get_context_engine),
):
    return await engine.get_nodes_by_layer(layer_id, limit=limit, offset=offset)


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
    return await engine.provider.get_nodes(query)


@router.get("/metadata/entity-types", response_model=List[str])
async def get_entity_types(
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get distinct entity types in the graph."""
    values = await engine.provider.get_distinct_values("entityType")
    return [str(v) for v in values]


@router.get("/metadata/tags", response_model=List[str])
async def get_tags(
    engine: ContextEngine = Depends(get_context_engine),
):
    """Get distinct tags in the graph."""
    values = await engine.provider.get_distinct_values("tags")
    return [str(v) for v in values]


@router.get("/metadata/distinct/{property}")
async def get_distinct_values(
    property: str,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Generic endpoint to get distinct values for filters."""
    return await engine.provider.get_distinct_values(property)


class SaveGraphRequest(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]


@router.post("/save")
async def save_graph(
    request: SaveGraphRequest,
    engine: ContextEngine = Depends(get_context_engine),
):
    """Save custom graph nodes and edges."""
    success = await engine.provider.save_custom_graph(request.nodes, request.edges)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to save graph")
    return {"status": "success", "message": "Graph saved successfully"}


@router.get("/introspection", response_model=GraphSchemaStats, response_model_by_alias=True)
async def get_graph_introspection(
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_db_session),
):
    """Get detailed schema statistics for the graph."""
    from backend.app.db.repositories.stats_repo import get_data_source_stats
    import json
    
    ds_id = dataSourceId or engine._data_source_id
    if ds_id:
        stats_cache = await get_data_source_stats(session, ds_id)
        if stats_cache and stats_cache.schema_stats and stats_cache.schema_stats != "{}":
            try:
                return GraphSchemaStats.model_validate(json.loads(stats_cache.schema_stats))
            except Exception:
                pass
                
    return await engine.get_schema_stats()


@router.get("/metadata/ontology")
async def get_ontology_metadata(
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_db_session),
):
    """Get ontology metadata including containment edge types and entity hierarchies."""
    from backend.app.db.repositories.stats_repo import get_data_source_stats
    import json
    
    ds_id = dataSourceId or engine._data_source_id
    if ds_id:
        stats_cache = await get_data_source_stats(session, ds_id)
        if stats_cache and stats_cache.ontology_metadata and stats_cache.ontology_metadata != "{}":
            try:
                # Assuming the string is already a valid JSON structure from the Pydantic dump
                return JSONResponse(
                    content=json.loads(stats_cache.ontology_metadata),
                    headers={"Cache-Control": "private, max-age=300"},
                )
            except Exception:
                pass

    result = await engine.get_ontology_metadata()
    return JSONResponse(
        content=result.model_dump(by_alias=True),
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.get("/metadata/schema")
async def get_graph_schema(
    dataSourceId: Optional[str] = Query(None, description="Target a specific data source within a workspace."),
    engine: ContextEngine = Depends(get_context_engine),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Get complete graph schema including entity types, relationship types,
    visual configurations, and hierarchy rules.
    This enables frontend to dynamically load schema from backend.
    """
    from backend.app.db.repositories.stats_repo import get_data_source_stats
    import json
    
    ds_id = dataSourceId or engine._data_source_id
    if ds_id:
        stats_cache = await get_data_source_stats(session, ds_id)
        if stats_cache and stats_cache.graph_schema and stats_cache.graph_schema != "{}":
            try:
                return JSONResponse(
                    content=json.loads(stats_cache.graph_schema),
                    headers={"Cache-Control": "private, max-age=300"},
                )
            except Exception:
                pass

    result = await engine.get_graph_schema()
    return JSONResponse(
        content=result.model_dump(by_alias=True),
        headers={"Cache-Control": "private, max-age=300"},
    )


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
    from backend.app.providers.falkordb_provider import FalkorDBProvider
    if not isinstance(engine.provider, FalkorDBProvider):
        return JSONResponse(
            status_code=400,
            content={"error": "Materialization only supported for FalkorDB provider"}
        )

    ontology = await engine.get_ontology_metadata()
    stats = await engine.provider.materialize_aggregated_edges_batch(
        batch_size=batch_size,
        containment_edge_types=list(ontology.containment_edge_types),
        lineage_edge_types=list(ontology.lineage_edge_types),
    )
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
