from typing import List, Dict, Any, Optional, Set
from enum import Enum
from pydantic import BaseModel, Field

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
    DOMAIN = 'domain'      # Added based on specific use cases
    SYSTEM = 'system'      # Added based on specific use cases
    APP = 'app'            # Added based on specific use cases
    REPORT = 'report'      # Added for Consumption layer validation

class EdgeType(str, Enum):
    CONTAINS = 'CONTAINS'
    BELONGS_TO = 'BELONGS_TO'
    TRANSFORMS = 'TRANSFORMS'
    PRODUCES = 'PRODUCES'
    CONSUMES = 'CONSUMES'
    TAGGED_WITH = 'TAGGED_WITH'
    RELATED_TO = 'RELATED_TO'
    AGGREGATED = 'AGGREGATED' # Added for aggregated edges

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

# ============================================
# Query Models
# ============================================

class PropertyFilter(BaseModel):
    field: str
    operator: FilterOperator
    value: Optional[Any] = None

class TagFilter(BaseModel):
    mode: str = "any" # any, all, none
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
    
    # Aggregation Support
    aggregated_edges: Optional[Dict[str, Any]] = Field(None, alias="aggregatedEdges") # Map<id, metadata>

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
