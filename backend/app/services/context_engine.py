import logging
from typing import List, Dict, Any, Set, Optional, Tuple
from ..models.graph import (
    GraphNode, GraphEdge, LineageResult, EntityType, EdgeType, Granularity, NodeQuery, EdgeQuery
)
from ..providers.base import GraphDataProvider
from ..providers.mock_provider import MockGraphProvider

logger = logging.getLogger(__name__)

# Granularity mapping (mirrors frontend ENTITY_GRANULARITY)
ENTITY_GRANULARITY = {
    'column': Granularity.COLUMN,
    'schemaField': Granularity.COLUMN,
    'dataset': Granularity.TABLE,
    'asset': Granularity.TABLE,
    'table': Granularity.TABLE,
    'schema': Granularity.SCHEMA,
    'container': Granularity.SCHEMA, # Loose mapping
    'system': Granularity.SYSTEM,
    'dataPlatform': Granularity.SYSTEM,
    'app': Granularity.SYSTEM,
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
    def __init__(self, provider: GraphDataProvider = None):
        self.provider = provider or MockGraphProvider()

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        return await self.provider.get_node(urn)

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        return await self.provider.search_nodes(query, limit=limit, offset=offset)
    
    async def get_stats(self) -> Dict[str, Any]:
        return await self.provider.get_stats()
    
    async def get_children(self, urn: str, limit: int = 100) -> List[GraphNode]:
        return await self.provider.get_children(urn, limit=limit)

    async def get_edges(self, query: EdgeQuery = None) -> List[GraphEdge]:
        if query is None: query = EdgeQuery()
        return await self.provider.get_edges(query)

    async def get_neighborhood(self, urn: str) -> Dict[str, Any]:
        """Get the node and its immediate edges (incoming/outgoing)."""
        node = await self.get_node(urn)
        if not node: return None
        
        # Get incoming and outgoing edges
        incoming = await self.provider.get_edges(EdgeQuery(targetUrns=[urn]))
        outgoing = await self.provider.get_edges(EdgeQuery(sourceUrns=[urn]))
        
        all_edges = incoming + outgoing
        
        # Determine neighbor URNs to fetch their details
        neighbor_urns = set()
        for e in all_edges:
            neighbor_urns.add(e.source_urn)
            neighbor_urns.add(e.target_urn)
            
        neighbor_nodes = await self.provider.get_nodes(NodeQuery(urns=list(neighbor_urns)))
        
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
        aggregate_edges: bool = True
    ) -> LineageResult:
        """
        Get lineage and optionally aggregate it to a coarser granularity.
        """
        # Always fetch column lineage at the base to ensure we have data to roll up
        include_cols = True 
        
        result = await self.provider.get_full_lineage(
            urn, upstream_depth, downstream_depth, include_column_lineage=include_cols
        )
        
        if not aggregate_edges and granularity == Granularity.COLUMN:
            return result
            
        # Perform Server-Side Projection
        projected_result = self._project_graph(result, granularity, aggregate_edges)
        return projected_result

    def _project_graph(
        self, 
        result: LineageResult, 
        target_granularity: Granularity,
        aggregate_edges: bool
    ) -> LineageResult:
        nodes = result.nodes
        edges = result.edges
        
        # Build containment map
        containment_map = self._build_containment_map(nodes, edges)
        
        # Filter nodes to target granularity
        target_level = GRANULARITY_LEVELS.get(target_granularity, 0)
        
        visible_nodes = []
        visible_node_ids = set()
        
        for node in nodes:
            # Map entity type to granularity
            # Fallback to COLUMN if unknown
            node_gran = ENTITY_GRANULARITY.get(node.entity_type, Granularity.COLUMN)
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
                edges, nodes, containment_map, target_granularity
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
                        edgeType=EdgeType.AGGREGATED,
                        confidence=agg["confidence"],
                        properties={
                            "isAggregated": True,
                            "sourceEdgeCount": len(agg["sourceEdges"])
                        }
                    ))
        
        # Add original edges that are visible at this level
        # (e.g. Table->Table lineage if it exists natively)
        for edge in edges:
            if edge.source_urn in visible_node_ids and edge.target_urn in visible_node_ids:
                # Check if we already have an aggregated edge covering this?
                # Usually we prefer the aggregated one if it exists, or merge.
                # For simplicity, if we have aggregated edge, we might skip raw edge or let frontend handle.
                # But here we are the backend.
                
                # If it's a containment edge, keep it if it fits
                if edge.edge_type == EdgeType.CONTAINS:
                     visible_edges.append(edge)
                else:
                    # Generic lineage edge
                    # Check if covered by aggregation?
                    edge_key = f"{edge.source_urn}->{edge.target_urn}"
                    # Aggregated keys are strictly constructed. 
                    # If this edge is direct (Table A -> Table B), it stays.
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

    def _build_containment_map(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> Dict[str, str]:
        # child -> parent
        containment = {}
        for edge in edges:
            if edge.edge_type == EdgeType.CONTAINS or edge.properties.get("relationship") == "contains":
                containment[edge.target_urn] = edge.source_urn
        return containment

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
            if not node: return None
            
            node_gran = ENTITY_GRANULARITY.get(node.entity_type, Granularity.COLUMN)
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
        target_granularity: Granularity
    ) -> List[Dict[str, Any]]:
        
        aggregated_map = {} # key -> data
        
        for edge in edges:
            # Skip containment
            if edge.edge_type == EdgeType.CONTAINS:
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
        entity_types: Optional[List[EntityType]] = None,
        limit: int = 100, 
        offset: int = 0
    ) -> List[GraphNode]:
        return await self.provider.get_descendants(urn, depth=depth, entity_types=entity_types, limit=limit, offset=offset)

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return await self.provider.get_nodes_by_tag(tag, limit=limit, offset=offset)

    async def get_nodes_by_layer(self, layer_id: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        return await self.provider.get_nodes_by_layer(layer_id, limit=limit, offset=offset)

# Singleton instance
context_engine = ContextEngine()
