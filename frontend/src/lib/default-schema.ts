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
 * Default Views — empty; all views are loaded from the Context Model API.
 */
const defaultViews: ViewConfiguration[] = []

/**
 * Default Workspace Schema
 */
export const defaultWorkspaceSchema: WorkspaceSchema = {
  id: 'default-workspace',
  name: 'NexusLineage Workspace',
  version: '1.1.2',  // Bumped to force schema refresh with new views
  entityTypes: defaultEntityTypes,
  relationshipTypes: defaultRelationshipTypes,
  views: defaultViews,
  defaultViewId: '',
  globalVisuals: {
    theme: 'system',
    accentColor: '#6366f1',
    fontFamily: 'Inter',
    borderRadius: 'md',
    showConfidenceScores: true,
    animationsEnabled: true,
  },
}

