/**
 * Verb-driven question templates for the SearchMapPanel.
 *
 * Each template is a small spec: a label the user reads ("Show all
 * datasets"), zero or more typed inputs the user fills in (entity-type
 * dropdown, free text, property key, etc.), and a `build()` that
 * compiles to a SearchQuery. The panel renders the template list, the
 * inputs for the selected template, and the build()-produced query is
 * fed to useAdvancedSearch.
 *
 * This is the *business-user* surface — no JSON, no predicate-tree
 * vocabulary, no aggregation/options jargon. The power-user dev panel
 * is still there for raw-JSON power.
 *
 * Adding a template: append to TEMPLATES below. Each template owns its
 * own input set, default values, and the SearchQuery shape it emits.
 */
import type { SearchQuery } from '@/types/search'

/** A single user-fillable parameter on a template. */
export type TemplateInput =
    | {
          name: string
          kind: 'text'
          label: string
          placeholder?: string
          defaultValue?: string
      }
    | {
          name: string
          kind: 'select'
          label: string
          options: { value: string; label: string }[]
          defaultValue?: string
      }
    | {
          name: string
          kind: 'number'
          label: string
          defaultValue?: number
          min?: number
          max?: number
      }

export interface TemplateContext {
    /** Entity types known in the current view (used to populate dropdowns). */
    knownEntityTypes: string[]
}

export interface SearchTemplate {
    id: string
    /** Verb-style label shown to the user. Keep short. */
    label: string
    /** One-line explanation shown beneath the label. */
    description: string
    /** Lucide icon name (e.g. 'BarChart3', 'Layers', 'Search'). Rendered via DynamicIcon. */
    icon: string
    inputs: TemplateInput[]
    /** Compile the filled inputs into a SearchQuery. */
    build: (inputs: Record<string, string | number>) => SearchQuery
}

/* -------------------------------------------------------------------------- */

export const TEMPLATES: SearchTemplate[] = [
    {
        id: 'overview-by-type',
        label: 'Overview by entity type',
        description: 'Count every node in scope, grouped by what kind of entity it is.',
        icon: 'PieChart',
        inputs: [],
        build: () => ({
            predicate: { kind: 'hasProperty', key: 'urn' },
            options: {
                results: 'aggregates',
                aggregations: [{ by: 'entityType', maxBuckets: 50 }],
            },
        }),
    },
    {
        id: 'overview-by-layer',
        label: 'Layout by layer',
        description: 'Bucket every node by the value of a property like "layer".',
        icon: 'Layers',
        inputs: [
            {
                name: 'propertyKey',
                kind: 'text',
                label: 'Property to bucket by',
                placeholder: 'layer',
                defaultValue: 'layer',
            },
        ],
        build: (inputs) => ({
            predicate: { kind: 'hasProperty', key: String(inputs.propertyKey || 'layer') },
            options: {
                results: 'aggregates',
                aggregations: [
                    {
                        by: 'property',
                        propertyKey: String(inputs.propertyKey || 'layer'),
                        maxBuckets: 30,
                        sampleHitsPerBucket: 3,
                    },
                ],
            },
        }),
    },
    {
        id: 'find-all-of-type',
        label: 'Find all of one entity type',
        description: 'List every node of a chosen type — datasets, containers, etc.',
        icon: 'List',
        inputs: [
            {
                name: 'entityType',
                kind: 'select',
                label: 'Entity type',
                options: [],
                defaultValue: 'dataset',
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'entityType', op: 'in',
                values: [String(inputs.entityType || 'dataset')],
            },
            options: {
                results: 'hits',
                pageSize: 50,
                includeAncestorPath: true,
                sort: 'displayName', sortDir: 'asc',
            },
        }),
    },
    {
        id: 'name-contains',
        label: 'Find by name',
        description: 'Substring search on the display name. Case-insensitive.',
        icon: 'Search',
        inputs: [
            {
                name: 'text',
                kind: 'text',
                label: 'Name contains',
                placeholder: 'customer',
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'text', target: 'name',
                value: String(inputs.text || ''), match: 'substring',
            },
            options: {
                results: 'hits',
                pageSize: 50,
                includeAncestorPath: true,
            },
        }),
    },
    {
        id: 'property-equals',
        label: 'Find by property value',
        description: 'Find every node where a property matches exactly.',
        icon: 'Equal',
        inputs: [
            {
                name: 'key',
                kind: 'text',
                label: 'Property name',
                placeholder: 'logicalType',
            },
            {
                name: 'value',
                kind: 'text',
                label: 'Value',
                placeholder: 'STRING',
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'property',
                key: String(inputs.key || ''),
                op: 'eq',
                value: String(inputs.value || ''),
            },
            options: {
                results: 'both',
                pageSize: 50,
                aggregations: [{ by: 'entityType' }],
            },
        }),
    },
    {
        id: 'biggest-by-property',
        label: 'Top N by numeric property',
        description: 'Sort by a numeric property like rowCount, biggest first.',
        icon: 'TrendingUp',
        inputs: [
            {
                name: 'entityType',
                kind: 'select',
                label: 'Entity type',
                options: [],
                defaultValue: 'dataset',
            },
            {
                name: 'sortProperty',
                kind: 'text',
                label: 'Sort by property',
                placeholder: 'rowCount',
                defaultValue: 'rowCount',
            },
            {
                name: 'limit',
                kind: 'number',
                label: 'Show top N',
                defaultValue: 20,
                min: 1,
                max: 200,
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'group',
                op: 'and',
                children: [
                    {
                        kind: 'entityType', op: 'in',
                        values: [String(inputs.entityType || 'dataset')],
                    },
                    {
                        kind: 'hasProperty',
                        key: String(inputs.sortProperty || 'rowCount'),
                    },
                ],
            },
            options: {
                results: 'hits',
                pageSize: Number(inputs.limit ?? 20),
                sortProperty: String(inputs.sortProperty || 'rowCount'),
                sortDir: 'desc',
                includeAncestorPath: true,
            },
        }),
    },
    {
        id: 'tag-matches',
        label: 'Find by tag',
        description: 'All nodes tagged with a value, rolled up by domain.',
        icon: 'Tag',
        inputs: [
            {
                name: 'tag',
                kind: 'text',
                label: 'Tag',
                placeholder: 'PII',
                defaultValue: 'PII',
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'tag', op: 'has',
                values: [String(inputs.tag || 'PII')],
            },
            options: {
                results: 'both',
                pageSize: 50,
                aggregations: [
                    {
                        by: 'ancestorType',
                        ancestorEntityTypes: ['domain'],
                        maxBuckets: 20,
                        sampleHitsPerBucket: 3,
                    },
                ],
                includeAncestorPath: true,
            },
        }),
    },
    {
        id: 'has-property',
        label: 'Nodes that have a property',
        description: 'Discover which nodes carry a given metadata field.',
        icon: 'CheckCircle2',
        inputs: [
            {
                name: 'key',
                kind: 'text',
                label: 'Property name',
                placeholder: 'owner',
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'hasProperty', key: String(inputs.key || ''),
            },
            options: {
                results: 'both',
                pageSize: 50,
                aggregations: [{ by: 'entityType' }],
            },
        }),
    },
]

/** Look up a template by id. Throws — caller should always pass a valid id. */
export function findTemplate(id: string): SearchTemplate {
    const t = TEMPLATES.find((t) => t.id === id)
    if (!t) throw new Error(`Unknown template: ${id}`)
    return t
}

/** Initial input values for a template (driven by per-input defaults). */
export function defaultInputs(template: SearchTemplate): Record<string, string | number> {
    const out: Record<string, string | number> = {}
    for (const input of template.inputs) {
        if (input.kind === 'number') {
            out[input.name] = input.defaultValue ?? 0
        } else {
            out[input.name] = input.defaultValue ?? ''
        }
    }
    return out
}
