from typing import List, Dict, Any, Optional, Set, Union
from enum import Enum
from pydantic import BaseModel, Field, validator

# ============================================
# Enums
# ============================================

class EntityType(str, Enum):
    DATA_PLATFORM = 'dataPlatform'
    CONTAINER = 'container'
    DATASET = 'dataset'
    SCHEMA_FIELD = 'schemaField'
    DATA_JOB = 'dataJob'
    DATA_FLOW = 'dataFlow'
    DASHBOARD = 'dashboard'
    CHART = 'chart'
    GLOSSARY_TERM = 'glossaryTerm'
    TAG = 'tag'
    DOMAIN = 'domain'
    SYSTEM = 'system'
    APP = 'app'
    REPORT = 'report'

class EdgeType(str, Enum):
    CONTAINS = 'CONTAINS'
    BELONGS_TO = 'BELONGS_TO'
    TRANSFORMS = 'TRANSFORMS'
    PRODUCES = 'PRODUCES'
    CONSUMES = 'CONSUMES'
    TAGGED_WITH = 'TAGGED_WITH'
    RELATED_TO = 'RELATED_TO'
    AGGREGATED = 'AGGREGATED'

class Granularity(str, Enum):
    COLUMN = 'column'
    TABLE = 'table'
    SCHEMA = 'schema'
    SYSTEM = 'system'
    DOMAIN = 'domain'

class FilterOperator(str, Enum):
    EQUALS = 'equals'
    CONTAINS = 'contains'
    STARTS_WITH = 'startsWith'
    ENDS_WITH = 'endsWith'
    GT = 'gt'
    LT = 'lt'
    IN = 'in'
    NOT_IN = 'notIn'
    EXISTS = 'exists'
    NOT_EXISTS = 'notExists'

# ============================================
# Core Models
# ============================================

class GraphNode(BaseModel):
    urn: str
    entity_type: EntityType = Field(alias="entityType")
    display_name: str = Field(alias="displayName")
    qualified_name: Optional[str] = Field(None, alias="qualifiedName")
    description: Optional[str] = None
    properties: Dict[str, Any] = Field(default_factory=dict)
    tags: List[str] = Field(default_factory=list)
    layer_assignment: Optional[str] = Field(None, alias="layerAssignment")
    child_count: Optional[int] = Field(None, alias="childCount")
    source_system: Optional[str] = Field(None, alias="sourceSystem")
    last_synced_at: Optional[str] = Field(None, alias="lastSyncedAt")

    class Config:
        populate_by_name = True

class GraphEdge(BaseModel):
    id: str
    source_urn: str = Field(alias="sourceUrn")
    target_urn: str = Field(alias="targetUrn")
    edge_type: EdgeType = Field(alias="edgeType")
    confidence: Optional[float] = None
    properties: Dict[str, Any] = Field(default_factory=dict)

    class Config:
        populate_by_name = True

# ============================================
# Query Models
# ============================================

class PropertyFilter(BaseModel):
    field: str
    operator: FilterOperator
    value: Optional[Any] = None

class TagFilter(BaseModel):
    mode: str = "any"  # any, all, none
    tags: List[str]

class TextFilter(BaseModel):
    text: str
    operator: str = "contains"
    case_sensitive: bool = False

class NodeQuery(BaseModel):
    urns: Optional[List[str]] = None
    entity_types: Optional[List[EntityType]] = Field(None, alias="entityTypes")
    tags: Optional[List[str]] = None
    layer_id: Optional[str] = Field(None, alias="layerId")
    search_query: Optional[str] = Field(None, alias="searchQuery")
    property_filters: Optional[List[PropertyFilter]] = Field(None, alias="propertyFilters")
    tag_filters: Optional[TagFilter] = Field(None, alias="tagFilters")
    name_filter: Optional[TextFilter] = Field(None, alias="nameFilter")
    include_child_count: bool = Field(True, alias="includeChildCount")
    offset: Optional[int] = 0
    limit: Optional[int] = 100

    class Config:
        populate_by_name = True

class EdgeQuery(BaseModel):
    source_urns: Optional[List[str]] = Field(None, alias="sourceUrns")
    target_urns: Optional[List[str]] = Field(None, alias="targetUrns")
    any_urns: Optional[List[str]] = Field(None, alias="anyUrns")
    edge_types: Optional[List[EdgeType]] = Field(None, alias="edgeTypes")
    min_confidence: Optional[float] = Field(None, alias="minConfidence")
    offset: Optional[int] = 0
    limit: Optional[int] = 100

    @validator('edge_types', pre=True)
    def validate_edge_types(cls, v):
        if v is None:
            return None
        if not isinstance(v, list):
            return v
        result = []
        for et in v:
            if isinstance(et, str):
                try:
                    result.append(EdgeType(et.upper()))
                except ValueError:
                    for edge_type in EdgeType:
                        if edge_type.value.upper() == et.upper():
                            result.append(edge_type)
                            break
            elif isinstance(et, EdgeType):
                result.append(et)
        return result if result else None

    class Config:
        populate_by_name = True

# ============================================
# Result Models
# ============================================

class LineageResult(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    upstream_urns: Set[str] = Field(default_factory=set, alias="upstreamUrns")
    downstream_urns: Set[str] = Field(default_factory=set, alias="downstreamUrns")
    total_count: int = Field(alias="totalCount")
    has_more: bool = Field(alias="hasMore")
    aggregated_edges: Optional[Dict[str, Any]] = Field(None, alias="aggregatedEdges")

    class Config:
        populate_by_name = True

class ContainmentResult(BaseModel):
    parent: Optional[GraphNode]
    children: List[GraphNode]
    has_nested_children: bool = Field(alias="hasNestedChildren")

    class Config:
        populate_by_name = True

# ============================================
# Introspection Models
# ============================================

class EntityTypeSummary(BaseModel):
    id: str
    name: str
    count: int
    icon: Optional[str] = None
    color: Optional[str] = None
    sample_names: List[str] = Field(default_factory=list, alias="sampleNames")

class EdgeTypeSummary(BaseModel):
    id: str
    name: str
    count: int
    source_types: List[str] = Field(default_factory=list, alias="sourceTypes")
    target_types: List[str] = Field(default_factory=list, alias="targetTypes")

class TagSummary(BaseModel):
    tag: str
    count: int
    entity_types: List[str] = Field(default_factory=list, alias="entityTypes")

class GraphSchemaStats(BaseModel):
    total_nodes: int = Field(alias="totalNodes")
    total_edges: int = Field(alias="totalEdges")
    entity_type_stats: List[EntityTypeSummary] = Field(default_factory=list, alias="entityTypeStats")
    edge_type_stats: List[EdgeTypeSummary] = Field(default_factory=list, alias="edgeTypeStats")
    tag_stats: List[TagSummary] = Field(default_factory=list, alias="tagStats")

    class Config:
        populate_by_name = True

# ============================================
# Ontology Metadata Models
# ============================================

class EdgeTypeMetadata(BaseModel):
    is_containment: bool = Field(alias="isContainment")
    is_lineage: bool = Field(default=False, alias="isLineage")
    direction: str  # 'parent-to-child', 'child-to-parent', 'source-to-target', 'bidirectional'
    category: str = Field(default="association")  # 'structural', 'flow', 'metadata', 'association'
    description: Optional[str] = None

    class Config:
        populate_by_name = True

class EntityTypeHierarchy(BaseModel):
    can_contain: List[str] = Field(default_factory=list, alias="canContain")
    can_be_contained_by: List[str] = Field(default_factory=list, alias="canBeContainedBy")

    class Config:
        populate_by_name = True

class OntologyMetadata(BaseModel):
    containment_edge_types: List[str] = Field(alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(default_factory=list, alias="lineageEdgeTypes")
    edge_type_metadata: Dict[str, EdgeTypeMetadata] = Field(alias="edgeTypeMetadata")
    entity_type_hierarchy: Dict[str, EntityTypeHierarchy] = Field(alias="entityTypeHierarchy")
    root_entity_types: List[str] = Field(default_factory=list, alias="rootEntityTypes")

    class Config:
        populate_by_name = True

# ============================================
# Schema Definition Models
# ============================================

class FieldSchema(BaseModel):
    id: str
    name: str
    type: str
    required: bool = False
    show_in_node: bool = Field(default=True, alias="showInNode")
    show_in_panel: bool = Field(default=True, alias="showInPanel")
    show_in_tooltip: bool = Field(default=False, alias="showInTooltip")
    display_order: int = Field(default=0, alias="displayOrder")

    class Config:
        populate_by_name = True

class EntityVisualSchema(BaseModel):
    icon: str = "Box"
    color: str = "#6366f1"
    shape: str = "rounded"
    size: str = "md"
    border_style: str = Field(default="solid", alias="borderStyle")
    show_in_minimap: bool = Field(default=True, alias="showInMinimap")

    class Config:
        populate_by_name = True

class EntityHierarchySchema(BaseModel):
    level: int = 0
    can_contain: List[str] = Field(default_factory=list, alias="canContain")
    can_be_contained_by: List[str] = Field(default_factory=list, alias="canBeContainedBy")
    default_expanded: bool = Field(default=False, alias="defaultExpanded")

    class Config:
        populate_by_name = True

class EntityBehaviorSchema(BaseModel):
    selectable: bool = True
    draggable: bool = True
    expandable: bool = True
    traceable: bool = True
    click_action: str = Field(default="select", alias="clickAction")
    double_click_action: str = Field(default="expand", alias="doubleClickAction")

    class Config:
        populate_by_name = True

class EntityTypeDefinition(BaseModel):
    id: str
    name: str
    plural_name: str = Field(alias="pluralName")
    description: Optional[str] = None
    visual: EntityVisualSchema
    fields: List[FieldSchema] = Field(default_factory=list)
    hierarchy: EntityHierarchySchema
    behavior: EntityBehaviorSchema

    class Config:
        populate_by_name = True

class RelationshipVisualSchema(BaseModel):
    stroke_color: str = Field(default="#6366f1", alias="strokeColor")
    stroke_width: int = Field(default=2, alias="strokeWidth")
    stroke_style: str = Field(default="solid", alias="strokeStyle")
    animated: bool = True
    animation_speed: str = Field(default="normal", alias="animationSpeed")
    arrow_type: str = Field(default="arrow", alias="arrowType")
    curve_type: str = Field(default="bezier", alias="curveType")

    class Config:
        populate_by_name = True

class RelationshipTypeDefinition(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    source_types: List[str] = Field(default_factory=list, alias="sourceTypes")
    target_types: List[str] = Field(default_factory=list, alias="targetTypes")
    visual: RelationshipVisualSchema
    bidirectional: bool = False
    show_label: bool = Field(default=False, alias="showLabel")
    is_containment: bool = Field(default=False, alias="isContainment")

    class Config:
        populate_by_name = True

class GraphSchema(BaseModel):
    version: str = "1.0.0"
    entity_types: List[EntityTypeDefinition] = Field(alias="entityTypes")
    relationship_types: List[RelationshipTypeDefinition] = Field(alias="relationshipTypes")
    root_entity_types: List[str] = Field(default_factory=list, alias="rootEntityTypes")
    containment_edge_types: List[str] = Field(default_factory=list, alias="containmentEdgeTypes")

    class Config:
        populate_by_name = True

# ============================================
# Aggregated Edge Models
# ============================================

class AggregatedEdgeRequest(BaseModel):
    source_urns: List[str] = Field(alias="sourceUrns")
    target_urns: Optional[List[str]] = Field(None, alias="targetUrns")
    granularity: Granularity = Granularity.TABLE
    include_edge_types: Optional[List[EdgeType]] = Field(None, alias="includeEdgeTypes")
    lineage_edge_types: Optional[List[str]] = Field(None, alias="lineageEdgeTypes")
    containment_edge_types: Optional[List[str]] = Field(None, alias="containmentEdgeTypes")

    class Config:
        populate_by_name = True

class AggregatedEdgeInfo(BaseModel):
    id: str
    source_urn: str = Field(alias="sourceUrn")
    target_urn: str = Field(alias="targetUrn")
    edge_count: int = Field(alias="edgeCount")
    edge_types: List[str] = Field(default_factory=list, alias="edgeTypes")
    confidence: float = 1.0
    source_edge_ids: List[str] = Field(default_factory=list, alias="sourceEdgeIds")

    class Config:
        populate_by_name = True

class AggregatedEdgeResult(BaseModel):
    aggregated_edges: List[AggregatedEdgeInfo] = Field(alias="aggregatedEdges")
    total_source_edges: int = Field(alias="totalSourceEdges")

    class Config:
        populate_by_name = True

# ============================================
# Node Creation Models
# ============================================

class CreateNodeRequest(BaseModel):
    entity_type: EntityType = Field(alias="entityType")
    display_name: str = Field(alias="displayName")
    parent_urn: Optional[str] = Field(None, alias="parentUrn")
    properties: Dict[str, Any] = Field(default_factory=dict)
    tags: List[str] = Field(default_factory=list)

    class Config:
        populate_by_name = True

class CreateNodeResult(BaseModel):
    node: GraphNode
    containment_edge: Optional[GraphEdge] = Field(None, alias="containmentEdge")
    success: bool = True
    error: Optional[str] = None

    class Config:
        populate_by_name = True
