import type { ViewLayerConfig } from '@/types/schema'

// Structural fallback layers — used only when a view has no saved layer config.
// entityTypes is intentionally empty: the user assigns types via the wizard's
// LayoutStep entity-type picker, which is scoped to the active data source's ontology.
export const defaultReferenceModelLayers: ViewLayerConfig[] = [
  {
    id: 'source',
    name: 'Source Layer',
    description: 'Raw data sources and ingestion',
    icon: 'Database',
    color: '#8b5cf6',
    entityTypes: [],
    order: 0,
  },
  {
    id: 'staging',
    name: 'Staging',
    description: 'Raw data landing zone',
    icon: 'Inbox',
    color: '#06b6d4',
    entityTypes: [],
    order: 1,
  },
  {
    id: 'refinery',
    name: 'Refinery',
    description: 'Transformation and processing',
    icon: 'Workflow',
    color: '#f59e0b',
    entityTypes: [],
    order: 2,
  },
  {
    id: 'consumption',
    name: 'Consumption',
    description: 'Analytics and reporting',
    icon: 'BarChart3',
    color: '#22c55e',
    entityTypes: [],
    order: 3,
  },
]
