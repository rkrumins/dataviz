import asyncio
from typing import List, Optional, Dict, Any, Set
from collections import deque
from ..models.graph import (
    GraphNode, GraphEdge, NodeQuery, EdgeQuery, 
    GraphNode, GraphEdge, NodeQuery, EdgeQuery, 
    LineageResult, EntityType, EdgeType, GraphSchemaStats,
    PropertyFilter, TagFilter, TextFilter, FilterOperator,
    EntityTypeSummary, EdgeTypeSummary, TagSummary,
    OntologyMetadata, EdgeTypeMetadata, EntityTypeHierarchy,
    AggregatedEdgeResult, AggregatedEdgeInfo
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
        
        self._stats_cache = None
        
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

        # Invalidate stats cache
        self._stats_cache = None

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
        
        # Determine file paths
        current_dir = os.path.dirname(os.path.abspath(__file__))
        backend_dir = os.path.dirname(os.path.dirname(current_dir))
        lineage_file = os.path.join(backend_dir, "data", "demo_graph_with_lineage.json")
        custom_file = "custom_graph.json"
        
        nodes = None
        edges = None
        
        # 1. Check for column lineage data file first
        if os.path.exists(lineage_file):
            try:
                with open(lineage_file, "r") as f:
                    data = json.load(f)
                    
                # Reconstruct objects
                nodes = [GraphNode(**n) for n in data.get("nodes", [])]
                edges = [GraphEdge(**e) for e in data.get("edges", [])]
                
                print(f"Loaded {len(nodes)} nodes and {len(edges)} edges from {lineage_file}")
            except Exception as e:
                print(f"Error loading column lineage graph from {lineage_file}: {e}. Trying fallback.")
        
        # 2. Fall back to custom_graph.json if lineage file not found or failed
        if nodes is None and os.path.exists(custom_file):
            try:
                with open(custom_file, "r") as f:
                    data = json.load(f)
                    
                # Reconstruct objects
                nodes = [GraphNode(**n) for n in data.get("nodes", [])]
                edges = [GraphEdge(**e) for e in data.get("edges", [])]
                
                print(f"Loaded {len(nodes)} nodes and {len(edges)} edges from {custom_file}")
            except Exception as e:
                print(f"Error loading persisted graph from {custom_file}: {e}. Falling back to demo data.")
        
        # 3. Fall back to generating demo data
        if nodes is None:
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
            
            # Advanced Filters
            if query.property_filters and not self._match_property_filters(node, query.property_filters):
                continue
            
            if query.tag_filters and not self._match_tag_filters(node, query.tag_filters):
                continue
                
            if query.name_filter and not self._match_text_filter(node.display_name, query.name_filter):
                continue

            result.append(node)
            
        # Pagination
        start = query.offset or 0
        limit = query.limit or 100
        return result[start : start + limit]

    def _match_property_filters(self, node: GraphNode, filters: List[PropertyFilter]) -> bool:
        for f in filters:
            # Get value from properties or top-level attributes
            val = node.properties.get(f.field)
            if hasattr(node, f.field): # e.g. entityType, childCount
                val = getattr(node, f.field)
            
            if not self._match_operator(val, f.operator, f.value):
                return False
        return True

    def _match_operator(self, actual: Any, op: FilterOperator, target: Any) -> bool:
        if op == FilterOperator.EXISTS: return actual is not None
        if op == FilterOperator.NOT_EXISTS: return actual is None
        
        if actual is None: return False # simplistic handling
        
        # String comparison adjustments
        s_actual = str(actual).lower() if isinstance(actual, str) else actual
        s_target = str(target).lower() if isinstance(target, str) else target

        if op == FilterOperator.EQUALS: return actual == target
        if op == FilterOperator.CONTAINS: return str(target).lower() in str(actual).lower()
        if op == FilterOperator.STARTS_WITH: return str(actual).lower().startswith(str(target).lower())
        if op == FilterOperator.ENDS_WITH: return str(actual).lower().endswith(str(target).lower())
        
        # Numeric/Logic
        try:
            if op == FilterOperator.GT: return actual > target
            if op == FilterOperator.LT: return actual < target
        except: return False
        
        if op == FilterOperator.IN: return isinstance(target, list) and actual in target
        if op == FilterOperator.NOT_IN: return isinstance(target, list) and actual not in target
        
        return True

    def _match_tag_filters(self, node: GraphNode, filter: TagFilter) -> bool:
        node_tags = set(node.tags or [])
        target_tags = set(filter.tags)
        
        if filter.mode == 'any':
            return not node_tags.isdisjoint(target_tags)
        if filter.mode == 'all':
            return target_tags.issubset(node_tags)
        if filter.mode == 'none':
            return node_tags.isdisjoint(target_tags)
        return True

    def _match_text_filter(self, text: str, filter: TextFilter) -> bool:
        t = text if filter.case_sensitive else text.lower()
        q = filter.text if filter.case_sensitive else filter.text.lower()
        
        if filter.operator == 'equals': return t == q
        if filter.operator == 'contains': return q in t
        if filter.operator == 'startsWith': return t.startswith(q)
        if filter.operator == 'endsWith': return t.endswith(q)
        return True

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
            if query.edge_types:
                # Handle both EdgeType enum and string comparisons
                edge_type_value = edge.edge_type.value if hasattr(edge.edge_type, 'value') else str(edge.edge_type)
                query_types = [
                    t.value if hasattr(t, 'value') else str(t) 
                    for t in query.edge_types
                ]
                if edge_type_value not in query_types:
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
        
        # Default to CONTAINS if no edge types specified
        # This matches previous behavior but allows override
        target_edge_types = set(edge_types) if edge_types else {EdgeType.CONTAINS}
        
        edges = self._edges_by_source.get(parent_urn, [])
        children = []
        
        for edge in edges:
            # check edge type string vs enum or string
            # Ensure we handle both string and enum comparison safely
            etype = edge.edge_type.value if hasattr(edge.edge_type, 'value') else edge.edge_type
            
            # Simple check: if edge types were passed, does this match?
            # We treat everything as string for comparison to be safe
            is_match = False
            for t in target_edge_types:
                t_val = t.value if hasattr(t, 'value') else t
                if t_val == etype:
                    is_match = True
                    break
            
            if not is_match:
                continue
                
            node = self._nodes.get(edge.target_urn)
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
    def _get_containment_edge_types(self) -> Set[str]:
        """Derive containment edge types from config/env. Single source of truth."""
        import os
        config_containment = os.getenv('CONTAINMENT_EDGE_TYPES', '').strip()
        if config_containment:
            return {t.strip().upper() for t in config_containment.split(',') if t.strip()}
        # Default fallback — only used when no ontology config is provided
        return {EdgeType.CONTAINS.value, EdgeType.BELONGS_TO.value, EdgeType.PRODUCES.value}

    async def _traverse(
        self, 
        start_urn: str, 
        direction: str, 
        depth: int,
        descendant_types: Optional[List[EntityType]] = None
    ) -> Set[str]:
        visited = set()
        queue = deque([(start_urn, 0)])
        
        result_urns = set()
        
        # Derive containment types from ontology config — not hardcoded
        containment_types = self._get_containment_edge_types()
        
        # Prepare allowed types for fast lookup if provided
        allowed_types_set = None
        if descendant_types:
            allowed_types_set = {
                t.value if hasattr(t, 'value') else str(t) 
                for t in descendant_types
            }
        
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
                # Skip containment edges for lineage — driven by ontology config
                edge_type_val = edge.edge_type.value if hasattr(edge.edge_type, 'value') else str(edge.edge_type)
                if edge_type_val.upper() in containment_types:
                    continue
                    
                neighbor = edge.source_urn if direction == 'upstream' else edge.target_urn
                
                # Check semantic type filtering (Lazy Loading logic)
                if allowed_types_set:
                    neighbor_node = self._nodes.get(neighbor)
                    if neighbor_node:
                         ntype = neighbor_node.entity_type.value if hasattr(neighbor_node.entity_type, 'value') else str(neighbor_node.entity_type)
                         if ntype not in allowed_types_set:
                             continue
                
                if neighbor not in visited:
                    result_urns.add(neighbor)
                    queue.append((neighbor, current_depth + 1))
                    
        return result_urns

    async def get_upstream(
        self, 
        urn: str, 
        depth: int, 
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None
    ) -> LineageResult:
        upstream_urns = await self._traverse(urn, 'upstream', depth, descendant_types)
        
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

    async def get_downstream(
        self, 
        urn: str, 
        depth: int, 
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None
    ) -> LineageResult:
        downstream_urns = await self._traverse(urn, 'downstream', depth, descendant_types)
        
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

    async def get_full_lineage(
        self, 
        urn: str, 
        upstream_depth: int, 
        downstream_depth: int, 
        include_column_lineage: bool = False,
        descendant_types: Optional[List[EntityType]] = None
    ) -> LineageResult:
        upstream_urns = await self._traverse(urn, 'upstream', upstream_depth, descendant_types)
        downstream_urns = await self._traverse(urn, 'downstream', downstream_depth, descendant_types)
        
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
    
    async def get_aggregated_edges_between(
        self,
        source_urns: List[str],
        target_urns: Optional[List[str]],
        granularity: Any,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> AggregatedEdgeResult:
        """
        Mock implementation of aggregated edges.
        Does in-memory traversal to simulate Cypher aggregation.
        """
        # 1. Expand sources to granular descendants
        # We need a helper to find all descendants of a node
        
        # 2. Match lineage edges
        # 3. Aggregate back to top
        
        # PROTOTYPE: For now, just finding direct edges between sources/targets if they exist
        # Or simplistic aggregation if we have the data.
        
        # Since this is a Mock, and implementing full localized aggregation is complex,
        # we will implement a simplified version that returns edges if the nodes themselves are connected,
        # OR if we can easily find children.
        
        # Let's just return empty for now to satisfy the interface, 
        # unless we want to simulate the "Google Maps" feel.
        # To simulate it, we can just look at edges between the passed URNs?
        # No, that's not aggregation.
        
        # Helper: Get all descendants of a node 
        # (Naive implementation: just getting direct children for 1 level deep)
        
        aggregated = []
        total = 0
        
        # For the mock, we will cheat and just look for direct edges between the requested URNs
        # OR edges between their direct children.
        
        sources = set(source_urns)
        targets = set(target_urns) if target_urns else set(self._nodes.keys())
        
        # Basic O(N^2) check on edges - ok for small mock data
        for edge in self._edges.values():
             et = edge.edge_type.value if hasattr(edge.edge_type, 'value') else str(edge.edge_type)
             if et in containment_edges: continue
             if lineage_edges and et not in lineage_edges: continue
             
             s_parent = self._find_ancestor_in_set(edge.source_urn, sources)
             t_parent = self._find_ancestor_in_set(edge.target_urn, targets)
             
             if s_parent and t_parent and s_parent != t_parent:
                 # Found a granular match!
                 key = f"{s_parent}->{t_parent}"
                 
                 # Aggregate
                 existing = next((a for a in aggregated if a.id == f"agg-{key}"), None)
                 if existing:
                     existing.edge_count += 1
                     if et not in existing.edge_types: existing.edge_types.append(et)
                     existing.source_edge_ids.append(edge.id)
                 else:
                     aggregated.append(AggregatedEdgeInfo(
                         id=f"agg-{key}",
                         sourceUrn=s_parent,
                         targetUrn=t_parent,
                         edgeCount=1,
                         edgeTypes=[et],
                         confidence=edge.confidence or 1.0,
                         sourceEdgeIds=[edge.id]
                     ))
                     
                 total += 1
                 
        return AggregatedEdgeResult(
            aggregatedEdges=aggregated,
            totalSourceEdges=total
        )

    def _find_ancestor_in_set(self, urn: str, candidates: Set[str]) -> Optional[str]:
        """Simple helper to check if urn or its parent is in the candidate set"""
        if urn in candidates: return urn
        
        # Check up to 3 levels?
        curr = urn
        for _ in range(3):
            parent = self._parent_map.get(curr)
            if not parent: break
            if parent in candidates: return parent
            curr = parent
        return None

    async def get_trace_lineage(
        self,
        urn: str,
        direction: str,
        depth: int,
        containment_edges: List[str],
        lineage_edges: List[str],
    ) -> LineageResult:
        """
        Mock implementation of trace lineage with proper context awareness.
        1. Reuse get_full_lineage to get lineage nodes/edges.
        2. Traverse UP diagram (Step 4) to include structural context (parents).
        """
        # Map direction to depths
        up_depth = depth if direction in ['upstream', 'both'] else 0
        down_depth = depth if direction in ['downstream', 'both'] else 0
        
        # 1. Get base lineage
        result = await self.get_full_lineage(urn, up_depth, down_depth, include_column_lineage=True)
        
        nodes = list(result.nodes)
        edges = list(result.edges)
        
        # Optimized lookup
        node_map = {n.urn: n for n in nodes}
        edge_map = {e.id: e for e in edges}
        
        # 2. Structural Context (Upward Traversal)
        # For every node in the lineage, we must find its containers recursively
        queue = deque([n.urn for n in nodes])
        visited = set(node_map.keys())
        
        while queue:
            curr_urn = queue.popleft()
            
            # Find parent (Mock uses internal parent map)
            parent_urn = self._parent_map.get(curr_urn)
            if parent_urn:
                # Add parent node
                parent_node = self._nodes.get(parent_urn)
                if parent_node:
                    if parent_urn not in node_map:
                        node_map[parent_urn] = parent_node
                        queue.append(parent_urn) # Continue up
                    
                    # Find containment edge (Parent -> Child)
                    if parent_urn in self._edges_by_source:
                         for e in self._edges_by_source[parent_urn]:
                             if e.target_urn == curr_urn:
                                 # This is the containment edge
                                 if e.id not in edge_map:
                                     edge_map[e.id] = e
                                 break
        
        return LineageResult(
            nodes=list(node_map.values()),
            edges=list(edge_map.values()),
            upstreamUrns=result.upstream_urns,
            downstreamUrns=result.downstream_urns,
            totalCount=len(node_map),
            hasMore=False
        )

    async def get_stats(self) -> Dict[str, Any]:
        # Return cached stats if available
        if self._stats_cache:
            return self._stats_cache

        # Calculate and cache
        type_counts = {}
        for node in self._nodes.values():
            t = node.entity_type
            type_counts[t] = type_counts.get(t, 0) + 1
            
        edge_type_counts = {}
        for edge in self._edges.values():
            t = edge.edge_type
            edge_type_counts[t] = edge_type_counts.get(t, 0) + 1
            
        self._stats_cache = {
            "nodeCount": len(self._nodes),
            "edgeCount": len(self._edges),
            "entityTypeCounts": type_counts,
            "edgeTypeCounts": edge_type_counts
        }
        return self._stats_cache

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

    async def get_schema_stats(self) -> GraphSchemaStats:
        # Entity Type Stats
        type_counts = {}
        samples = {} # type -> list of names
        for node in self._nodes.values():
            t = node.entity_type.value if hasattr(node.entity_type, 'value') else node.entity_type
            type_counts[t] = type_counts.get(t, 0) + 1
            if t not in samples: samples[t] = []
            if len(samples[t]) < 3: samples[t].append(node.display_name)
            
        entity_stats = [
            EntityTypeSummary(
                id=t, name=t, count=c, sampleNames=samples[t]
            ) for t, c in type_counts.items()
        ]
        
        # Edge Type Stats
        edge_counts = {}
        for edge in self._edges.values():
            t = edge.edge_type.value if hasattr(edge.edge_type, 'value') else edge.edge_type
            edge_counts[t] = edge_counts.get(t, 0) + 1
            
        edge_stats = [
            EdgeTypeSummary(id=t, name=t, count=c) for t, c in edge_counts.items()
        ]
        
        # Tag Stats
        tag_counts = {} # tag -> count
        tag_types = {} # tag -> set(types)
        for node in self._nodes.values():
            for tag in node.tags:
                tag_counts[tag] = tag_counts.get(tag, 0) + 1
                if tag not in tag_types: tag_types[tag] = set()
                t = node.entity_type.value if hasattr(node.entity_type, 'value') else node.entity_type
                tag_types[tag].add(t)
                
        tag_stats = [
            TagSummary(tag=t, count=c, entityTypes=list(tag_types[t])) 
            for t, c in tag_counts.items()
        ]
        
        return GraphSchemaStats(
            totalNodes=len(self._nodes),
            totalEdges=len(self._edges),
            entityTypeStats=entity_stats,
            edgeTypeStats=edge_stats,
            tagStats=tag_stats
        )

    async def get_ontology_metadata(self) -> OntologyMetadata:
        """Get ontology metadata including containment edge types, lineage edge types, and entity hierarchies."""
        import os
        
        # 1. Get containment edge types from config/env or use defaults
        containment_types = list(self._get_containment_edge_types())
        
        # 2. Get lineage edge types from config/env or derive from graph
        config_lineage = os.getenv('LINEAGE_EDGE_TYPES', '').strip()
        if config_lineage:
            lineage_types = [t.strip() for t in config_lineage.split(',') if t.strip()]
        else:
            # Derive: any edge type that is NOT containment and NOT metadata is lineage
            # Metadata types are explicitly excluded (e.g. TAGGED_WITH)
            config_metadata = os.getenv('METADATA_EDGE_TYPES', '').strip()
            metadata_types = set()
            if config_metadata:
                metadata_types = {t.strip().upper() for t in config_metadata.split(',') if t.strip()}
            else:
                metadata_types = {EdgeType.TAGGED_WITH.value}
            
            containment_upper = {t.upper() for t in containment_types}
            lineage_types = []
            for edge in self._edges.values():
                et = edge.edge_type.value if hasattr(edge.edge_type, 'value') else str(edge.edge_type)
                if et.upper() not in containment_upper and et.upper() not in metadata_types and et.upper() != EdgeType.AGGREGATED.value:
                    if et not in lineage_types:
                        lineage_types.append(et)
        
        # 3. Build edge type metadata with full classification
        edge_type_metadata: Dict[str, EdgeTypeMetadata] = {}
        containment_upper = {t.upper() for t in containment_types}
        lineage_upper = {t.upper() for t in lineage_types}
        
        # Analyze edges to determine metadata
        edge_type_counts: Dict[str, int] = {}
        edge_type_source_types: Dict[str, Set[str]] = {}
        edge_type_target_types: Dict[str, Set[str]] = {}
        
        for edge in self._edges.values():
            edge_type = edge.edge_type.value if hasattr(edge.edge_type, 'value') else str(edge.edge_type)
            edge_type_counts[edge_type] = edge_type_counts.get(edge_type, 0) + 1
            
            # Get source and target entity types
            source_node = self._nodes.get(edge.source_urn)
            target_node = self._nodes.get(edge.target_urn)
            
            if source_node:
                source_type = source_node.entity_type.value if hasattr(source_node.entity_type, 'value') else str(source_node.entity_type)
                if edge_type not in edge_type_source_types:
                    edge_type_source_types[edge_type] = set()
                edge_type_source_types[edge_type].add(source_type)
            
            if target_node:
                target_type = target_node.entity_type.value if hasattr(target_node.entity_type, 'value') else str(target_node.entity_type)
                if edge_type not in edge_type_target_types:
                    edge_type_target_types[edge_type] = set()
                edge_type_target_types[edge_type].add(target_type)
        
        # Create metadata for each edge type — fully ontology-driven classification
        for edge_type in edge_type_counts.keys():
            is_containment = edge_type.upper() in containment_upper
            is_lineage = edge_type.upper() in lineage_upper
            
            # Determine category
            if is_containment:
                category = 'structural'
            elif is_lineage:
                category = 'flow'
            elif edge_type.upper() == EdgeType.TAGGED_WITH.value:
                category = 'metadata'
            else:
                category = 'association'
            
            # Determine direction from category
            if is_containment:
                # Check direction hint from edge type metadata
                direction = 'parent-to-child'  # Default for containment
                # Reverse containment types (like BELONGS_TO) go child-to-parent
                if edge_type.upper() == EdgeType.BELONGS_TO.value:
                    direction = 'child-to-parent'
                description = f'Containment relationship: {edge_type}'
            elif is_lineage:
                direction = 'source-to-target'
                description = f'Lineage/flow relationship: {edge_type}'
            else:
                direction = 'bidirectional'
                description = f'{category.capitalize()} relationship: {edge_type}'
            
            edge_type_metadata[edge_type] = EdgeTypeMetadata(
                isContainment=is_containment,
                isLineage=is_lineage,
                direction=direction,
                category=category,
                description=description
            )
        
        # 4. Build entity type hierarchy
        entity_type_hierarchy: Dict[str, EntityTypeHierarchy] = {}
        
        # Analyze containment edges to determine what can contain what
        for edge in self._edges.values():
            edge_type = edge.edge_type.value if hasattr(edge.edge_type, 'value') else str(edge.edge_type)
            
            if edge_type.upper() not in containment_upper:
                continue
            
            source_node = self._nodes.get(edge.source_urn)
            target_node = self._nodes.get(edge.target_urn)
            
            if not source_node or not target_node:
                continue
            
            source_type = source_node.entity_type.value if hasattr(source_node.entity_type, 'value') else str(source_node.entity_type)
            target_type = target_node.entity_type.value if hasattr(target_node.entity_type, 'value') else str(target_node.entity_type)
            
            # Determine parent and child by checking edge direction from metadata
            edge_meta = edge_type_metadata.get(edge_type)
            if edge_meta and edge_meta.direction == 'child-to-parent':
                parent_type = target_type
                child_type = source_type
            else:
                # Default: source is parent (parent-to-child direction)
                parent_type = source_type
                child_type = target_type
            
            # Update hierarchy
            if parent_type not in entity_type_hierarchy:
                entity_type_hierarchy[parent_type] = EntityTypeHierarchy(
                    canContain=[],
                    canBeContainedBy=[]
                )
            if child_type not in entity_type_hierarchy:
                entity_type_hierarchy[child_type] = EntityTypeHierarchy(
                    canContain=[],
                    canBeContainedBy=[]
                )
            
            # Add relationships
            if child_type not in entity_type_hierarchy[parent_type].can_contain:
                entity_type_hierarchy[parent_type].can_contain.append(child_type)
            if parent_type not in entity_type_hierarchy[child_type].can_be_contained_by:
                entity_type_hierarchy[child_type].can_be_contained_by.append(parent_type)
        
        # 5. Identify Root Entity Types
        # Types that appear in hierarchy but never as a child (target of containment edge)
        all_hierarchy_types = set(entity_type_hierarchy.keys())
        contained_types = set()
        for parent_type, hierarchy in entity_type_hierarchy.items():
            for child_type in hierarchy.can_contain:
                contained_types.add(child_type)
        
        root_entity_types = list(all_hierarchy_types - contained_types)
        
        return OntologyMetadata(
            containmentEdgeTypes=containment_types,
            lineageEdgeTypes=lineage_types,
            edgeTypeMetadata=edge_type_metadata,
            entityTypeHierarchy=entity_type_hierarchy,
            rootEntityTypes=root_entity_types
        )

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

    async def create_node(self, node: GraphNode, containment_edge: Optional[GraphEdge] = None) -> bool:
        """Create a new node with optional containment edge."""
        try:
            # Add node to store
            self._nodes[node.urn] = node
            
            # Add containment edge if provided
            if containment_edge:
                self._edges[containment_edge.id] = containment_edge
                
                # Update indexes
                if containment_edge.source_urn not in self._edges_by_source:
                    self._edges_by_source[containment_edge.source_urn] = []
                self._edges_by_source[containment_edge.source_urn].append(containment_edge)
                
                if containment_edge.target_urn not in self._edges_by_target:
                    self._edges_by_target[containment_edge.target_urn] = []
                self._edges_by_target[containment_edge.target_urn].append(containment_edge)
                
                # Update containment indexes
                if containment_edge.edge_type == EdgeType.CONTAINS:
                    if containment_edge.source_urn not in self._children_map:
                        self._children_map[containment_edge.source_urn] = []
                    self._children_map[containment_edge.source_urn].append(containment_edge.target_urn)
                    self._parent_map[containment_edge.target_urn] = containment_edge.source_urn
                    
                    # Update parent's child count
                    parent = self._nodes.get(containment_edge.source_urn)
                    if parent:
                        parent.child_count = (parent.child_count or 0) + 1
            
            # Invalidate stats cache
            self._stats_cache = None
            
            return True
        except Exception as e:
            print(f"Error creating node: {e}")
            return False

    def _paginate(self, items: List[Any], offset: int, limit: int) -> List[Any]:
        return items[offset : offset + limit]

