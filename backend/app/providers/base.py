from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any, Set
from ..models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery, 
    LineageResult, EntityType, EdgeType, GraphSchemaStats, OntologyMetadata
)

class GraphDataProvider(ABC):
    """
    Abstract interface for graph data providers.
    Enables swapping between Mock, FalkorDB, Neo4j, etc.
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
        """Get a single node by URN"""
        pass

    @abstractmethod
    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        """Query multiple nodes"""
        pass

    @abstractmethod
    async def search_nodes(self, query: str, limit: int = 10) -> List[GraphNode]:
        """Search nodes by text query"""
        pass

    # ==========================================
    # Edge Operations
    # ==========================================

    @abstractmethod
    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        """Query edges matching criteria"""
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
        offset: int = 0, 
        limit: int = 100
    ) -> List[GraphNode]:
        """Get direct children of a node"""
        pass

    @abstractmethod
    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        """Get parent of a node"""
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
        descendant_types: Optional[List[EntityType]] = None
    ) -> LineageResult:
        """Get upstream lineage"""
        pass

    @abstractmethod
    async def get_downstream(
        self, 
        urn: str, 
        depth: int, 
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None
    ) -> LineageResult:
        """Get downstream lineage"""
        pass

    @abstractmethod
    async def get_full_lineage(
        self, 
        urn: str, 
        upstream_depth: int, 
        downstream_depth: int, 
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None
    ) -> LineageResult:
        """Get both upstream and downstream lineage"""
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
        """
        Execute a targeted lineage trace using dynamic edge lists.
        Used for ontology-driven tracing.
        """
        pass
    
    # ==========================================
    # Metadata Operations
    # ==========================================

    @abstractmethod
    async def get_stats(self) -> Dict[str, Any]:
        """Get simple graph statistics"""
        pass

    @abstractmethod
    async def get_schema_stats(self) -> GraphSchemaStats:
        """Get detailed graph schema statistics"""
        pass

    @abstractmethod
    async def get_ontology_metadata(self) -> OntologyMetadata:
        """Get ontology metadata including containment edge types and entity hierarchies"""
        pass

    @abstractmethod
    async def get_distinct_values(self, property_name: str) -> List[Any]:
        """Get distinct values for a property"""
        pass

    # ==========================================
    # Traversal & Filtering Extensions
    # ==========================================

    @abstractmethod
    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        """Get all ancestors"""
        pass

    @abstractmethod
    async def get_descendants(
        self, 
        urn: str, 
        depth: int = 5, 
        entity_types: Optional[List[EntityType]] = None,
        limit: int = 100, 
        offset: int = 0
    ) -> List[GraphNode]:
        """Get all descendants"""
        pass

    @abstractmethod
    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        """Get nodes by tag"""
        pass

    @abstractmethod
    async def get_nodes_by_layer(self, layer_id: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        """Get nodes by layer"""
        pass

    # ==========================================
    # Write Operations
    # ==========================================

    @abstractmethod
    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        """Save a custom graph (nodes and edges) meant for editing/manual creation."""
        pass

    @abstractmethod
    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        """Create a new node with optional containment edge."""
        pass
