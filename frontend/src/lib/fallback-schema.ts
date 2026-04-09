/**
 * FALLBACK ONLY — used when the backend is unreachable and the schema store
 * has no cached data. The backend ontology (served via GET /graph/metadata/schema)
 * is always preferred. Do not add new types here.
 *
 * This provides the minimum entity/relationship definitions needed for the UI
 * to render a basic graph without crashing. When the real schema loads,
 * loadFromBackend() overwrites this completely.
 */
import type { WorkspaceSchema, EntityTypeSchema, RelationshipTypeSchema, ViewConfiguration } from '@/types/schema'

const fallbackEntityTypes: EntityTypeSchema[] = [
  {
    id: 'domain',
    name: 'Domain',
    pluralName: 'Domains',
    description: 'Top-level business domain',
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
    ],
    hierarchy: {
      level: 0,
      canContain: [],
      canBeContainedBy: [],
      defaultExpanded: true,
      rollUpFields: [],
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
    ],
    hierarchy: {
      level: 3,
      canContain: [],
      canBeContainedBy: [],
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
    ],
    hierarchy: {
      level: 4,
      canContain: [],
      canBeContainedBy: [],
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
  {
    id: 'ghost',
    name: 'More',
    pluralName: 'More',
    description: 'Pagination indicator',
    visual: {
      icon: 'MoreHorizontal',
      color: '#64748b',
      shape: 'rounded',
      size: 'sm',
      borderStyle: 'dashed',
      showInMinimap: false,
    },
    fields: [],
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

const fallbackRelationshipTypes: RelationshipTypeSchema[] = [
  {
    id: 'contains',
    name: 'Contains',
    description: 'Parent contains child (hierarchy)',
    sourceTypes: [],
    targetTypes: [],
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

const fallbackViews: ViewConfiguration[] = []

export const fallbackWorkspaceSchema: WorkspaceSchema = {
  id: 'fallback',
  name: 'Fallback Schema',
  version: '2.0.0',
  entityTypes: fallbackEntityTypes,
  relationshipTypes: fallbackRelationshipTypes,
  views: fallbackViews,
  defaultViewId: '',
  globalVisuals: {
    theme: 'system',
    accentColor: '#6366f1',
    fontFamily: 'Inter',
    borderRadius: 'md',
    showConfidenceScores: true,
    animationsEnabled: true,
  },
  // Intentionally empty — edge classification MUST come from the backend ontology.
  containmentEdgeTypes: [],
  lineageEdgeTypes: [],
  rootEntityTypes: [],
}
