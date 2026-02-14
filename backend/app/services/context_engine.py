import logging
from typing import List, Dict, Any, Set, Optional, Tuple
from ..models.graph import (
    GraphNode, GraphEdge, LineageResult, EntityType, EdgeType, Granularity, NodeQuery, EdgeQuery, GraphSchemaStats, OntologyMetadata,
    GraphSchema, EntityTypeDefinition, RelationshipTypeDefinition, EntityVisualSchema, EntityHierarchySchema, EntityBehaviorSchema,
    RelationshipVisualSchema, FieldSchema, AggregatedEdgeRequest, AggregatedEdgeResult, AggregatedEdgeInfo,
    CreateNodeRequest, CreateNodeResult
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

    async def get_schema_stats(self) -> GraphSchemaStats:
        return await self.provider.get_schema_stats()
    
    async def get_ontology_metadata(self) -> OntologyMetadata:
        return await self.provider.get_ontology_metadata()
    
    async def get_children(self, urn: str, edge_types: Optional[List[str]] = None, limit: int = 100) -> List[GraphNode]:
        return await self.provider.get_children(urn, entity_types=None, edge_types=edge_types, limit=limit)

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

    async def get_graph_schema(self) -> GraphSchema:
        """
        Build a complete graph schema from introspection data and ontology metadata.
        This enables frontend to load schema dynamically from the backend.
        """
        # Get introspection stats and ontology
        stats = await self.provider.get_schema_stats()
        ontology = await self.provider.get_ontology_metadata()
        
        # Build entity type definitions from introspection
        entity_types: List[EntityTypeDefinition] = []
        
        # Default visual configurations by entity type
        ENTITY_VISUALS = {
            'domain': {'icon': 'FolderTree', 'color': '#8b5cf6', 'shape': 'rounded', 'size': 'lg'},
            'system': {'icon': 'Database', 'color': '#06b6d4', 'shape': 'rounded', 'size': 'md'},
            'dataPlatform': {'icon': 'Server', 'color': '#06b6d4', 'shape': 'rounded', 'size': 'md'},
            'container': {'icon': 'Box', 'color': '#10b981', 'shape': 'rounded', 'size': 'md'},
            'schema': {'icon': 'Layers', 'color': '#10b981', 'shape': 'rounded', 'size': 'md'},
            'dataset': {'icon': 'Table2', 'color': '#22c55e', 'shape': 'rectangle', 'size': 'sm'},
            'schemaField': {'icon': 'Columns3', 'color': '#f59e0b', 'shape': 'rectangle', 'size': 'xs'},
            'column': {'icon': 'Columns3', 'color': '#f59e0b', 'shape': 'rectangle', 'size': 'xs'},
            'dataJob': {'icon': 'Workflow', 'color': '#ec4899', 'shape': 'diamond', 'size': 'md'},
            'dataFlow': {'icon': 'GitBranch', 'color': '#ec4899', 'shape': 'diamond', 'size': 'md'},
            'pipeline': {'icon': 'Workflow', 'color': '#ec4899', 'shape': 'diamond', 'size': 'md'},
            'dashboard': {'icon': 'LayoutDashboard', 'color': '#3b82f6', 'shape': 'rounded', 'size': 'md'},
            'chart': {'icon': 'BarChart3', 'color': '#3b82f6', 'shape': 'rounded', 'size': 'sm'},
            'report': {'icon': 'FileText', 'color': '#22c55e', 'shape': 'rounded', 'size': 'md'},
            'glossaryTerm': {'icon': 'BookOpen', 'color': '#a855f7', 'shape': 'rounded', 'size': 'sm'},
            'tag': {'icon': 'Tag', 'color': '#64748b', 'shape': 'rounded', 'size': 'xs'},
            'app': {'icon': 'AppWindow', 'color': '#06b6d4', 'shape': 'rounded', 'size': 'md'},
        }
        
        # Hierarchy levels
        ENTITY_LEVELS = {
            'domain': 0, 'system': 1, 'dataPlatform': 1, 'app': 1,
            'container': 2, 'schema': 2, 'dataFlow': 2, 'pipeline': 2,
            'dataset': 3, 'dashboard': 3, 'dataJob': 3, 'report': 3,
            'schemaField': 4, 'column': 4, 'chart': 4,
            'glossaryTerm': 5, 'tag': 5
        }
        
        for stat in stats.entity_type_stats:
            entity_id = stat.id
            visuals = ENTITY_VISUALS.get(entity_id, {'icon': 'Box', 'color': '#6366f1', 'shape': 'rounded', 'size': 'md'})
            
            # Get hierarchy info from ontology
            hierarchy_info = ontology.entity_type_hierarchy.get(entity_id, {})
            can_contain = hierarchy_info.get('canContain', []) if isinstance(hierarchy_info, dict) else (hierarchy_info.can_contain if hasattr(hierarchy_info, 'can_contain') else [])
            can_be_contained = hierarchy_info.get('canBeContainedBy', []) if isinstance(hierarchy_info, dict) else (hierarchy_info.can_be_contained_by if hasattr(hierarchy_info, 'can_be_contained_by') else [])
            
            entity_def = EntityTypeDefinition(
                id=entity_id,
                name=stat.name,
                pluralName=f"{stat.name}s",
                description=f"Entity type: {stat.name}",
                visual=EntityVisualSchema(
                    icon=stat.icon or visuals.get('icon', 'Box'),
                    color=stat.color or visuals.get('color', '#6366f1'),
                    shape=visuals.get('shape', 'rounded'),
                    size=visuals.get('size', 'md'),
                    borderStyle='solid',
                    showInMinimap=ENTITY_LEVELS.get(entity_id, 3) <= 3
                ),
                fields=[
                    FieldSchema(id='name', name='Name', type='string', required=True, showInNode=True, showInPanel=True, showInTooltip=True, displayOrder=1),
                    FieldSchema(id='description', name='Description', type='markdown', required=False, showInNode=False, showInPanel=True, showInTooltip=False, displayOrder=2),
                    FieldSchema(id='urn', name='URN', type='urn', required=False, showInNode=False, showInPanel=True, showInTooltip=False, displayOrder=10),
                ],
                hierarchy=EntityHierarchySchema(
                    level=ENTITY_LEVELS.get(entity_id, 3),
                    canContain=can_contain,
                    canBeContainedBy=can_be_contained,
                    defaultExpanded=ENTITY_LEVELS.get(entity_id, 3) <= 1
                ),
                behavior=EntityBehaviorSchema(
                    selectable=True,
                    draggable=ENTITY_LEVELS.get(entity_id, 3) <= 3,
                    expandable=len(can_contain) > 0,
                    traceable=True,
                    clickAction='select',
                    doubleClickAction='expand' if len(can_contain) > 0 else 'panel'
                )
            )
            entity_types.append(entity_def)
        
        # Build relationship type definitions from edge stats
        relationship_types: List[RelationshipTypeDefinition] = []
        
        EDGE_VISUALS = {
            'PRODUCES': {'strokeColor': '#6366f1', 'animated': True},
            'CONSUMES': {'strokeColor': '#10b981', 'animated': True},
            'TRANSFORMS': {'strokeColor': '#f59e0b', 'animated': True, 'strokeStyle': 'dashed'},
            'CONTAINS': {'strokeColor': '#94a3b8', 'animated': False, 'strokeStyle': 'dotted', 'arrowType': 'none'},
            'BELONGS_TO': {'strokeColor': '#94a3b8', 'animated': False, 'strokeStyle': 'dotted', 'arrowType': 'none'},
            'TAGGED_WITH': {'strokeColor': '#a855f7', 'animated': False},
            'RELATED_TO': {'strokeColor': '#64748b', 'animated': False},
            'AGGREGATED': {'strokeColor': '#f59e0b', 'animated': True, 'strokeWidth': 3},
        }
        
        for stat in stats.edge_type_stats:
            edge_id = stat.id
            visuals = EDGE_VISUALS.get(edge_id.upper(), {'strokeColor': '#6366f1', 'animated': True})
            
            # Check if this is a containment edge
            is_containment = edge_id.upper() in [t.upper() for t in ontology.containment_edge_types]
            
            rel_def = RelationshipTypeDefinition(
                id=edge_id.lower(),
                name=stat.name,
                description=f"Relationship type: {stat.name}",
                sourceTypes=stat.source_types,
                targetTypes=stat.target_types,
                visual=RelationshipVisualSchema(
                    strokeColor=visuals.get('strokeColor', '#6366f1'),
                    strokeWidth=visuals.get('strokeWidth', 2),
                    strokeStyle=visuals.get('strokeStyle', 'solid'),
                    animated=visuals.get('animated', True),
                    animationSpeed='normal',
                    arrowType=visuals.get('arrowType', 'arrow'),
                    curveType='bezier'
                ),
                bidirectional=False,
                showLabel=False,
                isContainment=is_containment
            )
            relationship_types.append(rel_def)
        
        return GraphSchema(
            version="1.0.0",
            entityTypes=entity_types,
            relationshipTypes=relationship_types,
            rootEntityTypes=ontology.root_entity_types,
            containmentEdgeTypes=ontology.containment_edge_types
        )

    async def get_aggregated_edges(self, request: AggregatedEdgeRequest) -> AggregatedEdgeResult:
        """
        Get aggregated edges between containers at a specified granularity.
        This enables progressive edge disclosure in the UI.
        """
        # Fetch all edges involving the source URNs
        all_source_urns = request.source_urns
        
        # Get edges where these URNs are sources or targets
        edges = await self.provider.get_edges(EdgeQuery(anyUrns=all_source_urns))
        
        # If target URNs specified, filter to only edges connecting to those targets
        if request.target_urns:
            target_set = set(request.target_urns)
            edges = [e for e in edges if e.target_urn in target_set or e.source_urn in target_set]
        
        # Filter by edge types if specified
        if request.include_edge_types:
            type_set = {t.value for t in request.include_edge_types}
            edges = [e for e in edges if e.edge_type.value in type_set]
        
        # Get all nodes involved to build containment map
        all_urns = set()
        for e in edges:
            all_urns.add(e.source_urn)
            all_urns.add(e.target_urn)
        
        nodes = await self.provider.get_nodes(NodeQuery(urns=list(all_urns)))
        containment_map = self._build_containment_map(nodes, edges)
        
        # Aggregate edges
        aggregated_map: Dict[str, Dict] = {}
        
        for edge in edges:
            # Skip containment edges for lineage aggregation
            if edge.edge_type == EdgeType.CONTAINS or edge.edge_type == EdgeType.BELONGS_TO:
                continue
            
            # Find ancestors at target granularity
            source_ancestor = self._find_ancestor_at_granularity(
                edge.source_urn, request.granularity, nodes, containment_map
            )
            target_ancestor = self._find_ancestor_at_granularity(
                edge.target_urn, request.granularity, nodes, containment_map
            )
            
            if source_ancestor and target_ancestor and source_ancestor != target_ancestor:
                key = f"{source_ancestor}->{target_ancestor}"
                
                if key not in aggregated_map:
                    aggregated_map[key] = {
                        'source_urn': source_ancestor,
                        'target_urn': target_ancestor,
                        'edge_ids': [],
                        'edge_types': set(),
                        'confidences': []
                    }
                
                aggregated_map[key]['edge_ids'].append(edge.id)
                aggregated_map[key]['edge_types'].add(edge.edge_type.value)
                if edge.confidence:
                    aggregated_map[key]['confidences'].append(edge.confidence)
        
        # Build result
        aggregated_edges = []
        for key, data in aggregated_map.items():
            avg_confidence = sum(data['confidences']) / len(data['confidences']) if data['confidences'] else 1.0
            
            aggregated_edges.append(AggregatedEdgeInfo(
                id=f"agg-{key}",
                sourceUrn=data['source_urn'],
                targetUrn=data['target_urn'],
                edgeCount=len(data['edge_ids']),
                edgeTypes=list(data['edge_types']),
                confidence=avg_confidence,
                sourceEdgeIds=data['edge_ids']
            ))
        
        return AggregatedEdgeResult(
            aggregatedEdges=aggregated_edges,
            totalSourceEdges=len(edges)
        )

    async def create_node(self, request: CreateNodeRequest) -> CreateNodeResult:
        """
        Create a new node with optional automatic containment edge.
        Validates against ontology rules before creation.
        """
        import uuid
        from datetime import datetime
        
        # Generate URN
        urn = f"urn:nexus:{request.entity_type.value}:{uuid.uuid4().hex[:12]}"
        
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
            parent_hierarchy = ontology.entity_type_hierarchy.get(parent_node.entity_type.value, {})
            can_contain = parent_hierarchy.get('canContain', []) if isinstance(parent_hierarchy, dict) else (parent_hierarchy.can_contain if hasattr(parent_hierarchy, 'can_contain') else [])
            
            if request.entity_type.value not in can_contain and len(can_contain) > 0:
                return CreateNodeResult(
                    node=None,
                    containmentEdge=None,
                    success=False,
                    error=f"Entity type '{request.entity_type.value}' cannot be contained by '{parent_node.entity_type.value}'"
                )
            
            # Create containment edge
            containment_edge = GraphEdge(
                id=f"contains-{request.parent_urn}-{urn}",
                sourceUrn=request.parent_urn,
                targetUrn=urn,
                edgeType=EdgeType.CONTAINS,
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

# Singleton instance
context_engine = ContextEngine()
