import type { WorkspaceSchema, EntityTypeSchema, RelationshipTypeSchema, ViewConfiguration } from '@/types/schema'

/**
 * Default Entity Types
 * Users can customize these or create entirely new ones
 */
const defaultEntityTypes: EntityTypeSchema[] = [
  // Level 0: Domain / Business Area
  {
    id: 'domain',
    name: 'Domain',
    pluralName: 'Domains',
    description: 'Top-level business domain or data domain',
    visual: {
      icon: 'FolderTree',
      color: '#8b5cf6',
      shape: 'rounded',
      size: 'lg',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'description', name: 'Description', type: 'markdown', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 2 },
      { id: 'owner', name: 'Owner', type: 'user', required: false, showInNode: false, showInPanel: true, showInTooltip: true, displayOrder: 3 },
      { id: 'tags', name: 'Tags', type: 'tags', required: false, showInNode: true, showInPanel: true, showInTooltip: false, displayOrder: 4 },
    ],
    hierarchy: {
      level: 0,
      canContain: ['system', 'database', 'application'],
      canBeContainedBy: [],
      defaultExpanded: true,
      rollUpFields: [
        { sourceField: 'id', targetField: 'childCount', aggregation: 'count', label: 'children' },
      ],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'expand',
    },
  },

  // Level 1: System / Database / Application
  {
    id: 'system',
    name: 'System',
    pluralName: 'Systems',
    description: 'A system, application, or database',
    visual: {
      icon: 'Database',
      color: '#06b6d4',
      shape: 'rounded',
      size: 'md',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'type', name: 'Type', type: 'badge', required: false, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 2 },
      { id: 'platform', name: 'Platform', type: 'string', required: false, showInNode: false, showInPanel: true, showInTooltip: true, displayOrder: 3 },
      { id: 'urn', name: 'URN', type: 'urn', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 10 },
    ],
    hierarchy: {
      level: 1,
      canContain: ['schema', 'container', 'dataset'],
      canBeContainedBy: ['domain'],
      defaultExpanded: false,
      rollUpFields: [
        { sourceField: 'id', targetField: 'childCount', aggregation: 'count', label: 'items' },
      ],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'expand',
    },
  },

  // Data Platform (like System)
  {
    id: 'dataPlatform',
    name: 'Data Platform',
    pluralName: 'Data Platforms',
    description: 'A data platform or service',
    visual: {
      icon: 'Server',
      color: '#06b6d4',
      shape: 'rounded',
      size: 'md',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'type', name: 'Type', type: 'badge', required: false, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 2 },
      { id: 'urn', name: 'URN', type: 'urn', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 10 },
    ],
    hierarchy: {
      level: 1,
      canContain: ['schema', 'container', 'dataset'],
      canBeContainedBy: ['domain'],
      defaultExpanded: false,
      rollUpFields: [
        { sourceField: 'id', targetField: 'childCount', aggregation: 'count', label: 'items' },
      ],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'expand',
    },
  },

  // Container (like Schema)
  {
    id: 'container',
    name: 'Container',
    pluralName: 'Containers',
    description: 'A container within a platform',
    visual: {
      icon: 'Box',
      color: '#10b981',
      shape: 'rounded',
      size: 'md',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'urn', name: 'URN', type: 'urn', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 10 },
    ],
    hierarchy: {
      level: 2,
      canContain: ['dataset', 'table'],
      canBeContainedBy: ['dataPlatform', 'system'],
      defaultExpanded: false,
      rollUpFields: [
        { sourceField: 'id', targetField: 'tableCount', aggregation: 'count', label: 'tables' },
      ],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'expand',
    },
  },

  // Level 2: Schema / Container
  {
    id: 'schema',
    name: 'Schema',
    pluralName: 'Schemas',
    description: 'A schema or container within a system',
    visual: {
      icon: 'Layers',
      color: '#10b981',
      shape: 'rounded',
      size: 'md',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'urn', name: 'URN', type: 'urn', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 10 },
    ],
    hierarchy: {
      level: 2,
      canContain: ['dataset', 'table', 'view'],
      canBeContainedBy: ['system', 'database'],
      defaultExpanded: false,
      rollUpFields: [
        { sourceField: 'id', targetField: 'tableCount', aggregation: 'count', label: 'tables' },
      ],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'expand',
    },
  },

  // Level 3: Dataset / Table
  {
    id: 'dataset',
    name: 'Dataset',
    pluralName: 'Datasets',
    description: 'A table, view, or dataset',
    visual: {
      icon: 'Table2',
      color: '#22c55e',
      shape: 'rectangle',
      size: 'sm',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'type', name: 'Type', type: 'badge', required: false, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 2 },
      { id: 'rowCount', name: 'Row Count', type: 'number', required: false, showInNode: false, showInPanel: true, showInTooltip: true, displayOrder: 3, format: { numberFormat: 'compact' } },
      { id: 'tags', name: 'Tags', type: 'tags', required: false, showInNode: true, showInPanel: true, showInTooltip: false, displayOrder: 4 },
      { id: 'urn', name: 'URN', type: 'urn', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 10 },
      { id: 'confidence', name: 'Confidence', type: 'progress', required: false, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 5 },
    ],
    hierarchy: {
      level: 3,
      canContain: ['column', 'field'],
      canBeContainedBy: ['schema', 'system', 'database'],
      defaultExpanded: false,
      rollUpFields: [
        { sourceField: 'id', targetField: 'columnCount', aggregation: 'count', label: 'columns' },
      ],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'panel',
    },
  },

  // Level 4: Column / Field
  {
    id: 'column',
    name: 'Column',
    pluralName: 'Columns',
    description: 'A column or field within a dataset',
    visual: {
      icon: 'Columns3',
      color: '#f59e0b',
      shape: 'rectangle',
      size: 'xs',
      borderStyle: 'solid',
      showInMinimap: false,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'dataType', name: 'Data Type', type: 'badge', required: false, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 2 },
      { id: 'nullable', name: 'Nullable', type: 'boolean', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 3 },
      { id: 'tags', name: 'Tags', type: 'tags', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 4 },
      { id: 'urn', name: 'URN', type: 'urn', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 10 },
    ],
    hierarchy: {
      level: 4,
      canContain: [],
      canBeContainedBy: ['dataset', 'table'],
      defaultExpanded: false,
      rollUpFields: [],
    },
    behavior: {
      selectable: true,
      draggable: false,
      expandable: false,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'panel',
    },
  },

  // Pipeline / Job
  {
    id: 'pipeline',
    name: 'Pipeline',
    pluralName: 'Pipelines',
    description: 'A data pipeline or ETL job',
    visual: {
      icon: 'Workflow',
      color: '#ec4899',
      shape: 'diamond',
      size: 'md',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'status', name: 'Status', type: 'status', required: false, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 2, format: { statusColors: { 'running': '#22c55e', 'failed': '#ef4444', 'pending': '#f59e0b' } } },
      { id: 'schedule', name: 'Schedule', type: 'string', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 3 },
      { id: 'lastRun', name: 'Last Run', type: 'datetime', required: false, showInNode: false, showInPanel: true, showInTooltip: true, displayOrder: 4 },
      { id: 'urn', name: 'URN', type: 'urn', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 10 },
    ],
    hierarchy: {
      level: 2,
      canContain: ['task'],
      canBeContainedBy: ['domain', 'system'],
      defaultExpanded: false,
      rollUpFields: [],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'panel',
    },
  },

  // Dashboard
  {
    id: 'dashboard',
    name: 'Dashboard',
    pluralName: 'Dashboards',
    description: 'A BI dashboard or report',
    visual: {
      icon: 'LayoutDashboard',
      color: '#3b82f6',
      shape: 'rounded',
      size: 'md',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
      { id: 'platform', name: 'Platform', type: 'badge', required: false, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 2 },
      { id: 'viewers', name: 'Viewers', type: 'number', required: false, showInNode: false, showInPanel: true, showInTooltip: true, displayOrder: 3 },
      { id: 'url', name: 'URL', type: 'url', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 4 },
      { id: 'urn', name: 'URN', type: 'urn', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 10 },
    ],
    hierarchy: {
      level: 3,
      canContain: ['chart'],
      canBeContainedBy: ['domain', 'system'],
      defaultExpanded: false,
      rollUpFields: [],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'panel',
    },
  },

  // Ghost / Pagination Indicator
  {
    id: 'ghost',
    name: 'More',
    pluralName: 'More',
    description: 'Pagination indicator for more entities',
    visual: {
      icon: 'MoreHorizontal',
      color: '#64748b',
      shape: 'rounded',
      size: 'sm',
      borderStyle: 'dashed',
      showInMinimap: false,
    },
    fields: [
      { id: 'count', name: 'Count', type: 'number', required: false, showInNode: true, showInPanel: false, showInTooltip: true, displayOrder: 1 },
      { id: 'direction', name: 'Direction', type: 'string', required: false, showInNode: true, showInPanel: false, showInTooltip: false, displayOrder: 2 },
    ],
    hierarchy: {
      level: -1,
      canContain: [],
      canBeContainedBy: [],
      defaultExpanded: false,
      rollUpFields: [],
    },
    behavior: {
      selectable: true,
      draggable: false,
      expandable: false,
      traceable: false,
      clickAction: 'expand',
      doubleClickAction: 'expand',
    },
  },
]

/**
 * Default Relationship Types
 */
const defaultRelationshipTypes: RelationshipTypeSchema[] = [
  {
    id: 'produces',
    name: 'Produces',
    description: 'Source produces data for target',
    sourceTypes: ['pipeline', 'system', 'dataset', 'domain'],
    targetTypes: ['dataset', 'dashboard', 'system'],
    visual: {
      strokeColor: '#6366f1',
      strokeWidth: 2,
      strokeStyle: 'solid',
      animated: true,
      animationSpeed: 'normal',
      arrowType: 'arrow',
      curveType: 'bezier',
    },
    bidirectional: false,
    showLabel: false,
  },
  {
    id: 'consumes',
    name: 'Consumes',
    description: 'Source consumes data from target',
    sourceTypes: ['dataset', 'pipeline', 'dashboard', 'system'],
    targetTypes: ['dataset', 'dashboard'],
    visual: {
      strokeColor: '#10b981',
      strokeWidth: 2,
      strokeStyle: 'solid',
      animated: true,
      animationSpeed: 'normal',
      arrowType: 'arrow',
      curveType: 'bezier',
    },
    bidirectional: false,
    showLabel: false,
  },
  {
    id: 'transforms',
    name: 'Transforms',
    description: 'Source transforms data into target',
    sourceTypes: ['pipeline', 'dataset'],
    targetTypes: ['dataset'],
    visual: {
      strokeColor: '#f59e0b',
      strokeWidth: 2,
      strokeStyle: 'dashed',
      animated: true,
      animationSpeed: 'normal',
      arrowType: 'arrow',
      curveType: 'bezier',
    },
    bidirectional: false,
    showLabel: true,
    labelField: 'transformationType',
  },
  {
    id: 'contains',
    name: 'Contains',
    description: 'Parent contains child (hierarchy)',
    sourceTypes: ['domain', 'system', 'schema', 'dataset'],
    targetTypes: ['system', 'schema', 'dataset', 'column'],
    visual: {
      strokeColor: '#94a3b8',
      strokeWidth: 1,
      strokeStyle: 'dotted',
      animated: false,
      animationSpeed: 'normal',
      arrowType: 'none',
      curveType: 'step',
    },
    bidirectional: false,
    showLabel: false,
  },
]

/**
 * Default Views
 */
const defaultViews: ViewConfiguration[] = [
  // Default Lineage View - Graph-based flow visualization
  {
    id: 'lineage-view',
    name: 'Data Lineage',
    description: 'Full data lineage graph with all entity types',
    icon: 'Network',
    content: {
      visibleEntityTypes: ['domain', 'system', 'schema', 'dataset', 'pipeline', 'dashboard', 'ghost'],
      visibleRelationshipTypes: ['produces', 'consumes', 'transforms'],
      defaultDepth: 3,
      maxDepth: 10,
      rootEntityTypes: ['domain'],
    },
    layout: {
      type: 'graph',
      graphLayout: {
        algorithm: 'dagre',
        direction: 'LR',
        nodeSpacing: 80,
        levelSpacing: 200,
      },
      lod: {
        enabled: true,
        levels: [
          { name: 'Overview', zoomRange: [0, 0.3], visibleEntityTypes: ['domain'], showLabels: true, showIcons: true, showBadges: false, aggregateChildren: true },
          { name: 'Systems', zoomRange: [0.3, 0.6], visibleEntityTypes: ['domain', 'system'], showLabels: true, showIcons: true, showBadges: true, aggregateChildren: true },
          { name: 'Detailed', zoomRange: [0.6, 2], visibleEntityTypes: ['domain', 'system', 'schema', 'dataset', 'pipeline', 'dashboard'], showLabels: true, showIcons: true, showBadges: true, aggregateChildren: false },
        ],
      },
    },
    filters: {
      entityTypeFilters: [],
      fieldFilters: [],
      searchableFields: ['name', 'urn', 'tags', 'description'],
      quickFilters: [
        { id: 'pii', label: 'PII Data', icon: 'Shield', filter: [{ field: 'tags', operator: 'contains', value: 'PII' }] },
        { id: 'stale', label: 'Stale', icon: 'Clock', filter: [{ field: 'lastUpdated', operator: 'lt', value: '-7d' }] },
      ],
    },
    entityOverrides: {},
    grouping: undefined,
    isDefault: true,
    isPublic: true,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },

  // Physical Fabric View - Hierarchy-style Reference Model
  {
    id: 'physical-fabric',
    name: 'Physical Fabric',
    description: 'Hierarchy-style hierarchical reference model with L→R flow',
    icon: 'FolderTree',
    content: {
      visibleEntityTypes: ['domain', 'system', 'schema', 'dataset', 'column'],
      visibleRelationshipTypes: ['contains'],
      defaultDepth: 5,
      maxDepth: 10,
      rootEntityTypes: ['domain', 'system'],
    },
    layout: {
      type: 'hierarchy',
      graphLayout: {
        algorithm: 'dagre',
        direction: 'LR',
        nodeSpacing: 40,
        levelSpacing: 280,
      },
      lod: {
        enabled: true,
        levels: [
          { name: 'Systems', zoomRange: [0, 0.4], visibleEntityTypes: ['domain', 'system'], showLabels: true, showIcons: true, showBadges: false, aggregateChildren: true },
          { name: 'Schemas', zoomRange: [0.4, 0.7], visibleEntityTypes: ['domain', 'system', 'schema'], showLabels: true, showIcons: true, showBadges: true, aggregateChildren: true },
          { name: 'Datasets', zoomRange: [0.7, 1.2], visibleEntityTypes: ['domain', 'system', 'schema', 'dataset'], showLabels: true, showIcons: true, showBadges: true, aggregateChildren: true },
          { name: 'Columns', zoomRange: [1.2, 3], visibleEntityTypes: ['domain', 'system', 'schema', 'dataset', 'column'], showLabels: true, showIcons: true, showBadges: true, aggregateChildren: false },
        ],
      },
    },
    filters: {
      entityTypeFilters: [],
      fieldFilters: [],
      searchableFields: ['name', 'urn', 'dataType'],
      quickFilters: [
        { id: 'pii', label: 'PII Columns', icon: 'Shield', filter: [{ field: 'tags', operator: 'contains', value: 'PII' }] },
        { id: 'pk', label: 'Primary Keys', icon: 'Key', filter: [{ field: 'tags', operator: 'contains', value: 'PK' }] },
        { id: 'fk', label: 'Foreign Keys', icon: 'Link', filter: [{ field: 'tags', operator: 'contains', value: 'FK' }] },
      ],
    },
    entityOverrides: {},
    grouping: {
      enabled: true,
      groupByField: 'system',
      groupVisual: {
        showHeader: true,
        collapsible: true,
        color: '#6366f1',
      },
    },
    isDefault: false,
    isPublic: true,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },

  // Reference Model View - Horizontal layer-based layout (Hierarchy-style)
  {
    id: 'reference-model',
    name: 'Reference Model',
    description: 'Horizontal layer flow: Source → Staging → Refinery → Consumption',
    icon: 'LayoutTemplate',
    content: {
      visibleEntityTypes: ['domain', 'system', 'schema', 'dataset', 'column', 'pipeline', 'dashboard'],
      visibleRelationshipTypes: ['contains', 'produces', 'consumes'],
      defaultDepth: 5,
      maxDepth: 10,
      rootEntityTypes: ['domain', 'system'],
    },
    layout: {
      type: 'reference', // New layout type for horizontal layer view
      graphLayout: {
        algorithm: 'dagre',
        direction: 'LR',
        nodeSpacing: 40,
        levelSpacing: 200,
      },
      lod: {
        enabled: false,
        levels: [],
      },
    },
    filters: {
      entityTypeFilters: [],
      fieldFilters: [],
      searchableFields: ['name', 'description', 'owner'],
      quickFilters: [],
    },
    entityOverrides: {
      domain: { size: 'xl' },
      system: { size: 'lg' },
    },
    grouping: undefined,
    isDefault: false,
    isPublic: true,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },

  // Impact Analysis View
  {
    id: 'impact-view',
    name: 'Impact Analysis',
    description: 'Focus on downstream dependencies and change impact',
    icon: 'ArrowDownRight',
    content: {
      visibleEntityTypes: ['dataset', 'pipeline', 'dashboard', 'column'],
      visibleRelationshipTypes: ['produces', 'consumes', 'transforms'],
      defaultDepth: 10,
      maxDepth: 20,
      rootEntityTypes: ['dataset', 'column'],
    },
    layout: {
      type: 'graph',
      graphLayout: {
        algorithm: 'dagre',
        direction: 'LR',
        nodeSpacing: 60,
        levelSpacing: 150,
      },
      lod: {
        enabled: false,
        levels: [],
      },
    },
    filters: {
      entityTypeFilters: [],
      fieldFilters: [],
      searchableFields: ['name', 'urn'],
      quickFilters: [
        { id: 'critical', label: 'Critical Path', icon: 'AlertTriangle', filter: [{ field: 'criticality', operator: 'equals', value: 'high' }] },
      ],
    },
    entityOverrides: {
      dataset: { color: '#ef4444' },  // Highlight datasets in red for impact visibility
    },
    grouping: undefined,
    isDefault: false,
    isPublic: true,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },

  // Column Lineage View - Fine-grained attribute tracking
  {
    id: 'column-lineage',
    name: 'Column Lineage',
    description: 'Granular attribute-level lineage tracking',
    icon: 'Columns3',
    content: {
      visibleEntityTypes: ['dataset', 'column'],
      visibleRelationshipTypes: ['produces', 'consumes', 'transforms', 'derives'],
      defaultDepth: 5,
      maxDepth: 15,
      rootEntityTypes: ['column'],
    },
    layout: {
      type: 'graph',
      graphLayout: {
        algorithm: 'dagre',
        direction: 'LR',
        nodeSpacing: 30,
        levelSpacing: 200,
      },
      lod: {
        enabled: false,
        levels: [],
      },
    },
    filters: {
      entityTypeFilters: [],
      fieldFilters: [],
      searchableFields: ['name', 'dataType', 'urn'],
      quickFilters: [
        { id: 'string', label: 'Strings', icon: 'Type', filter: [{ field: 'dataType', operator: 'contains', value: 'string' }] },
        { id: 'numeric', label: 'Numeric', icon: 'Hash', filter: [{ field: 'dataType', operator: 'in', value: ['int', 'float', 'decimal', 'number'] }] },
      ],
    },
    entityOverrides: {
      column: { size: 'sm' },
      dataset: { size: 'md', shape: 'rounded' },
    },
    grouping: {
      enabled: true,
      groupByField: 'dataset',
      groupVisual: {
        showHeader: true,
        collapsible: true,
      },
    },
    isDefault: false,
    isPublic: true,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]

/**
 * Default Workspace Schema
 */
export const defaultWorkspaceSchema: WorkspaceSchema = {
  id: 'default-workspace',
  name: 'NexusLineage Workspace',
  version: '1.1.1',  // Bumped to force schema refresh with new views
  entityTypes: defaultEntityTypes,
  relationshipTypes: defaultRelationshipTypes,
  views: defaultViews,
  defaultViewId: 'lineage-view',
  globalVisuals: {
    theme: 'system',
    accentColor: '#6366f1',
    fontFamily: 'Inter',
    borderRadius: 'md',
    showConfidenceScores: true,
    animationsEnabled: true,
  },
}

