import asyncio
import logging
import time
from typing import List, Dict, Any, Set, Optional, Tuple, TYPE_CHECKING
from ..models.graph import (
    GraphNode, GraphEdge, LineageResult, Granularity, NodeQuery, EdgeQuery, GraphSchemaStats, OntologyMetadata,
    GraphSchema, EntityTypeDefinition, RelationshipTypeDefinition, EntityVisualSchema, EntityHierarchySchema, EntityBehaviorSchema,
    RelationshipVisualSchema, FieldSchema, AggregatedEdgeRequest, AggregatedEdgeResult, AggregatedEdgeInfo,
    CreateNodeRequest, CreateNodeResult
)
import os

from ..providers.base import GraphDataProvider
from ..providers.mock_provider import MockGraphProvider

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from ..ontology.protocols import OntologyServiceProtocol

logger = logging.getLogger(__name__)


def _create_provider() -> GraphDataProvider:
    """Create graph provider based on GRAPH_PROVIDER env var."""
    provider_name = os.getenv("GRAPH_PROVIDER", "falkordb").lower()
    if provider_name == "falkordb":
        from ..providers.falkordb_provider import FalkorDBProvider
        return FalkorDBProvider(
            host=os.getenv("FALKORDB_HOST", "localhost"),
            port=int(os.getenv("FALKORDB_PORT", "6379")),
            graph_name=os.getenv("FALKORDB_GRAPH_NAME", "nexus_lineage"),
            seed_file=os.getenv("FALKORDB_SEED_FILE"),
        )
    return MockGraphProvider()


# Granularity canonical name -> Granularity enum (kept for aggregation logic).
# These are derived from entity def 'granularity' field; this mapping translates
# the string value stored in ontology defs to the Granularity enum.
_GRAN_STR_TO_ENUM: Dict[str, Granularity] = {
    'column': Granularity.COLUMN,
    'table': Granularity.TABLE,
    'schema': Granularity.SCHEMA,
    'system': Granularity.SYSTEM,
    'domain': Granularity.DOMAIN,
}

GRANULARITY_LEVELS = {
    Granularity.COLUMN: 0,
    Granularity.TABLE: 1,
    Granularity.SCHEMA: 2,
    Granularity.SYSTEM: 3,
    Granularity.DOMAIN: 4,
}

class ContextEngine:
    _ONTOLOGY_CACHE_TTL = 300  # 5 minutes

    def __init__(
        self,
        provider: GraphDataProvider = None,
        ontology_service: Optional["OntologyServiceProtocol"] = None,
    ):
        self.provider = provider or MockGraphProvider()
        self._ontology_service = ontology_service  # injected; None = legacy path
        self._connection_id: Optional[str] = None
        self._workspace_id: Optional[str] = None
        self._data_source_id: Optional[str] = None
        self._db_session: Optional["AsyncSession"] = None
        self._ontology_cache: Optional[OntologyMetadata] = None
        self._ontology_cache_ts: float = 0.0
        # Cache for resolved rich definitions (keyed by workspace+ds)
        self._resolved_ontology_cache: Optional[Any] = None
        self._resolved_ontology_cache_ts: float = 0.0

    # ------------------------------------------------------------------ #
    # Workspace-aware factory (new)                                        #
    # ------------------------------------------------------------------ #

    @classmethod
    async def for_workspace(
        cls,
        workspace_id: str,
        registry: Any,  # ProviderRegistry — avoid circular import
        session: "AsyncSession",
        data_source_id: Optional[str] = None,
    ) -> "ContextEngine":
        """
        Create a ContextEngine scoped to a workspace data source.
        If data_source_id is given, uses that specific source; otherwise the primary.
        """
        from ..ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from ..ontology.service import LocalOntologyService

        provider = await registry.get_provider_for_workspace(
            workspace_id, session, data_source_id
        )
        repo = SQLAlchemyOntologyRepository(session)
        ontology_service = LocalOntologyService(repo)
        engine = cls(provider=provider, ontology_service=ontology_service)
        engine._workspace_id = workspace_id
        engine._data_source_id = data_source_id
        engine._db_session = session
        return engine

    # ------------------------------------------------------------------ #
    # Connection-aware factory (legacy compat)                             #
    # ------------------------------------------------------------------ #

    @classmethod
    async def for_connection(
        cls,
        connection_id: Optional[str],
        registry: Any,  # ProviderRegistry — avoid circular import
        session: "AsyncSession",
    ) -> "ContextEngine":
        """
        Create a ContextEngine backed by the specified connection.
        When connection_id is None, uses the primary connection from registry.
        """
        provider = await registry.get_provider(connection_id, session)
        engine = cls(provider=provider)
        engine._connection_id = connection_id
        engine._db_session = session
        return engine

    # ------------------------------------------------------------------ #
    # Ontology resolution with DB override merging                          #
    # ------------------------------------------------------------------ #

    async def get_ontology_metadata(self) -> OntologyMetadata:
        """
        Return ontology metadata, merging stored config with graph introspection.
        Results are cached with a TTL to avoid repeated DB/graph queries.

        Priority order:
        1. Workspace path: load assigned ontology → merge with introspection
        2. Connection path (legacy): load ontology_config → merge with introspection
        3. Singleton path: introspection only
        """
        now = time.monotonic()
        if self._ontology_cache and (now - self._ontology_cache_ts) < self._ONTOLOGY_CACHE_TTL:
            return self._ontology_cache

        result = await self._fetch_ontology_metadata()
        self._ontology_cache = result
        self._ontology_cache_ts = now
        return result

    def invalidate_ontology_cache(self) -> None:
        """Clear cached ontology so the next call re-fetches from source."""
        self._ontology_cache = None
        self._resolved_ontology_cache = None

    async def _fetch_ontology_metadata(self) -> OntologyMetadata:
        """
        Internal: fetch and merge ontology metadata (uncached).

        Uses the OntologyService for workspace-scoped engines with the three-layer merge:
        system_default <- assigned <- introspection.
        Falls back to introspection-only for unregistered engines.
        """
        introspected = await self.provider.get_ontology_metadata()

        if self._ontology_service and self._workspace_id:
            try:
                resolved = await self._ontology_service.resolve(
                    workspace_id=self._workspace_id,
                    data_source_id=self._data_source_id,
                    introspected=introspected,
                )
                # Cache the rich resolved ontology for get_graph_schema()
                self._resolved_ontology_cache = resolved
                self._resolved_ontology_cache_ts = time.monotonic()
                # Convert ResolvedOntology back to OntologyMetadata (flat format for legacy callers)
                return OntologyMetadata(
                    containmentEdgeTypes=resolved.containment_edge_types,
                    lineageEdgeTypes=resolved.lineage_edge_types,
                    edgeTypeMetadata=resolved.edge_type_metadata,
                    entityTypeHierarchy=resolved.entity_type_hierarchy,
                    rootEntityTypes=resolved.root_entity_types,
                )
            except Exception as exc:
                logger.warning("OntologyService.resolve() failed, falling back to introspection: %s", exc)

        return introspected

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        return await self.provider.get_node(urn)

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        return await self.provider.search_nodes(query, limit=limit, offset=offset)
    
    async def get_stats(self) -> Dict[str, Any]:
        return await self.provider.get_stats()

    async def get_schema_stats(self) -> GraphSchemaStats:
        return await self.provider.get_schema_stats()
    
    async def get_children(self, urn: str, edge_types: Optional[List[str]] = None, search_query: Optional[str] = None, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return await self.provider.get_children(urn, entity_types=None, edge_types=edge_types, search_query=search_query, limit=limit, offset=offset)

    async def get_edges(self, query: EdgeQuery = None) -> List[GraphEdge]:
        if query is None: query = EdgeQuery()
        return await self.provider.get_edges(query)

    async def get_neighborhood(self, urn: str) -> Optional[Dict[str, Any]]:
        """Get the node and its immediate edges (incoming/outgoing)."""
        # Run node fetch and edge fetch concurrently (2 round-trips instead of 4)
        node, all_edges = await asyncio.gather(
            self.get_node(urn),
            self.provider.get_edges(EdgeQuery(any_urns=[urn])),
        )
        if not node:
            return None

        # Determine neighbor URNs to fetch their details
        neighbor_urns = set()
        for e in all_edges:
            neighbor_urns.add(e.source_urn)
            neighbor_urns.add(e.target_urn)
        neighbor_urns.discard(urn)  # Don't re-fetch the central node

        neighbor_nodes = await self.provider.get_nodes(
            NodeQuery(urns=list(neighbor_urns), limit=len(neighbor_urns) or 1)
        ) if neighbor_urns else []

        return {
            "node": node,
            "edges": all_edges,
            "neighbors": neighbor_nodes
        }

    async def get_lineage(
        self, 
        urn: str, 
        upstream_depth: int, 
        downstream_depth: int,
        granularity: Granularity = Granularity.TABLE,
        aggregate_edges: bool = True,
        exclude_containment_edges: bool = True,
        include_inherited_lineage: bool = True,
        lineage_edge_types: Optional[List[str]] = None
    ) -> LineageResult:
        """
        Get lineage and optionally aggregate it to a coarser granularity.
        
        All edge classification (containment vs lineage) is derived from
        the ontology metadata — no hardcoded edge type references.
        
        Args:
            urn: Starting entity URN
            upstream_depth: How many hops upstream to traverse
            downstream_depth: How many hops downstream to traverse
            granularity: Target granularity for projection
            aggregate_edges: Whether to aggregate edges at granularity level
            exclude_containment_edges: Filter out containment edges (for pure data lineage)
            include_inherited_lineage: Aggregate lineage from children to parent
            lineage_edge_types: Optional whitelist of lineage edge types to include.
                               When set, only edges of these types are treated as lineage.
                               When None, all ontology-classified lineage types are used.
        """
        # Load ontology metadata once — merges DB overrides + introspection
        ontology = await self.get_ontology_metadata()
        containment_types = {t.upper() for t in ontology.containment_edge_types}
        all_lineage_types = {t.upper() for t in ontology.lineage_edge_types}
        
        # Apply optional lineage type filter (user can select subset via TraceOptions)
        if lineage_edge_types:
            active_lineage_types = {t.upper() for t in lineage_edge_types} & all_lineage_types
        else:
            active_lineage_types = all_lineage_types
        
        # Always fetch column lineage at the base to ensure we have data to roll up
        include_cols = True 
        
        # Use new Targeted Trace method
        # Convert sets to lists for the provider
        containment_list = list(containment_types)
        lineage_list = list(active_lineage_types)
        
        
        # If specific direction requested, we might need to filter the result?
        # get_trace_lineage takes 'direction'.
        trace_direction = "both"
        if upstream_depth > 0 and downstream_depth == 0:
            trace_direction = "upstream"
        elif downstream_depth > 0 and upstream_depth == 0:
            trace_direction = "downstream"
            
        # Re-call with correct direction if needed, or just let it return everything?
        # The provider's get_trace_lineage takes 'direction' but I didn't pass it above.
        # Let's correct the call.
        
        result = await self.provider.get_trace_lineage(
            urn,
            trace_direction,
            max(upstream_depth, downstream_depth),
            containment_list,
            lineage_list
        )
        
        # Build containment map BEFORE filtering - needed for column->table aggregation
        containment_map = self._build_containment_map(result.nodes, result.edges, containment_types)
        
        # Filter containment edges if requested (for pure data lineage view)
        # Filter containment edges if requested (for pure data lineage view)
        # We DO NOT filter containment edges here because they are needed for structural context (nesting nodes).
        # "exclude_containment_edges" implies broad traversal behavior, not visual suppression.
        # if exclude_containment_edges:
        #    result = self._filter_containment_edges(result, containment_types)
        
        # Handle inherited lineage - if entity has no direct lineage, try parent
        if include_inherited_lineage:
            result = await self._apply_inherited_lineage(
                urn, result, upstream_depth, downstream_depth,
                containment_types, active_lineage_types
            )
        
        if not aggregate_edges and granularity == Granularity.COLUMN:
            return result
        
        # When projecting from column to table (or higher), ensure ancestor nodes are in the set
        # so aggregated edges have nodes to connect to
        if granularity != Granularity.COLUMN:
            node_map = {n.urn: n for n in result.nodes}
            ancestor_urns_to_add = set()
            for node in result.nodes:
                anc = self._find_ancestor_at_granularity(
                    node.urn, granularity, result.nodes, containment_map
                )
                if anc and anc not in node_map:
                    ancestor_urns_to_add.add(anc)
            if ancestor_urns_to_add:
                extra_nodes = await self.provider.get_nodes(NodeQuery(urns=list(ancestor_urns_to_add)))
                for n in extra_nodes:
                    if n.urn not in node_map:
                        result.nodes.append(n)
                        node_map[n.urn] = n
            
        # Perform Server-Side Projection (pass containment_map for column aggregation)
        projected_result = self._project_graph(
            result, granularity, aggregate_edges, containment_map, containment_types
        )
        return projected_result
    
    def _filter_containment_edges(
        self, result: LineageResult, containment_types: Set[str]
    ) -> LineageResult:
        """Remove containment edges from result, keeping only data lineage edges."""
        filtered_edges = [
            e for e in result.edges
            if self._normalize_edge_type(e.edge_type) not in containment_types
        ]
        
        return LineageResult(
            nodes=result.nodes,
            edges=filtered_edges,
            upstreamUrns=result.upstream_urns,
            downstreamUrns=result.downstream_urns,
            totalCount=result.total_count,
            hasMore=result.has_more,
            aggregatedEdges=result.aggregated_edges
        )
    
    @staticmethod
    def _normalize_edge_type(edge_type) -> str:
        """Normalize edge type to uppercase string for comparison."""
        return str(edge_type).upper()

    def _entity_granularity(self, entity_type: str) -> Granularity:
        """
        Map an entity type string to a Granularity enum value.
        Uses the resolved ontology's entity definition 'granularity' field when available;
        falls back to the canonical string-to-enum mapping for well-known types.
        """
        if self._resolved_ontology_cache:
            ent_def = self._resolved_ontology_cache.entity_type_definitions.get(entity_type)
            if ent_def:
                gran_str = ent_def.granularity
                return _GRAN_STR_TO_ENUM.get(gran_str, Granularity.COLUMN)

        # Built-in fallback for well-known types (same as the old ENTITY_GRANULARITY dict)
        _FALLBACK: Dict[str, Granularity] = {
            'column': Granularity.COLUMN, 'schemaField': Granularity.COLUMN,
            'dataset': Granularity.TABLE, 'asset': Granularity.TABLE, 'table': Granularity.TABLE,
            'schema': Granularity.SCHEMA, 'container': Granularity.SCHEMA,
            'system': Granularity.SYSTEM, 'dataPlatform': Granularity.SYSTEM, 'app': Granularity.SYSTEM,
            'domain': Granularity.DOMAIN,
        }
        return _FALLBACK.get(entity_type, Granularity.COLUMN)

    async def _apply_inherited_lineage(
        self, 
        urn: str, 
        result: LineageResult, 
        upstream_depth: int, 
        downstream_depth: int, 
        containment_types: Set[str],
        lineage_types: Set[str]
    ) -> LineageResult:
        """
        If the target entity has no direct lineage edges, inherit from parent.
        This handles cases like clicking on a column that has no lineage but its table does.
        
        Edge classification is derived from ontology — no hardcoded type references.
        """
        # Check if result has any lineage edges using ontology-derived types
        has_direct_lineage = any(
            self._normalize_edge_type(e.edge_type) in lineage_types
            for e in result.edges
        )
        
        if has_direct_lineage:
            # Check if we should merge with parent anyway? 
            # Usually strict inheritance means "use parent if child has none".
            # But if we want comprehensive "context", maybe we always add parent?
            # For now, stick to standard inheritance pattern.
            return result
        
        # Try to get parent's lineage
        parent = await self.provider.get_parent(urn)
        if not parent:
            return result  # No parent, nothing to inherit
        
        # Fetch parent's lineage
        parent_result = await self.provider.get_full_lineage(
            parent.urn, upstream_depth, downstream_depth, include_column_lineage=True
        )
        
        # Filter containment edges from parent result too
        # parent_result = self._filter_containment_edges(parent_result, containment_types)
        
        # Merge: Add original node to parent's result, mark as inherited
        merged_nodes = list(parent_result.nodes)
        original_node = next((n for n in result.nodes if n.urn == urn), None)
        if original_node and original_node not in merged_nodes:
            # We want to insert it, but ensure we don't duplicate
            merged_nodes.append(original_node)
        
        # Update upstream/downstream to include parent
        merged_upstream = parent_result.upstream_urns.copy()
        merged_downstream = parent_result.downstream_urns.copy()
        
        # Mark the inheritance in aggregated edges metadata
        aggregated = parent_result.aggregated_edges or {}
        aggregated['_inheritedFrom'] = parent.urn
        
        return LineageResult(
            nodes=merged_nodes,
            edges=parent_result.edges,
            upstreamUrns=merged_upstream,
            downstreamUrns=merged_downstream,
            totalCount=len(merged_nodes),
            hasMore=parent_result.has_more,
            aggregatedEdges=aggregated
        )

    def _project_graph(
        self, 
        result: LineageResult, 
        target_granularity: Granularity,
        aggregate_edges: bool,
        containment_map: Optional[Dict[str, str]] = None,
        containment_types: Optional[Set[str]] = None
    ) -> LineageResult:
        nodes = result.nodes
        edges = result.edges
        
        if containment_types is None:
            containment_types = set()
        
        # Use provided containment map or build from edges (may be empty if containment were filtered)
        if containment_map is None:
            containment_map = self._build_containment_map(nodes, edges, containment_types)
        
        # Filter nodes to target granularity
        target_level = GRANULARITY_LEVELS.get(target_granularity, 0)
        
        visible_nodes = []
        visible_node_ids = set()
        
        for node in nodes:
            # Map entity type to granularity using resolved ontology if available, else fallback
            entity_key = str(node.entity_type)
            node_gran = self._entity_granularity(entity_key)
            node_level = GRANULARITY_LEVELS.get(node_gran, 0)
            
            if node_level >= target_level:
                visible_nodes.append(node)
                visible_node_ids.add(node.urn)
                
        # Filter edges (keep only those connecting visible nodes, for now)
        # BUT we need to aggregate first!
        
        aggregated_edges_map = {}
        visible_edges = []
        
        if aggregate_edges:
            aggregated_list = self._aggregate_lineage_edges(
                edges, nodes, containment_map, target_granularity, containment_types
            )
            for agg in aggregated_list:
                # Only include if both source/target are visible
                if agg["sourceUrn"] in visible_node_ids and agg["targetUrn"] in visible_node_ids:
                    agg_id = agg["id"]
                    aggregated_edges_map[agg_id] = agg
                    
                    # Create a synthetic edge for the graph
                    visible_edges.append(GraphEdge(
                        id=agg_id,
                        sourceUrn=agg["sourceUrn"],
                        targetUrn=agg["targetUrn"],
                        edgeType="AGGREGATED",
                        confidence=agg["confidence"],
                        properties={
                            "isAggregated": True,
                            "sourceEdgeCount": len(agg["sourceEdges"])
                        }
                    ))
        
        # Add original edges that are visible at this level
        for edge in edges:
            if edge.source_urn in visible_node_ids and edge.target_urn in visible_node_ids:
                # If it's a containment edge, keep it if it fits
                edge_type_normalized = self._normalize_edge_type(edge.edge_type)
                if edge_type_normalized in containment_types:
                     visible_edges.append(edge)
                else:
                    visible_edges.append(edge)

        # Update upstream/downstream URNs to reflect visible nodes?
        # Actually LineageResult.upstream_urns usually refers to the root entities found.
        # We might need to map them to ancestors if they were columns.
        new_upstream = set()
        for urn in result.upstream_urns:
            ancestor = self._find_ancestor_at_granularity(urn, target_granularity, nodes, containment_map)
            if ancestor: new_upstream.add(ancestor)
            
        new_downstream = set()
        for urn in result.downstream_urns:
            ancestor = self._find_ancestor_at_granularity(urn, target_granularity, nodes, containment_map)
            if ancestor: new_downstream.add(ancestor)

        return LineageResult(
            nodes=visible_nodes,
            edges=visible_edges,
            upstreamUrns=new_upstream,
            downstreamUrns=new_downstream,
            totalCount=len(visible_nodes),
            hasMore=False,
            aggregatedEdges=aggregated_edges_map
        )

    def _build_containment_map(
        self, nodes: List[GraphNode], edges: List[GraphEdge],
        containment_types: Set[str]
    ) -> Dict[str, str]:
        """Build child -> parent mapping using ontology-classified containment types."""
        containment = {}
        for edge in edges:
            edge_type_normalized = self._normalize_edge_type(edge.edge_type)
            if edge_type_normalized in containment_types or edge.properties.get("relationship") == "contains":
                containment[edge.target_urn] = edge.source_urn
        return containment

    def _infer_granularity_from_urn(self, urn: str) -> Granularity:
        """Infer granularity from URN pattern when node is not in our set."""
        if not urn or ":" not in urn:
            return Granularity.COLUMN
        lower = urn.lower()
        if "schemafield" in lower:
            return Granularity.COLUMN
        if "dataset" in lower:
            return Granularity.TABLE
        if "container" in lower:
            return Granularity.SCHEMA
        if "dataplatform" in lower or "app" in lower:
            return Granularity.SYSTEM
        if "domain" in lower:
            return Granularity.DOMAIN
        return Granularity.COLUMN

    def _find_ancestor_at_granularity(
        self, 
        urn: str, 
        target_granularity: Granularity, 
        nodes: List[GraphNode], 
        containment_map: Dict[str, str]
    ) -> Optional[str]:
        node_map = {n.urn: n for n in nodes}
        target_level = GRANULARITY_LEVELS.get(target_granularity, 0)
        
        current_urn = urn
        visited = set()
        
        while current_urn and current_urn not in visited:
            visited.add(current_urn)
            node = node_map.get(current_urn)
            # Use node.entity_type if available, else infer from URN (for ancestors not in our set)
            if node:
                entity_key = str(node.entity_type)
                node_gran = self._entity_granularity(entity_key)
            else:
                node_gran = self._infer_granularity_from_urn(current_urn)
            node_level = GRANULARITY_LEVELS.get(node_gran, 0)
            
            if node_level >= target_level:
                return current_urn
            
            current_urn = containment_map.get(current_urn)
            
        return None

    def _aggregate_lineage_edges(
        self,
        edges: List[GraphEdge],
        nodes: List[GraphNode],
        containment_map: Dict[str, str],
        target_granularity: Granularity,
        containment_types: Optional[Set[str]] = None
    ) -> List[Dict[str, Any]]:
        
        if containment_types is None:
            containment_types = set()
        
        aggregated_map = {} # key -> data
        
        for edge in edges:
            # Skip containment edges — ontology-driven
            edge_type_normalized = self._normalize_edge_type(edge.edge_type)
            if edge_type_normalized in containment_types:
                continue
                
            source_ancestor = self._find_ancestor_at_granularity(
                edge.source_urn, target_granularity, nodes, containment_map
            )
            target_ancestor = self._find_ancestor_at_granularity(
                edge.target_urn, target_granularity, nodes, containment_map
            )
            
            if source_ancestor and target_ancestor and source_ancestor != target_ancestor:
                key = f"{source_ancestor}->{target_ancestor}"
                
                if key not in aggregated_map:
                    aggregated_map[key] = {
                        "id": f"agg-{key}",
                        "sourceUrn": source_ancestor,
                        "targetUrn": target_ancestor,
                        "sourceEdges": [],
                        "confidence": 0.0,
                        "granularity": target_granularity
                    }
                
                aggregated_map[key]["sourceEdges"].append(edge.id)
                # Simple confidence logic
                count = len(aggregated_map[key]["sourceEdges"])
                aggregated_map[key]["confidence"] = min(1.0, count / 5.0) # Arbitrary scaling

        return list(aggregated_map.values())

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return await self.provider.get_ancestors(urn, limit=limit, offset=offset)

    async def get_descendants(
        self, 
        urn: str, 
        depth: int = 5, 
        entity_types: Optional[List[str]] = None,
        limit: int = 100, 
        offset: int = 0
    ) -> List[GraphNode]:
        return await self.provider.get_descendants(urn, depth=depth, entity_types=entity_types, limit=limit, offset=offset)

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return await self.provider.get_nodes_by_tag(tag, limit=limit, offset=offset)

    async def get_nodes_by_layer(self, layer_id: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return await self.provider.get_nodes_by_layer(layer_id, limit=limit, offset=offset)

    async def get_graph_schema(self) -> GraphSchema:
        """
        Build a complete graph schema from resolved ontology definitions and introspection stats.
        Uses the rich entity/relationship definitions from the OntologyService when available;
        falls back to generating definitions from introspection stats + minimal defaults.
        """
        stats = await self.provider.get_schema_stats()
        # Calling get_ontology_metadata() will also populate _resolved_ontology_cache
        ontology = await self.get_ontology_metadata()

        resolved = self._resolved_ontology_cache
        entity_types: List[EntityTypeDefinition] = []
        relationship_types: List[RelationshipTypeDefinition] = []

        if resolved and resolved.entity_type_definitions:
            # Rich path: build from ontology service definitions
            entity_types = self._build_entity_types_from_resolved(stats, resolved)
            relationship_types = self._build_rel_types_from_resolved(stats, ontology, resolved)
        else:
            # Legacy/fallback path: minimal definitions from stats + defaults
            from ..ontology.defaults import SYSTEM_ENTITY_TYPES, SYSTEM_RELATIONSHIP_TYPES
            from ..ontology.resolver import parse_entity_definitions, parse_relationship_definitions
            sys_ent = parse_entity_definitions(SYSTEM_ENTITY_TYPES)
            sys_rel = parse_relationship_definitions(SYSTEM_RELATIONSHIP_TYPES)
            entity_types = self._build_entity_types_from_dicts(stats, ontology, sys_ent)
            relationship_types = self._build_rel_types_from_dicts(stats, ontology, sys_rel)

        return GraphSchema(
            version="1.0.0",
            entityTypes=entity_types,
            relationshipTypes=relationship_types,
            rootEntityTypes=ontology.root_entity_types,
            containmentEdgeTypes=ontology.containment_edge_types,
        )

    def _build_entity_types_from_resolved(self, stats, resolved) -> List[EntityTypeDefinition]:
        """Build EntityTypeDefinition list from rich resolved ontology definitions."""
        from ..ontology.models import EntityTypeDefEntry

        stat_map = {s.id: s for s in stats.entity_type_stats}
        result: List[EntityTypeDefinition] = []

        # Include all types that appear in either stats or resolved definitions
        seen_ids = set(stat_map.keys()) | set(resolved.entity_type_definitions.keys())

        for entity_id in seen_ids:
            ent_def: Optional[EntityTypeDefEntry] = resolved.entity_type_definitions.get(entity_id)
            stat = stat_map.get(entity_id)

            if ent_def is None:
                # Synthesise minimal definition for types only in stats
                from ..ontology.models import EntityTypeDefEntry
                ent_def = EntityTypeDefEntry(name=entity_id.title(), plural_name=entity_id.title() + "s")

            icon = (stat.icon if stat else None) or ent_def.visual.icon
            color = (stat.color if stat else None) or ent_def.visual.color

            result.append(EntityTypeDefinition(
                id=entity_id,
                name=ent_def.name or entity_id.title(),
                pluralName=ent_def.plural_name or (ent_def.name + "s"),
                description=ent_def.description or f"Entity type: {entity_id}",
                visual=EntityVisualSchema(
                    icon=icon,
                    color=color,
                    shape=ent_def.visual.shape,
                    size=ent_def.visual.size,
                    borderStyle=ent_def.visual.border_style,
                    showInMinimap=ent_def.visual.show_in_minimap,
                ),
                fields=[
                    FieldSchema(
                        id=f.id, name=f.name, type=f.type,
                        required=f.required,
                        showInNode=f.show_in_node, showInPanel=f.show_in_panel,
                        showInTooltip=f.show_in_tooltip, displayOrder=f.display_order,
                    )
                    for f in ent_def.fields
                ] or [
                    FieldSchema(id='name', name='Name', type='string', required=True,
                                showInNode=True, showInPanel=True, showInTooltip=True, displayOrder=1),
                ],
                hierarchy=EntityHierarchySchema(
                    level=ent_def.hierarchy.level,
                    canContain=ent_def.hierarchy.can_contain,
                    canBeContainedBy=ent_def.hierarchy.can_be_contained_by,
                    defaultExpanded=ent_def.hierarchy.default_expanded,
                ),
                behavior=EntityBehaviorSchema(
                    selectable=ent_def.behavior.selectable,
                    draggable=ent_def.behavior.draggable,
                    expandable=ent_def.behavior.expandable,
                    traceable=ent_def.behavior.traceable,
                    clickAction=ent_def.behavior.click_action,
                    doubleClickAction=ent_def.behavior.double_click_action,
                ),
            ))

        return result

    def _build_rel_types_from_resolved(self, stats, ontology, resolved) -> List[RelationshipTypeDefinition]:
        """Build RelationshipTypeDefinition list from rich resolved ontology definitions."""
        from ..ontology.models import RelationshipTypeDefEntry

        stat_map = {s.id: s for s in stats.edge_type_stats}
        containment_upper = {t.upper() for t in ontology.containment_edge_types}
        result: List[RelationshipTypeDefinition] = []
        seen_ids = set(stat_map.keys()) | set(resolved.relationship_type_definitions.keys())

        for rel_id in seen_ids:
            rel_def: Optional[RelationshipTypeDefEntry] = resolved.relationship_type_definitions.get(rel_id)
            stat = stat_map.get(rel_id)
            is_containment = rel_id.upper() in containment_upper

            if rel_def is None:
                rel_def = RelationshipTypeDefEntry(name=rel_id.title())
                rel_def.is_containment = is_containment

            result.append(RelationshipTypeDefinition(
                id=rel_id.lower(),
                name=rel_def.name or rel_id.title(),
                description=rel_def.description or f"Relationship type: {rel_id}",
                sourceTypes=(stat.source_types if stat else None) or rel_def.source_types,
                targetTypes=(stat.target_types if stat else None) or rel_def.target_types,
                visual=RelationshipVisualSchema(
                    strokeColor=rel_def.visual.stroke_color,
                    strokeWidth=rel_def.visual.stroke_width,
                    strokeStyle=rel_def.visual.stroke_style,
                    animated=rel_def.visual.animated,
                    animationSpeed=rel_def.visual.animation_speed,
                    arrowType=rel_def.visual.arrow_type,
                    curveType=rel_def.visual.curve_type,
                ),
                bidirectional=rel_def.bidirectional,
                showLabel=rel_def.show_label,
                isContainment=rel_def.is_containment,
            ))

        return result

    def _build_entity_types_from_dicts(self, stats, ontology, sys_ent) -> List[EntityTypeDefinition]:
        """Fallback: build entity types from defaults dict when no OntologyService is wired."""
        result: List[EntityTypeDefinition] = []
        for stat in stats.entity_type_stats:
            entity_id = stat.id
            ent_def = sys_ent.get(entity_id)
            icon = (stat.icon if stat.icon else None) or (ent_def.visual.icon if ent_def else "Box")
            color = (stat.color if stat.color else None) or (ent_def.visual.color if ent_def else "#6366f1")
            hierarchy_info = ontology.entity_type_hierarchy.get(entity_id, {})
            can_contain = hierarchy_info.get('canContain', []) if isinstance(hierarchy_info, dict) else []
            can_be_contained = hierarchy_info.get('canBeContainedBy', []) if isinstance(hierarchy_info, dict) else []
            level = ent_def.hierarchy.level if ent_def else 3

            result.append(EntityTypeDefinition(
                id=entity_id,
                name=stat.name,
                pluralName=f"{stat.name}s",
                description=f"Entity type: {stat.name}",
                visual=EntityVisualSchema(
                    icon=icon,
                    color=color,
                    shape=ent_def.visual.shape if ent_def else "rounded",
                    size=ent_def.visual.size if ent_def else "md",
                    borderStyle="solid",
                    showInMinimap=level <= 3,
                ),
                fields=[
                    FieldSchema(id='name', name='Name', type='string', required=True,
                                showInNode=True, showInPanel=True, showInTooltip=True, displayOrder=1),
                ],
                hierarchy=EntityHierarchySchema(
                    level=level, canContain=can_contain,
                    canBeContainedBy=can_be_contained, defaultExpanded=level <= 1,
                ),
                behavior=EntityBehaviorSchema(
                    selectable=True, draggable=level <= 3,
                    expandable=len(can_contain) > 0, traceable=True,
                    clickAction='select',
                    doubleClickAction='expand' if can_contain else 'panel',
                ),
            ))
        return result

    def _build_rel_types_from_dicts(self, stats, ontology, sys_rel) -> List[RelationshipTypeDefinition]:
        """Fallback: build relationship types from defaults dict when no OntologyService is wired."""
        result: List[RelationshipTypeDefinition] = []
        containment_upper = {t.upper() for t in ontology.containment_edge_types}
        for stat in stats.edge_type_stats:
            edge_id = stat.id
            rel_def = sys_rel.get(edge_id.upper()) or sys_rel.get(edge_id)
            is_containment = edge_id.upper() in containment_upper
            result.append(RelationshipTypeDefinition(
                id=edge_id.lower(),
                name=stat.name,
                description=f"Relationship type: {stat.name}",
                sourceTypes=stat.source_types,
                targetTypes=stat.target_types,
                visual=RelationshipVisualSchema(
                    strokeColor=rel_def.visual.stroke_color if rel_def else "#6366f1",
                    strokeWidth=rel_def.visual.stroke_width if rel_def else 2,
                    strokeStyle=rel_def.visual.stroke_style if rel_def else "solid",
                    animated=rel_def.visual.animated if rel_def else True,
                    animationSpeed="normal",
                    arrowType=rel_def.visual.arrow_type if rel_def else "arrow",
                    curveType="bezier",
                ),
                bidirectional=False,
                showLabel=rel_def.show_label if rel_def else False,
                isContainment=is_containment,
            ))
        return result

    async def get_aggregated_edges(self, request: AggregatedEdgeRequest) -> AggregatedEdgeResult:
        """
        Get aggregated edges between containers at a specified granularity.
        Delegates to provider for optimized Cypher execution.
        """
        # Load ontology metadata for edge classification
        ontology = await self.get_ontology_metadata()

        # Determine active lineage types
        if request.lineage_edge_types:
            lineage_types = request.lineage_edge_types
        else:
            # Default: use all known lineage types from ontology
            # If user passed include_edge_types (legacy), use that?
            if request.include_edge_types:
                lineage_types = [t.value if hasattr(t, "value") else str(t) for t in request.include_edge_types]
            else:
                lineage_types = ontology.lineage_edge_types

        # Determine containment types
        if request.containment_edge_types:
            containment_types = request.containment_edge_types
        else:
            containment_types = ontology.containment_edge_types

        return await self.provider.get_aggregated_edges_between(
            source_urns=request.source_urns,
            target_urns=request.target_urns,
            granularity=request.granularity,
            containment_edges=list(containment_types),
            lineage_edges=list(lineage_types)
        )

    async def create_node(self, request: CreateNodeRequest) -> CreateNodeResult:
        """
        Create a new node with optional automatic containment edge.
        Validates against ontology rules before creation.
        """
        import uuid
        from datetime import datetime
        
        # Generate URN
        urn = f"urn:nexus:{str(request.entity_type)}:{uuid.uuid4().hex[:12]}"
        
        # Validate parent relationship if specified
        containment_edge = None
        if request.parent_urn:
            # Get ontology to validate hierarchy
            ontology = await self.provider.get_ontology_metadata()
            
            # Get parent node to check its type
            parent_node = await self.provider.get_node(request.parent_urn)
            if not parent_node:
                return CreateNodeResult(
                    node=None,
                    containmentEdge=None,
                    success=False,
                    error=f"Parent node not found: {request.parent_urn}"
                )
            
            # Validate hierarchy rules
            parent_type = str(parent_node.entity_type)
            parent_hierarchy = ontology.entity_type_hierarchy.get(parent_type, {})
            can_contain = parent_hierarchy.get('canContain', []) if isinstance(parent_hierarchy, dict) else (parent_hierarchy.can_contain if hasattr(parent_hierarchy, 'can_contain') else [])
            
            if str(request.entity_type) not in can_contain and len(can_contain) > 0:
                return CreateNodeResult(
                    node=None,
                    containmentEdge=None,
                    success=False,
                    error=f"Entity type '{str(request.entity_type)}' cannot be contained by '{parent_type}'"
                )
            
            # Create containment edge
            containment_edge = GraphEdge(
                id=f"contains-{request.parent_urn}-{urn}",
                sourceUrn=request.parent_urn,
                targetUrn=urn,
                edgeType="CONTAINS",
                confidence=1.0,
                properties={}
            )
        
        # Create the node
        new_node = GraphNode(
            urn=urn,
            entityType=request.entity_type,
            displayName=request.display_name,
            qualifiedName=request.properties.get('qualifiedName', request.display_name),
            description=request.properties.get('description'),
            properties=request.properties,
            tags=request.tags,
            layerAssignment=request.properties.get('layerAssignment'),
            childCount=0,
            sourceSystem='manual',
            lastSyncedAt=datetime.utcnow().isoformat()
        )
        
        # Save to provider (if provider supports it)
        try:
            success = await self.provider.create_node(new_node, containment_edge)
            if not success:
                return CreateNodeResult(
                    node=None,
                    containmentEdge=None,
                    success=False,
                    error="Provider failed to create node"
                )
        except NotImplementedError:
            # Provider doesn't support creation - return the node anyway for optimistic UI
            logger.warning("Provider does not support node creation - returning optimistic result")
        except Exception as e:
            return CreateNodeResult(
                node=None,
                containmentEdge=None,
                success=False,
                error=str(e)
            )
        
        return CreateNodeResult(
            node=new_node,
            containmentEdge=containment_edge,
            success=True,
            error=None
        )

# Singleton instance - provider selected via GRAPH_PROVIDER env (mock | falkordb)
context_engine = ContextEngine(provider=_create_provider())
