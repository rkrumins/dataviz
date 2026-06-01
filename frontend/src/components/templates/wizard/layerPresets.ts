/**
 * Layer presets for the Template Wizard.
 *
 * These mirror the LAYER_TEMPLATES in
 * `components/views/LayerManager.tsx` but live as plain data (no JSX) so
 * they can be consumed from the wizard without dragging in the canvas
 * layer-editor's icon imports. If a future refactor unifies the two
 * surfaces, this file is the canonical source.
 */
import type { ViewLayerConfig } from '@/types/schema'

export interface LayerPreset {
    id: string
    name: string
    description: string
    icon: string
    accentColor: string
    layers: ViewLayerConfig[]
}

function mkLayer(
    id: string,
    name: string,
    color: string,
    description: string,
    order: number,
    icon = 'Layers',
): ViewLayerConfig {
    return {
        id,
        name,
        description,
        icon,
        color,
        entityTypes: [],
        order,
        sequence: order,
        showUnassigned: true,
    }
}

export const TEMPLATE_LAYER_PRESETS: LayerPreset[] = [
    {
        id: 'data-flow',
        name: 'Data Flow',
        description: '4-tier processing pipeline: Source → Transform → Curated → Consume',
        icon: 'Workflow',
        accentColor: '#6366f1',
        layers: [
            mkLayer('sources',   'Sources',   '#3B82F6', 'Raw data sources and ingestion', 0, 'Database'),
            mkLayer('transform', 'Transform', '#8B5CF6', 'Processing and transformation',  1, 'Workflow'),
            mkLayer('curated',   'Curated',   '#22C55E', 'Cleaned and validated datasets', 2, 'CheckCircle'),
            mkLayer('consume',   'Consume',   '#F97316', 'Analytics and reporting',         3, 'BarChart3'),
        ],
    },
    {
        id: 'medallion',
        name: 'Medallion',
        description: 'Bronze → Silver → Gold lakehouse architecture',
        icon: 'Layers',
        accentColor: '#A16207',
        layers: [
            mkLayer('bronze', 'Bronze', '#A16207', 'Raw landing zone',          0, 'HardDrive'),
            mkLayer('silver', 'Silver', '#64748B', 'Cleansed and conformed',    1, 'Filter'),
            mkLayer('gold',   'Gold',   '#EAB308', 'Business-ready aggregates', 2, 'Sparkles'),
        ],
    },
    {
        id: 'mesh',
        name: 'Data Mesh',
        description: 'Domain → Data Product → Consumer',
        icon: 'Boxes',
        accentColor: '#7c3aed',
        layers: [
            mkLayer('domain',       'Domain',       '#7c3aed', 'Business domain boundaries', 0, 'Boxes'),
            mkLayer('data-product', 'Data Product', '#2563eb', 'Self-serve data products',   1, 'Package'),
            mkLayer('consumer',     'Consumer',     '#059669', 'Consumers and applications', 2, 'Users'),
        ],
    },
    {
        id: 'etl',
        name: 'ETL Classic',
        description: 'Extract → Transform → Load',
        icon: 'GitBranch',
        accentColor: '#f59e0b',
        layers: [
            mkLayer('extract',   'Extract',   '#6366f1', 'Extract from source systems', 0, 'Download'),
            mkLayer('transform', 'Transform', '#f59e0b', 'Apply mappings and rules',    1, 'Workflow'),
            mkLayer('load',      'Load',      '#10b981', 'Load into targets',           2, 'Upload'),
        ],
    },
    {
        id: 'blank',
        name: 'Blank',
        description: 'Start with a single empty layer',
        icon: 'Sparkles',
        accentColor: '#475569',
        layers: [
            mkLayer('layer-1', 'Layer 1', '#6366f1', 'First layer', 0),
        ],
    },
]

export function findPreset(id: string): LayerPreset | undefined {
    return TEMPLATE_LAYER_PRESETS.find(p => p.id === id)
}
