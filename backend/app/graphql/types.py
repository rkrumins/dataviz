"""
GraphQL Type Definitions for NexusLineage

Provides flexible, type-safe graph queries with:
- Node fetching with filtering
- Lineage with inheritance options
- Column-level lineage
- Scoped graph queries
"""

import strawberry
from typing import Optional, List, Any
from enum import Enum
from datetime import datetime


# ============================================
# ENUMS
# ============================================

@strawberry.enum
class LineageDirection(Enum):
    UPSTREAM = "upstream"
    DOWNSTREAM = "downstream"
    BOTH = "both"


@strawberry.enum
class Granularity(Enum):
    COLUMN = "column"
    TABLE = "table"
    SCHEMA = "schema"
    SYSTEM = "system"
    DOMAIN = "domain"


@strawberry.enum
class ScopeCombineMode(Enum):
    AND = "AND"
    OR = "OR"


# ============================================
# INPUT TYPES
# ============================================

@strawberry.input
class CursorPagination:
    """Cursor-based pagination input"""
    first: int = 50
    after: Optional[str] = None


@strawberry.input
class NodeFilterInput:
    """Filter for querying nodes"""
    urns: Optional[List[str]] = None
    entity_types: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    search_query: Optional[str] = None
    urn_pattern: Optional[str] = None  # Regex pattern


@strawberry.input
class ScopeFilterInput:
    """Compound filter to define view scope"""
    # URN pattern matching (supports wildcards)
    urn_patterns: Optional[List[str]] = None
    
    # Root entity selection (include all descendants)
    root_urns: Optional[List[str]] = None
    
    # Tag-based inclusion
    include_tags: Optional[List[str]] = None
    exclude_tags: Optional[List[str]] = None
    
    # Entity type filtering
    entity_types: Optional[List[str]] = None
    
    # Combine mode
    combine_mode: ScopeCombineMode = ScopeCombineMode.OR


@strawberry.input
class LineageRequestInput:
    """Enhanced lineage trace request"""
    direction: LineageDirection = LineageDirection.BOTH
    upstream_depth: int = 3
    downstream_depth: int = 3
    
    # Inheritance options
    inherit_from_descendants: bool = True  # Always aggregate child lineage to parent
    inherit_from_ancestors: bool = False   # User toggle: show parent's lineage too
    
    # Scope restriction (optional - limit trace to view scope)
    scope: Optional[ScopeFilterInput] = None
    
    # Aggregation
    aggregation_level: Granularity = Granularity.TABLE
    
    # Pagination
    max_nodes: int = 200


# ============================================
# OUTPUT TYPES
# ============================================

@strawberry.type
class PageInfo:
    """Pagination info for connections"""
    has_next_page: bool
    has_previous_page: bool
    start_cursor: Optional[str]
    end_cursor: Optional[str]
    total_count: int


@strawberry.type
class NodeProperties:
    """Dynamic properties as JSON"""
    data: strawberry.scalars.JSON


@strawberry.type
class Node:
    """A graph node (entity)"""
    urn: strawberry.ID
    entity_type: str
    display_name: str
    qualified_name: Optional[str] = None
    description: Optional[str] = None
    tags: List[str]
    layer_assignment: Optional[str] = None
    child_count: Optional[int] = None
    source_system: Optional[str] = None
    properties: strawberry.scalars.JSON
    
    # Relationships (resolved lazily)
    @strawberry.field
    async def parent(self, info: strawberry.Info) -> Optional["Node"]:
        """Get parent node via containment edge"""
        provider = info.context["provider"]
        parent = await provider.get_parent(self.urn)
        if parent:
            return node_from_graph_node(parent)
        return None
    
    @strawberry.field
    async def children(
        self, 
        info: strawberry.Info,
        first: int = 50,
        after: Optional[str] = None,
        entity_types: Optional[List[str]] = None
    ) -> "NodeConnection":
        """Get child nodes with pagination"""
        provider = info.context["provider"]
        
        # Decode cursor to offset
        offset = 0
        if after:
            try:
                offset = int(after)
            except:
                pass
        
        children = await provider.get_children(
            self.urn,
            entity_types=entity_types,
            offset=offset,
            limit=first + 1  # Fetch one extra to check hasNextPage
        )
        
        has_next = len(children) > first
        if has_next:
            children = children[:first]
        
        edges = [
            NodeEdge(
                cursor=str(offset + i),
                node=node_from_graph_node(child)
            )
            for i, child in enumerate(children)
        ]
        
        return NodeConnection(
            edges=edges,
            page_info=PageInfo(
                has_next_page=has_next,
                has_previous_page=offset > 0,
                start_cursor=str(offset) if edges else None,
                end_cursor=str(offset + len(edges) - 1) if edges else None,
                total_count=self.child_count or len(children)
            )
        )
    
    @strawberry.field
    async def columns(self, info: strawberry.Info) -> List["ColumnNode"]:
        """Get columns for table-type entities"""
        if self.entity_type not in ["dataset", "table", "asset"]:
            return []
        
        provider = info.context["provider"]
        children = await provider.get_children(
            self.urn,
            entity_types=["schemaField", "column"],
            limit=500  # Tables rarely have more columns
        )
        
        return [
            ColumnNode(
                urn=col.urn,
                name=col.display_name,
                data_type=col.properties.get("dataType"),
                description=col.description,
                tags=col.tags,
                ordinal=col.properties.get("ordinal", i)
            )
            for i, col in enumerate(children)
        ]
    
    @strawberry.field
    async def upstream(
        self, 
        info: strawberry.Info,
        depth: int = 3
    ) -> List["Node"]:
        """Get upstream lineage nodes"""
        provider = info.context["provider"]
        result = await provider.get_upstream(self.urn, depth)
        return [node_from_graph_node(n) for n in result.nodes if n.urn != self.urn]
    
    @strawberry.field
    async def downstream(
        self, 
        info: strawberry.Info,
        depth: int = 3
    ) -> List["Node"]:
        """Get downstream lineage nodes"""
        provider = info.context["provider"]
        result = await provider.get_downstream(self.urn, depth)
        return [node_from_graph_node(n) for n in result.nodes if n.urn != self.urn]


@strawberry.type
class ColumnNode:
    """A column within a table"""
    urn: strawberry.ID
    name: str
    data_type: Optional[str] = None
    description: Optional[str] = None
    tags: List[str]
    ordinal: Optional[int] = None
    
    @strawberry.field
    async def upstream_columns(self, info: strawberry.Info) -> List["ColumnLineageEdge"]:
        """Get upstream column lineage"""
        provider = info.context["provider"]
        result = await provider.get_upstream(self.urn, depth=1, include_column_lineage=True)
        
        edges = []
        for edge in result.edges:
            if edge.target_urn == self.urn:
                source_node = next((n for n in result.nodes if n.urn == edge.source_urn), None)
                if source_node and source_node.entity_type in ["schemaField", "column"]:
                    edges.append(ColumnLineageEdge(
                        source_column=ColumnNode(
                            urn=source_node.urn,
                            name=source_node.display_name,
                            data_type=source_node.properties.get("dataType"),
                            description=source_node.description,
                            tags=source_node.tags,
                            ordinal=source_node.properties.get("ordinal")
                        ),
                        target_column=ColumnNode(
                            urn=self.urn,
                            name=self.name,
                            data_type=self.data_type,
                            description=self.description,
                            tags=self.tags,
                            ordinal=self.ordinal
                        ),
                        transform_expression=edge.properties.get("transformExpression"),
                        confidence=edge.confidence
                    ))
        return edges
    
    @strawberry.field
    async def downstream_columns(self, info: strawberry.Info) -> List["ColumnLineageEdge"]:
        """Get downstream column lineage"""
        provider = info.context["provider"]
        result = await provider.get_downstream(self.urn, depth=1, include_column_lineage=True)
        
        edges = []
        for edge in result.edges:
            if edge.source_urn == self.urn:
                target_node = next((n for n in result.nodes if n.urn == edge.target_urn), None)
                if target_node and target_node.entity_type in ["schemaField", "column"]:
                    edges.append(ColumnLineageEdge(
                        source_column=ColumnNode(
                            urn=self.urn,
                            name=self.name,
                            data_type=self.data_type,
                            description=self.description,
                            tags=self.tags,
                            ordinal=self.ordinal
                        ),
                        target_column=ColumnNode(
                            urn=target_node.urn,
                            name=target_node.display_name,
                            data_type=target_node.properties.get("dataType"),
                            description=target_node.description,
                            tags=target_node.tags,
                            ordinal=target_node.properties.get("ordinal")
                        ),
                        transform_expression=edge.properties.get("transformExpression"),
                        confidence=edge.confidence
                    ))
        return edges


@strawberry.type
class ColumnLineageEdge:
    """Column-to-column lineage edge"""
    source_column: ColumnNode
    target_column: ColumnNode
    transform_expression: Optional[str] = None
    confidence: Optional[float] = None


@strawberry.type
class Edge:
    """A graph edge (relationship)"""
    id: strawberry.ID
    source_urn: str
    target_urn: str
    edge_type: str
    confidence: Optional[float] = None
    properties: strawberry.scalars.JSON
    is_aggregated: bool = False
    source_edge_count: Optional[int] = None  # For aggregated edges


@strawberry.type
class NodeEdge:
    """Connection edge for pagination"""
    cursor: str
    node: Node


@strawberry.type
class NodeConnection:
    """Paginated node list"""
    edges: List[NodeEdge]
    page_info: PageInfo


@strawberry.type
class LineageResult:
    """Result of a lineage query"""
    focus_node: Node
    nodes: List[Node]
    edges: List[Edge]
    
    upstream_urns: List[str]
    downstream_urns: List[str]
    
    # Inheritance info
    inherited_from_descendants: List[str]
    inherited_from_ancestors: List[str]
    
    # Stats
    total_upstream: int
    total_downstream: int
    truncated: bool  # True if max_nodes was reached


@strawberry.type
class ScopedGraphResult:
    """Result of a scoped graph query"""
    nodes: List[Node]
    edges: List[Edge]
    
    total_matching_nodes: int
    total_matching_edges: int


@strawberry.type
class SearchResult:
    """Search result with relevance"""
    node: Node
    score: float
    highlights: List[str]


@strawberry.type
class GraphStats:
    """Graph statistics"""
    total_nodes: int
    total_edges: int
    entity_type_counts: strawberry.scalars.JSON
    edge_type_counts: strawberry.scalars.JSON


# ============================================
# HELPER FUNCTIONS
# ============================================

def node_from_graph_node(graph_node) -> Node:
    """Convert backend GraphNode to GraphQL Node"""
    return Node(
        urn=graph_node.urn,
        entity_type=str(graph_node.entity_type),
        display_name=graph_node.display_name,
        qualified_name=graph_node.qualified_name,
        description=graph_node.description,
        tags=graph_node.tags or [],
        layer_assignment=graph_node.layer_assignment,
        child_count=graph_node.child_count,
        source_system=graph_node.source_system,
        properties=graph_node.properties or {}
    )


def edge_from_graph_edge(graph_edge, is_aggregated: bool = False, source_edge_count: int = None) -> Edge:
    """Convert backend GraphEdge to GraphQL Edge"""
    return Edge(
        id=graph_edge.id,
        source_urn=graph_edge.source_urn,
        target_urn=graph_edge.target_urn,
        edge_type=str(graph_edge.edge_type),
        confidence=graph_edge.confidence,
        properties=graph_edge.properties or {},
        is_aggregated=is_aggregated,
        source_edge_count=source_edge_count
    )

