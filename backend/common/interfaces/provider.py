"""
Abstract GraphDataProvider interface — shared kernel.
Both the visualization service and graph service import from here.
"""
from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any

from ..models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery,
    LineageResult, EntityType, EdgeType, GraphSchemaStats, OntologyMetadata,
    ChildrenWithEdgesResult,
)


class GraphDataProvider(ABC):
    """
    Abstract interface for graph data providers.
    Enables swapping between Mock, FalkorDB, Neo4j, DataHub, etc.
    All methods must be async to prevent blocking the event loop.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name for debugging"""
        pass

    # ==========================================
    # Node Operations
    # ==========================================

    @abstractmethod
    async def get_node(self, urn: str) -> Optional[GraphNode]:
        pass

    @abstractmethod
    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        pass

    @abstractmethod
    async def search_nodes(self, query: str, limit: int = 10) -> List[GraphNode]:
        pass

    # ==========================================
    # Edge Operations
    # ==========================================

    @abstractmethod
    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        pass

    # ==========================================
    # Containment Hierarchy
    # ==========================================

    @abstractmethod
    async def get_children(
        self,
        parent_urn: str,
        entity_types: Optional[List[EntityType]] = None,
        edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
        sort_property: Optional[str] = "displayName",
    ) -> List[GraphNode]:
        pass

    async def get_children_with_edges(
        self,
        parent_urn: str,
        edge_types: Optional[List[str]] = None,
        lineage_edge_types: Optional[List[str]] = None,
        search_query: Optional[str] = None,
        offset: int = 0,
        limit: int = 100,
        include_lineage_edges: bool = True,
        sort_property: Optional[str] = "displayName",
    ) -> ChildrenWithEdgesResult:
        """Get children with containment and optionally lineage edges in one round-trip.

        Default implementation delegates to get_children + get_edges.
        Providers may override with an optimized single-query implementation.
        """
        from ..models.graph import EdgeQuery
        children = await self.get_children(
            parent_urn, edge_types=edge_types,
            search_query=search_query, offset=offset, limit=limit,
            sort_property=sort_property,
        )
        child_urns = [c.urn for c in children]
        all_urns = [parent_urn] + child_urns

        # Fetch containment edges between parent and children
        containment_edges: List[GraphEdge] = []
        lineage_edges: List[GraphEdge] = []
        if child_urns:
            edges = await self.get_edges(EdgeQuery(
                source_urns=all_urns, target_urns=all_urns, limit=len(all_urns) * 10,
            ))
            containment_types = set(t.upper() for t in (edge_types or []))
            lineage_filter = set(t.upper() for t in lineage_edge_types) if lineage_edge_types else None
            for e in edges:
                if e.edge_type.upper() in containment_types:
                    containment_edges.append(e)
                elif include_lineage_edges:
                    if lineage_filter is None or e.edge_type.upper() in lineage_filter:
                        lineage_edges.append(e)

        # We don't know total_children without a count query; approximate
        has_more = len(children) >= limit
        total = offset + len(children) + (1 if has_more else 0)

        return ChildrenWithEdgesResult(
            children=children,
            containmentEdges=containment_edges,
            lineageEdges=lineage_edges,
            totalChildren=total,
            hasMore=has_more,
        )

    @abstractmethod
    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        pass

    # ==========================================
    # Lineage Traversal
    # ==========================================

    @abstractmethod
    async def get_upstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None,
    ) -> LineageResult:
        pass

    @abstractmethod
    async def get_downstream(
        self,
        urn: str,
        depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None,
    ) -> LineageResult:
        pass

    @abstractmethod
    async def get_full_lineage(
        self,
        urn: str,
        upstream_depth: int,
        downstream_depth: int,
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None,
    ) -> LineageResult:
        pass

    @abstractmethod
    async def get_aggregated_edges_between(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        granularity: Any,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> Any:
        pass

    @abstractmethod
    async def get_trace_lineage(
        self,
        urn: str,
        direction: str,
        depth: int,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> LineageResult:
        pass

    # ==========================================
    # Metadata Operations
    # ==========================================

    @abstractmethod
    async def get_stats(self) -> Dict[str, Any]:
        pass

    @abstractmethod
    async def get_schema_stats(self) -> GraphSchemaStats:
        pass

    @abstractmethod
    async def get_ontology_metadata(self) -> OntologyMetadata:
        pass

    @abstractmethod
    async def get_distinct_values(self, property_name: str) -> List[Any]:
        pass

    # ==========================================
    # Traversal & Filtering Extensions
    # ==========================================

    @abstractmethod
    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        pass

    @abstractmethod
    async def get_descendants(
        self,
        urn: str,
        depth: int = 5,
        entity_types: Optional[List[EntityType]] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[GraphNode]:
        pass

    @abstractmethod
    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        pass

    @abstractmethod
    async def get_nodes_by_layer(self, layer_id: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        pass

    # ==========================================
    # Write Operations
    # ==========================================

    @abstractmethod
    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        pass

    @abstractmethod
    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        pass

    # ==========================================
    # Optional Extension Methods
    # (concrete implementations are optional — default no-ops)
    # ==========================================

    # ==========================================
    # Projection / Materialization Lifecycle Hooks
    # (no-ops by default — providers override as needed)
    # ==========================================

    async def ensure_projections(self) -> None:
        """Set up projection infrastructure (indices, projection graphs, etc.)."""
        pass

    async def on_lineage_edge_written(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
        edge_type: str,
    ) -> None:
        """Called after a lineage edge is created/updated. Materializes AGGREGATED edges."""
        pass

    async def on_lineage_edge_deleted(
        self,
        source_urn: str,
        target_urn: str,
        edge_id: str,
    ) -> None:
        """Called after a lineage edge is removed. Decrements AGGREGATED edge weights."""
        pass

    async def on_containment_changed(self, urn: str) -> None:
        """Called when a node's containment (parent) changes. Rebuilds ancestor chains."""
        pass

    async def discover_schema(self) -> Dict[str, Any]:
        """Introspect the database and return available labels, relationship
        types, property keys, and sample data.

        Used for schema mapping configuration when connecting to an external
        graph database with an unknown property schema.

        Returns
        -------
        dict
            Keys may include ``labels``, ``relationshipTypes``,
            ``labelDetails`` (per-label counts, property keys, samples),
            and ``suggestedMapping`` (a best-guess SchemaMapping dict).
            Returns empty dict by default.
        """
        return {}

    async def list_graphs(self) -> List[str]:
        """
        List named graph keys / databases available on this provider instance.
        FalkorDB: GRAPH.LIST  |  Neo4j: SHOW DATABASES
        Returns empty list by default.
        """
        return []

    async def close(self) -> None:
        """
        Release connection pool resources.
        Called by ProviderRegistry.evict() before removing a provider from cache.
        """
        pass
