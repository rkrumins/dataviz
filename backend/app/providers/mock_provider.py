import asyncio
from typing import List, Optional, Dict, Any, Set
from collections import deque
from ..models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery, 
    LineageResult, EntityType, EdgeType
)
from .base import GraphDataProvider
from ..core.demo_data import generate_demo_data

class MockGraphProvider(GraphDataProvider):
    def __init__(self):
        self._nodes: Dict[str, GraphNode] = {}
        self._edges: Dict[str, GraphEdge] = {}
        
        # Indexes for faster lookup
        self._edges_by_source: Dict[str, List[GraphEdge]] = {}
        self._edges_by_target: Dict[str, List[GraphEdge]] = {}
        self._children_map: Dict[str, List[str]] = {} # parent_urn -> list[child_urn]
        self._parent_map: Dict[str, str] = {} # child_urn -> parent_urn
        
        self._initialize_data()

    def _paginate(self, items: List[Any], offset: int, limit: int) -> List[Any]:
        return items[offset : offset + limit]

    async def save_custom_graph(self, nodes: List[GraphNode], edges: List[GraphEdge]) -> bool:
        """
        Updates the in-memory graph with the provided nodes and edges.
        Also persists to a local JSON file for "proper" persistence across restarts.
        """
        import json
        import os

        # 1. Update In-Memory
        # We can choose to replace everything or merge. 
        # For a "Save" action from a canvas, usually we expect the canvas state to be the source of truth,
        # but we also want to keep the existing "demo" data if it wasn't deleted.
        # However, the user asked for "manual build". 
        # Let's simple merge/upsert for now.
        
        for node in nodes:
            self._nodes[node.urn] = node
        
        for edge in edges:
            self._edges[edge.id] = edge
            # Re-index
            if edge.source_urn not in self._edges_by_source:
                self._edges_by_source[edge.source_urn] = []
            self._edges_by_source[edge.source_urn].append(edge)
            
            if edge.target_urn not in self._edges_by_target:
                self._edges_by_target[edge.target_urn] = []
            self._edges_by_target[edge.target_urn].append(edge)

        # 2. Persist to Disk
        data = {
            "nodes": [n.dict() for n in self._nodes.values()],
            "edges": [e.dict() for e in self._edges.values()]
        }
        
        try:
            with open("custom_graph.json", "w") as f:
                json.dump(data, f, default=str) # handle datetimes if any
            return True
        except Exception as e:
            print(f"Error saving graph: {e}")
            return False

    def _initialize_data(self):
        import random
        import json
        import os
        from ..models.graph import GraphNode, GraphEdge # Ensure imports

        random.seed(42)
        
        # 1. Check for persisted data first
        if os.path.exists("custom_graph.json"):
            try:
                with open("custom_graph.json", "r") as f:
                    data = json.load(f)
                    
                # Reconstruct objects
                nodes = [GraphNode(**n) for n in data.get("nodes", [])]
                edges = [GraphEdge(**e) for e in data.get("edges", [])]
                
                print(f"Loaded {len(nodes)} nodes and {len(edges)} edges from persistence.")
            except Exception as e:
                print(f"Error loading persisted graph: {e}. Falling back to demo data.")
                nodes, edges = generate_demo_data()
        else:
            nodes, edges = generate_demo_data()
        
        for node in nodes:
            self._nodes[node.urn] = node
            
        for edge in edges:
            self._edges[edge.id] = edge
            
            # Index edges
            if edge.source_urn not in self._edges_by_source:
                self._edges_by_source[edge.source_urn] = []
            self._edges_by_source[edge.source_urn].append(edge)
            
            if edge.target_urn not in self._edges_by_target:
                self._edges_by_target[edge.target_urn] = []
            self._edges_by_target[edge.target_urn].append(edge)
            
            # Index containment
            if edge.edge_type == EdgeType.CONTAINS:
                if edge.source_urn not in self._children_map:
                    self._children_map[edge.source_urn] = []
                self._children_map[edge.source_urn].append(edge.target_urn)
                self._parent_map[edge.target_urn] = edge.source_urn

    @property
    def name(self) -> str:
        return "MockGraphProvider"

    async def get_node(self, urn: str) -> Optional[GraphNode]:
        # Simulate network delay
        # await asyncio.sleep(0.01)
        return self._nodes.get(urn)

    async def get_nodes(self, query: NodeQuery) -> List[GraphNode]:
        result = []
        for node in self._nodes.values():
            if query.urns and node.urn not in query.urns:
                continue
            if query.entity_types and node.entity_type not in query.entity_types:
                continue
            if query.tags:
                if not any(tag in node.tags for tag in query.tags):
                   continue
            if query.search_query:
                # Basic case-insensitive partial match
                term = query.search_query.lower()
                if term not in node.display_name.lower() and term not in node.urn.lower():
                    continue
            
            result.append(node)
            
        # Pagination
        start = query.offset or 0
        limit = query.limit or 100
        return result[start : start + limit]

    async def search_nodes(self, query: str, limit: int = 10, offset: int = 0) -> List[GraphNode]:
        q = NodeQuery(search_query=query, limit=limit, offset=offset)
        return await self.get_nodes(q)

    async def get_edges(self, query: EdgeQuery) -> List[GraphEdge]:
        result = []
        for edge in self._edges.values():
            if query.source_urns and edge.source_urn not in query.source_urns:
                continue
            if query.target_urns and edge.target_urn not in query.target_urns:
                continue
            if query.any_urns:
                 if edge.source_urn not in query.any_urns and edge.target_urn not in query.any_urns:
                     continue
            if query.edge_types and edge.edge_type not in query.edge_types:
                continue
            
            result.append(edge)
            
        start = query.offset or 0
        limit = query.limit or 100
        return result[start : start + limit]

    async def get_children(
        self, 
        parent_urn: str, 
        entity_types: Optional[List[EntityType]] = None,
        edge_types: Optional[List[str]] = None,
        offset: int = 0, 
        limit: int = 100
    ) -> List[GraphNode]:
        
        child_urns = self._children_map.get(parent_urn, [])
        children = []
        
        for urn in child_urns:
            node = self._nodes.get(urn)
            if node:
                if entity_types and node.entity_type not in entity_types:
                    continue
                children.append(node)
                
        # Sort by display name for consistency
        children.sort(key=lambda x: x.display_name)
        
        return children[offset : offset + limit]

    async def get_parent(self, child_urn: str) -> Optional[GraphNode]:
        parent_urn = self._parent_map.get(child_urn)
        if parent_urn:
            return self._nodes.get(parent_urn)
        return None

    # Lineage Helper
    async def _traverse(
        self, 
        start_urn: str, 
        direction: str, 
        depth: int
    ) -> Set[str]:
        visited = set()
        queue = deque([(start_urn, 0)])
        
        result_urns = set()
        
        while queue:
            current_urn, current_depth = queue.popleft()
            
            if current_depth >= depth:
                continue
                
            visited.add(current_urn)
            
            edges = []
            if direction == 'upstream':
                # Look for edges where current is target (source -> current)
                edges = self._edges_by_target.get(current_urn, [])
            elif direction == 'downstream':
                 # Look for edges where current is source (current -> target)
                edges = self._edges_by_source.get(current_urn, [])
                
            for edge in edges:
                # Skip containment edges for lineage
                if edge.edge_type == EdgeType.CONTAINS:
                    continue
                    
                neighbor = edge.source_urn if direction == 'upstream' else edge.target_urn
                
                if neighbor not in visited:
                    result_urns.add(neighbor)
                    queue.append((neighbor, current_depth + 1))
                    
        return result_urns

    async def get_upstream(self, urn: str, depth: int, include_column_lineage: bool = False) -> LineageResult:
        upstream_urns = await self._traverse(urn, 'upstream', depth)
        
        nodes = [self._nodes[u] for u in upstream_urns if u in self._nodes]
        # Include source node? Usually yes for graph response
        if urn in self._nodes:
            nodes.append(self._nodes[urn])
            
        # Collect edges between these nodes
        node_ids = set(n.urn for n in nodes)
        edges = [e for e in self._edges.values() 
                 if e.source_urn in node_ids and e.target_urn in node_ids]

        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=upstream_urns,
            downstreamUrns=set(),
            totalCount=len(nodes),
            hasMore=False
        )

    async def get_downstream(self, urn: str, depth: int, include_column_lineage: bool = False) -> LineageResult:
        downstream_urns = await self._traverse(urn, 'downstream', depth)
        
        nodes = [self._nodes[u] for u in downstream_urns if u in self._nodes]
        if urn in self._nodes:
            nodes.append(self._nodes[urn])
            
        node_ids = set(n.urn for n in nodes)
        edges = [e for e in self._edges.values() 
                 if e.source_urn in node_ids and e.target_urn in node_ids]

        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=set(),
            downstreamUrns=downstream_urns,
            totalCount=len(nodes),
            hasMore=False
        )

    async def get_full_lineage(self, urn: str, upstream_depth: int, downstream_depth: int, include_column_lineage: bool = False) -> LineageResult:
        upstream_urns = await self._traverse(urn, 'upstream', upstream_depth)
        downstream_urns = await self._traverse(urn, 'downstream', downstream_depth)
        
        all_urns = upstream_urns.union(downstream_urns)
        all_urns.add(urn)
        
        nodes = [self._nodes[u] for u in all_urns if u in self._nodes]
        node_ids = set(n.urn for n in nodes)
        edges = [e for e in self._edges.values() 
                 if e.source_urn in node_ids and e.target_urn in node_ids]
                 
        return LineageResult(
            nodes=nodes,
            edges=edges,
            upstreamUrns=upstream_urns,
            downstreamUrns=downstream_urns,
            totalCount=len(nodes),
            hasMore=False
        )

    async def get_stats(self) -> Dict[str, Any]:
        type_counts = {}
        for node in self._nodes.values():
            t = node.entity_type
            type_counts[t] = type_counts.get(t, 0) + 1
            
        edge_type_counts = {}
        for edge in self._edges.values():
            t = edge.edge_type
            edge_type_counts[t] = edge_type_counts.get(t, 0) + 1
            
        return {
            "nodeCount": len(self._nodes),
            "edgeCount": len(self._edges),
            "entityTypeCounts": type_counts,
            "edgeTypeCounts": edge_type_counts
        }

    async def get_distinct_values(self, property_name: str) -> List[Any]:
        values = set()
        for node in self._nodes.values():
            if property_name == 'entityType':
                values.add(node.entity_type)
            elif property_name in node.properties:
                v = node.properties[property_name]
                if isinstance(v, list):
                    for i in v: values.add(i)
                else:
                    values.add(v)
            elif property_name == 'tags':
                for t in node.tags:
                    values.add(t)
        return list(values)

    # ==========================================
    # Traversal & Filtering Extensions
    # ==========================================

    async def get_ancestors(self, urn: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        """Get all ancestors up to root (Containment)."""
        ancestors = []
        current = urn
        while current in self._parent_map:
            parent_urn = self._parent_map[current]
            parent_node = self._nodes.get(parent_urn)
            if parent_node:
                ancestors.append(parent_node)
            current = parent_urn
        
        # Pagination on the result list
        return self._paginate(ancestors, offset, limit)

    async def get_descendants(
        self, 
        urn: str, 
        depth: int = 5, 
        entity_types: Optional[List[EntityType]] = None,
        limit: int = 100, 
        offset: int = 0
    ) -> List[GraphNode]:
        """Get all descendants (Containment). Uses BFS."""
        descendants = []
        queue = deque([(urn, 0)])
        
        while queue:
            current_urn, current_depth = queue.popleft()
            if current_depth >= depth:
                continue
                
            children = self._children_map.get(current_urn, [])
            for child_urn in children:
                child_node = self._nodes.get(child_urn)
                if child_node:
                    if not entity_types or child_node.entity_type in entity_types:
                        descendants.append(child_node)
                    # Continue traversing even if type doesn't match? 
                    # Usually yes, unless we stop at certain types. 
                    # For simple "get all descendants", we traverse all.
                    queue.append((child_urn, current_depth + 1))
        
        return self._paginate(descendants, offset, limit)

    async def get_nodes_by_tag(self, tag: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        matches = [n for n in self._nodes.values() if tag in n.tags]
        return self._paginate(matches, offset, limit)

    async def get_nodes_by_layer(self, layer_id: str, limit: int = 100, offset: int = 0) -> List[GraphNode]:
        # Mock logic: assume there's a property "layerAssignment" or similar
        # Since we don't have explicit layer logic in mock yet, we'll check props/tags
        matches = [n for n in self._nodes.values() if n.layer_assignment == layer_id]
        return self._paginate(matches, offset, limit)

    def _paginate(self, items: List[Any], offset: int, limit: int) -> List[Any]:
        return items[offset : offset + limit]

