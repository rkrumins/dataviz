"""
Domain data classes for the ontology service.
These are pure Python dataclasses — no SQLAlchemy, no Pydantic, no FastAPI.
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class EntityVisualData:
    icon: str = "Box"
    color: str = "#6366f1"
    color_secondary: Optional[str] = None
    shape: str = "rounded"
    size: str = "md"
    border_style: str = "solid"
    show_in_minimap: bool = True


@dataclass
class EntityHierarchyData:
    level: int = 0
    can_contain: List[str] = field(default_factory=list)
    can_be_contained_by: List[str] = field(default_factory=list)
    default_expanded: bool = False
    roll_up_fields: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class EntityBehaviorData:
    selectable: bool = True
    draggable: bool = True
    expandable: bool = True
    traceable: bool = True
    click_action: str = "select"
    double_click_action: str = "expand"
    expansion_mode: str = "graph"  # "graph" | "inline"


@dataclass
class FieldData:
    id: str = ""
    name: str = ""
    type: str = "text"
    required: bool = False
    show_in_node: bool = True
    show_in_panel: bool = True
    show_in_tooltip: bool = False
    display_order: int = 0
    format: Optional[Dict[str, Any]] = None


@dataclass
class EntityTypeDefEntry:
    """Complete definition for an entity type. Nested shape matches frontend EntityTypeSchema."""
    name: str = ""
    plural_name: str = ""
    description: Optional[str] = None
    granularity: str = "table"
    visual: EntityVisualData = field(default_factory=EntityVisualData)
    hierarchy: EntityHierarchyData = field(default_factory=EntityHierarchyData)
    behavior: EntityBehaviorData = field(default_factory=EntityBehaviorData)
    fields: List[FieldData] = field(default_factory=list)


@dataclass
class RelationshipVisualData:
    stroke_color: str = "#6366f1"
    stroke_width: int = 2
    stroke_style: str = "solid"
    animated: bool = True
    animation_speed: str = "normal"
    arrow_type: str = "arrow"
    curve_type: str = "bezier"


@dataclass
class RelationshipTypeDefEntry:
    """Complete definition for a relationship type."""
    name: str = ""
    description: Optional[str] = None
    category: str = "association"  # structural | flow | metadata | association
    is_containment: bool = False
    is_lineage: bool = False
    direction: str = "source-to-target"
    visual: RelationshipVisualData = field(default_factory=RelationshipVisualData)
    source_types: List[str] = field(default_factory=list)
    target_types: List[str] = field(default_factory=list)
    bidirectional: bool = False
    show_label: bool = False
    label_field: Optional[str] = None


@dataclass
class DerivedLists:
    """Derived flat lists computed from entity/relationship definitions."""
    containment_edge_types: List[str] = field(default_factory=list)
    lineage_edge_types: List[str] = field(default_factory=list)
    root_entity_types: List[str] = field(default_factory=list)
    entity_type_hierarchy: Dict[str, Dict] = field(default_factory=dict)
    edge_type_metadata: Dict[str, Dict] = field(default_factory=dict)


@dataclass
class OntologyData:
    """Raw data loaded from DB (before resolution/merge)."""
    id: str
    name: str
    version: int
    entity_type_definitions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    relationship_type_definitions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    # Legacy flat columns (for backward compat with old records)
    containment_edge_types: List[str] = field(default_factory=list)
    lineage_edge_types: List[str] = field(default_factory=list)
    edge_type_metadata: Dict[str, Any] = field(default_factory=dict)
    entity_type_hierarchy: Dict[str, Any] = field(default_factory=dict)
    root_entity_types: List[str] = field(default_factory=list)
    is_system: bool = False
    scope: str = "universal"


@dataclass
class ResolvedOntology:
    """Fully resolved and merged ontology, ready to serve to clients."""
    # Rich definitions (primary source of truth)
    entity_type_definitions: Dict[str, EntityTypeDefEntry] = field(default_factory=dict)
    relationship_type_definitions: Dict[str, RelationshipTypeDefEntry] = field(default_factory=dict)
    # Derived flat lists (for backward compat and fast graph traversal)
    containment_edge_types: List[str] = field(default_factory=list)
    lineage_edge_types: List[str] = field(default_factory=list)
    edge_type_metadata: Dict[str, Dict] = field(default_factory=dict)
    entity_type_hierarchy: Dict[str, Dict] = field(default_factory=dict)
    root_entity_types: List[str] = field(default_factory=list)
    # Provenance: which layer each type came from
    resolution_sources: Dict[str, str] = field(default_factory=dict)  # type_id -> "blueprint"|"system_default"|"introspection"


@dataclass
class ValidationIssue:
    """A validation problem found in an ontology definition."""
    severity: str  # "error" | "warning"
    code: str
    message: str
    affected: Optional[str] = None  # type ID


@dataclass
class CoverageReport:
    """Coverage analysis: how well an ontology covers a graph's actual types."""
    coverage_percent: float = 0.0
    covered_entity_types: List[str] = field(default_factory=list)
    uncovered_entity_types: List[str] = field(default_factory=list)
    extra_entity_types: List[str] = field(default_factory=list)  # in ontology but not in graph
    covered_relationship_types: List[str] = field(default_factory=list)
    uncovered_relationship_types: List[str] = field(default_factory=list)
