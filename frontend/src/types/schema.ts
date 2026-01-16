/**
 * NexusLineage Schema System
 * 
 * User-defined entity types, hierarchies, and view configurations.
 * Everything is configurable - no hardcoded entity types.
 */

// ============================================
// ENTITY SCHEMA DEFINITIONS
// ============================================

/**
 * Defines a user-configurable entity type
 * Examples: "Domain", "Database", "Schema", "Table", "Column", "Pipeline", "Dashboard"
 */
export interface EntityTypeSchema {
  id: string;                          // Unique identifier (e.g., "domain", "table")
  name: string;                        // Display name (e.g., "Domain", "Table")
  pluralName: string;                  // Plural form (e.g., "Domains", "Tables")
  description?: string;
  
  // Visual Configuration
  visual: EntityVisualConfig;
  
  // Field Definitions - what properties this entity has
  fields: EntityFieldDefinition[];
  
  // Hierarchy Configuration
  hierarchy: EntityHierarchyConfig;
  
  // Behavior Configuration
  behavior: EntityBehaviorConfig;
}

export interface EntityVisualConfig {
  icon: string;                        // Lucide icon name or custom SVG
  color: string;                       // Primary color (hex or CSS variable)
  colorSecondary?: string;             // Secondary/accent color
  shape: 'rectangle' | 'rounded' | 'pill' | 'diamond' | 'hexagon' | 'circle';
  size: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  borderStyle: 'solid' | 'dashed' | 'dotted' | 'none';
  showInMinimap: boolean;
}

export interface EntityFieldDefinition {
  id: string;                          // Field identifier
  name: string;                        // Display name
  type: FieldType;
  required: boolean;
  showInNode: boolean;                 // Display in node card
  showInPanel: boolean;                // Display in detail panel
  showInTooltip: boolean;              // Display in hover tooltip
  displayOrder: number;                // Order of display
  format?: FieldFormat;                // How to format the value
}

export type FieldType = 
  | 'string' 
  | 'number' 
  | 'boolean' 
  | 'date' 
  | 'datetime'
  | 'url' 
  | 'email'
  | 'urn'                              // Technical identifier
  | 'tags'                             // Array of strings
  | 'badge'                            // Single highlighted value
  | 'progress'                         // 0-100 percentage
  | 'status'                           // Enum with colors
  | 'user'                             // User reference
  | 'entity_ref'                       // Reference to another entity
  | 'json'                             // Arbitrary JSON
  | 'markdown';                        // Rich text

export interface FieldFormat {
  prefix?: string;
  suffix?: string;
  dateFormat?: string;
  numberFormat?: 'decimal' | 'percentage' | 'compact' | 'currency';
  truncateAt?: number;
  statusColors?: Record<string, string>;  // For status fields
}

export interface EntityHierarchyConfig {
  level: number;                       // 0 = root, higher = deeper
  canContain: string[];                // Entity type IDs this can contain
  canBeContainedBy: string[];          // Entity type IDs that can contain this
  defaultExpanded: boolean;            // Show children by default
  rollUpFields: RollUpConfig[];        // Fields to aggregate from children
}

export interface RollUpConfig {
  sourceField: string;                 // Field in children to aggregate
  targetField: string;                 // Field to store in parent
  aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'list' | 'distinct';
  label?: string;                      // Display label (e.g., "3 Tables")
}

export interface EntityBehaviorConfig {
  selectable: boolean;
  draggable: boolean;
  expandable: boolean;                 // Can show/hide children
  traceable: boolean;                  // Can start lineage trace from this
  clickAction: 'select' | 'expand' | 'navigate' | 'panel';
  doubleClickAction: 'expand' | 'navigate' | 'trace' | 'edit';
}

// ============================================
// RELATIONSHIP SCHEMA
// ============================================

export interface RelationshipTypeSchema {
  id: string;
  name: string;
  description?: string;
  
  // Source and Target constraints
  sourceTypes: string[];               // Entity types that can be source
  targetTypes: string[];               // Entity types that can be target
  
  // Visual Configuration
  visual: RelationshipVisualConfig;
  
  // Behavior
  bidirectional: boolean;
  showLabel: boolean;
  labelField?: string;                 // Field to use as edge label
}

export interface RelationshipVisualConfig {
  strokeColor: string;
  strokeWidth: number;
  strokeStyle: 'solid' | 'dashed' | 'dotted';
  animated: boolean;
  animationSpeed: 'slow' | 'normal' | 'fast';
  arrowType: 'arrow' | 'diamond' | 'circle' | 'none';
  curveType: 'bezier' | 'step' | 'straight' | 'smoothstep';
}

// ============================================
// VIEW CONFIGURATION
// ============================================

/**
 * A View is a complete configuration of how to display entities
 * Users can create multiple views for different use cases
 */
export interface ViewConfiguration {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  
  // What to show
  content: ViewContentConfig;
  
  // How to show it
  layout: ViewLayoutConfig;
  
  // Filtering
  filters: ViewFilterConfig;
  
  // Visual overrides per entity type
  entityOverrides: Record<string, Partial<EntityVisualConfig>>;
  
  // Grouping configuration
  grouping?: ViewGroupingConfig;
  
  // Permissions
  isDefault: boolean;
  isPublic: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ViewContentConfig {
  // Which entity types are visible in this view
  visibleEntityTypes: string[];
  
  // Which relationship types are visible
  visibleRelationshipTypes: string[];
  
  // Default hierarchy depth to show
  defaultDepth: number;
  
  // Max hierarchy depth allowed
  maxDepth: number;
  
  // Root entity types (entry points for navigation)
  rootEntityTypes: string[];
}

export interface ViewLayoutConfig {
  type: 'graph' | 'tree' | 'hierarchy' | 'list' | 'grid' | 'timeline';
  
  // Graph-specific
  graphLayout?: {
    algorithm: 'dagre' | 'elk' | 'force' | 'radial' | 'manual';
    direction: 'LR' | 'RL' | 'TB' | 'BT';
    nodeSpacing: number;
    levelSpacing: number;
  };
  
  // Tree-specific
  treeLayout?: {
    orientation: 'horizontal' | 'vertical';
    compactMode: boolean;
  };
  
  // LOD (Level of Detail) configuration
  lod: LODConfig;
}

export interface LODConfig {
  enabled: boolean;
  levels: LODLevel[];
}

export interface LODLevel {
  name: string;
  zoomRange: [number, number];         // [minZoom, maxZoom]
  visibleEntityTypes: string[];
  showLabels: boolean;
  showIcons: boolean;
  showBadges: boolean;
  aggregateChildren: boolean;          // Show child count instead of nodes
}

export interface ViewFilterConfig {
  // Persistent filters for this view
  entityTypeFilters: string[];
  fieldFilters: FieldFilter[];
  
  // Search configuration
  searchableFields: string[];
  
  // Quick filter buttons
  quickFilters: QuickFilter[];
}

export interface FieldFilter {
  field: string;
  operator: 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'gt' | 'lt' | 'in' | 'notIn';
  value: unknown;
}

export interface QuickFilter {
  id: string;
  label: string;
  icon?: string;
  filter: FieldFilter[];
}

export interface ViewGroupingConfig {
  enabled: boolean;
  groupByField: string;                // Field to group by
  groupVisual: {
    showHeader: boolean;
    collapsible: boolean;
    color?: string;
  };
}

// ============================================
// WORKSPACE SCHEMA
// ============================================

/**
 * Complete workspace configuration containing all schemas and views
 */
export interface WorkspaceSchema {
  id: string;
  name: string;
  version: string;
  
  // Entity type definitions
  entityTypes: EntityTypeSchema[];
  
  // Relationship type definitions
  relationshipTypes: RelationshipTypeSchema[];
  
  // View configurations
  views: ViewConfiguration[];
  
  // Default view ID
  defaultViewId: string;
  
  // Global visual settings
  globalVisuals: GlobalVisualConfig;
}

export interface GlobalVisualConfig {
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  fontFamily: string;
  borderRadius: 'none' | 'sm' | 'md' | 'lg' | 'full';
  showConfidenceScores: boolean;
  animationsEnabled: boolean;
}

// ============================================
// ENTITY INSTANCE (Runtime Data)
// ============================================

/**
 * An actual entity instance in the graph
 */
export interface EntityInstance {
  id: string;
  typeId: string;                      // References EntityTypeSchema.id
  
  // Core data
  data: Record<string, unknown>;       // Field values
  
  // Hierarchy
  parentId?: string;
  childIds: string[];
  
  // Position (for graph layout)
  position?: { x: number; y: number };
  
  // Computed/cached values
  _computed?: {
    rollUps: Record<string, unknown>;
    depth: number;
    path: string[];                    // Ancestor IDs
  };
}

export interface RelationshipInstance {
  id: string;
  typeId: string;                      // References RelationshipTypeSchema.id
  sourceId: string;
  targetId: string;
  data?: Record<string, unknown>;
}

