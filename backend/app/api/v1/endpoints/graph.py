from typing import List, Optional, Any
from fastapi import APIRouter, HTTPException, Query, Body
from pydantic import BaseModel
from backend.app.models.graph import (
    GraphNode, GraphEdge, LineageResult, EntityType, EdgeType, Granularity, NodeQuery, EdgeQuery, GraphSchemaStats, OntologyMetadata,
    GraphSchema, AggregatedEdgeRequest, AggregatedEdgeResult, CreateNodeRequest, CreateNodeResult
)
from backend.app.services.context_engine import context_engine

router = APIRouter()

@router.post("/trace", response_model=LineageResult)
async def get_lineage_trace(
    urn: str = Body(..., embed=True),
    direction: str = Body("both", embed=True),
    depth: int = Body(3, embed=True),
    granularity: Granularity = Body(Granularity.TABLE, embed=True),
    aggregate_edges: bool = Body(True, embed=True)
):
    """
    Trace-99 Lineage Endpoint.
    Supports server-side aggregation and filtering by granularity.
    """
    upstream_depth = depth if direction in ["upstream", "both"] else 0
    downstream_depth = depth if direction in ["downstream", "both"] else 0
    
    return await context_engine.get_lineage(
        urn, 
        upstream_depth, 
        downstream_depth, 
        granularity=granularity, 
        aggregate_edges=aggregate_edges
    )

@router.get("/nodes/{urn}", response_model=GraphNode)
async def get_node(urn: str):
    node = await context_engine.get_node(urn)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return node

@router.get("/nodes/{urn}/children", response_model=List[GraphNode])
async def get_node_children(
    urn: str,
    edge_types: Optional[List[str]] = Query(None, alias="edgeTypes"),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0)
):
    """Lazy load children nodes."""
    return await context_engine.get_children(
        urn, 
        edge_types=edge_types, 
        limit=limit
    )

@router.post("/search", response_model=List[GraphNode])
async def search_nodes(
    query: str = Body(..., embed=True),
    limit: int = Body(10, embed=True),
    offset: int = Body(0, embed=True)
):
    return await context_engine.provider.search_nodes(query, limit=limit, offset=offset)

@router.get("/edges", response_model=List[GraphEdge])
async def get_edges(
    edge_type: Optional[EdgeType] = Query(None, alias="edgeType"),
    source_urn: Optional[str] = Query(None, alias="sourceUrn"),
    target_urn: Optional[str] = Query(None, alias="targetUrn"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1)
):
    """Generic edge query."""
    query = EdgeQuery(offset=offset, limit=limit)
    if edge_type: query.edge_types = [edge_type]
    if source_urn: query.source_urns = [source_urn]
    if target_urn: query.target_urns = [target_urn]
    
    return await context_engine.get_edges(query)

@router.get("/map/{urn}")
async def get_neighborhood_map(urn: str):
    """Get node and its immediate edges."""
    result = await context_engine.get_neighborhood(urn)
    if not result:
        raise HTTPException(status_code=404, detail="Node not found")
    return result

@router.get("/stats")
async def get_graph_stats():
    return await context_engine.get_stats()

@router.get("/nodes", response_model=List[GraphNode])
async def get_nodes(
    entity_type: Optional[EntityType] = Query(None, alias="entityType"),
    tag: Optional[str] = Query(None),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0)
):
    """Generic node query."""
    query = NodeQuery(
        entity_types=[entity_type] if entity_type else None,
        tags=[tag] if tag else None,
        limit=limit, 
        offset=offset
    )
    return await context_engine.provider.get_nodes(query)

@router.get("/nodes/{urn}/ancestors", response_model=List[GraphNode])
async def get_node_ancestors(
    urn: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0)
):
    return await context_engine.get_ancestors(urn, limit=limit, offset=offset)

@router.get("/nodes/{urn}/descendants", response_model=List[GraphNode])
async def get_node_descendants(
    urn: str,
    depth: int = Query(5, ge=1),
    entity_type: Optional[EntityType] = Query(None, alias="entityType"),
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0)
):
    entity_types = [entity_type] if entity_type else None
    return await context_engine.get_descendants(
        urn, depth=depth, entity_types=entity_types, limit=limit, offset=offset
    )

@router.get("/nodes/by-tag/{tag}", response_model=List[GraphNode])
async def get_nodes_by_tag_endpoint(
    tag: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0)
):
    return await context_engine.get_nodes_by_tag(tag, limit=limit, offset=offset)

@router.get("/nodes/by-layer/{layer_id}", response_model=List[GraphNode])
async def get_nodes_by_layer_endpoint(
    layer_id: str,
    limit: int = Query(100, ge=1),
    offset: int = Query(0, ge=0)
):
    return await context_engine.get_nodes_by_layer(layer_id, limit=limit, offset=offset)

@router.post("/edges/query", response_model=List[GraphEdge])
async def query_edges(
    query: EdgeQuery = Body(..., embed=True)
):
    """Advanced edge query (bulk fetch)."""
    return await context_engine.get_edges(query)

@router.post("/nodes/query", response_model=List[GraphNode])
async def query_nodes(
    query: NodeQuery = Body(..., embed=True)
):
    """Advanced node query (bulk fetch, complex filters)."""
    return await context_engine.provider.get_nodes(query)

@router.get("/metadata/distinct/{property}")
async def get_distinct_values(property: str):
    """Generic endpoint to get distinct values for filters."""
    return await context_engine.provider.get_distinct_values(property)

from pydantic import BaseModel

class SaveGraphRequest(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]

@router.post("/save")
async def save_graph(request: SaveGraphRequest):
    """Save custom graph nodes and edges."""
    success = await context_engine.provider.save_custom_graph(request.nodes, request.edges)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to save graph")
    return {"status": "success", "message": "Graph saved successfully"}

@router.get("/introspection", response_model=GraphSchemaStats)
async def get_graph_introspection():
    """Get detailed schema statistics for the graph."""
    return await context_engine.get_schema_stats()

@router.get("/metadata/ontology", response_model=OntologyMetadata)
async def get_ontology_metadata():
    """Get ontology metadata including containment edge types and entity hierarchies."""
    return await context_engine.get_ontology_metadata()

@router.get("/metadata/schema", response_model=GraphSchema)
async def get_graph_schema():
    """
    Get complete graph schema including entity types, relationship types,
    visual configurations, and hierarchy rules.
    This enables frontend to dynamically load schema from backend.
    """
    return await context_engine.get_graph_schema()

@router.post("/edges/aggregated", response_model=AggregatedEdgeResult)
async def get_aggregated_edges(request: AggregatedEdgeRequest = Body(...)):
    """
    Get aggregated edges between containers.
    Returns summarized edge information showing lineage connections
    at a higher granularity level (e.g., between datasets instead of columns).
    """
    return await context_engine.get_aggregated_edges(request)

@router.post("/nodes/create", response_model=CreateNodeResult)
async def create_node(request: CreateNodeRequest = Body(...)):
    """
    Create a new node with optional containment edge.
    If parentUrn is provided, automatically creates a CONTAINS edge
    based on ontology rules.
    """
    return await context_engine.create_node(request)
