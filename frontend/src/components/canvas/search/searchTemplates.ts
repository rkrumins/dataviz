/**
 * Verb-driven question templates for the SearchMapPanel.
 *
 * Each template is a small spec: a label the user reads ("Show all
 * datasets"), zero or more typed inputs the user fills in (entity-type
 * dropdown, free text, property key, etc.), and a `build()` that
 * compiles to a SearchQuery.
 *
 * This is the *business-user* surface — no JSON, no predicate-tree
 * vocabulary, no aggregation/options jargon.
 *
 * Architectural contract (W0):
 *   Templates produce a ``Predicate`` object that flows through the
 *   single canonical store at ``searchStore.draftPredicate`` via
 *   ``seedDraftPredicate``. Both the visual builder AND the JSON
 *   editor read the same draft. The user can therefore pick a
 *   template → switch to the JSON view → see the literal JSON the
 *   template produced → edit → run. No alternate path, no shadow
 *   state.
 *
 *   Zero-input templates are effectively constant ``Predicate``
 *   literals — their ``build()`` ignores its argument. Parametrised
 *   templates remain factory functions so the user's typed inputs
 *   can flow into the produced shape.
 *
 * Adding a template: append to TEMPLATES below.
 */
import type { SearchQuery, SearchScope } from '@/types/search'


/**
 * Templates emit a query *without* the required ``scope.viewId`` field —
 * they don't know which view the search panel is mounted in. The
 * ``useAdvancedSearch`` hook stamps ``scope.viewId`` (from its viewId
 * argument) onto every outgoing request. Templates may still set other
 * scope fields (e.g. ``entityTypes``) which the hook preserves.
 */
export type TemplateSearchQuery = Omit<SearchQuery, 'scope'> & {
    scope?: Omit<SearchScope, 'viewId'>
}

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
    /**
     * Surfaced as a one-click chip on the AskBar. Only set this for templates
     * that can run with their default inputs — featured chips submit directly
     * without showing a form, so any required field needs a usable default.
     */
    featured?: boolean
    /**
     * Short label used on the AskBar chip when ``featured`` is true. Falls
     * back to ``label`` if omitted. Chips are tight on space — prefer
     * 1-3 words.
     */
    chipLabel?: string
    /** Compile the filled inputs into a scope-less search request. The
     *  ``useAdvancedSearch`` hook stamps ``scope.viewId`` on top so the
     *  backend's ViewScopeResolver can enforce view boundaries. */
    build: (inputs: Record<string, string | number>) => TemplateSearchQuery
}

/* -------------------------------------------------------------------------- */

export const TEMPLATES: SearchTemplate[] = [
    {
        id: 'overview-by-type',
        label: 'Overview by entity type',
        description: 'Count every node in scope, grouped by what kind of entity it is.',
        icon: 'PieChart',
        featured: true,
        chipLabel: 'Overview',
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
        featured: true,
        chipLabel: 'All datasets',
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
                includeAncestorPath: true,
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
        featured: true,
        chipLabel: 'PII tagged',
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
                includeAncestorPath: true,
            },
        }),
    },
    /* --------------------------------------------------------------
     * Edge-shape templates — exposed the graph-shape predicates
     * (isOrphan / isLeaf / isRoot) and the new path / withinHops
     * surfaces as one-click questions. The compiler resolves
     * `edge_class='lineage'` against the live ontology so nothing
     * is hardcoded here.
     * -------------------------------------------------------------- */
    {
        id: 'find-orphans',
        label: 'Nodes with no lineage edges',
        description:
            'Disconnected nodes — no upstream producers, no downstream consumers. ' +
            'Lineage edges are resolved from the ontology of the data source.',
        icon: 'CircleOff',
        featured: true,
        chipLabel: 'No lineage',
        inputs: [
            {
                name: 'entityType',
                kind: 'text',
                label: 'Entity type (optional)',
                placeholder: 'dataset',
            },
        ],
        build: (inputs) => {
            const et = String(inputs.entityType || '').trim()
            const orphan = { kind: 'isOrphan', edgeClass: 'lineage' } as const
            return {
                predicate: et
                    ? {
                          kind: 'group', op: 'and', children: [
                              orphan,
                              { kind: 'entityType', op: 'in', values: [et] },
                          ],
                      }
                    : orphan,
                options: {
                    results: 'both',
                    pageSize: 50,
                    aggregations: [{ by: 'entityType' }],
                    includeAncestorPath: true,
                },
            }
        },
    },
    {
        id: 'find-leaves',
        label: 'Lineage leaves (no downstream)',
        description:
            'Nodes with no outgoing lineage edges — terminal data products. ' +
            'Lineage edges are resolved from the ontology.',
        icon: 'CornerDownRight',
        featured: true,
        chipLabel: 'No downstream',
        inputs: [],
        build: () => ({
            predicate: { kind: 'isLeaf', edgeClass: 'lineage' },
            options: {
                results: 'both',
                pageSize: 50,
                aggregations: [{ by: 'entityType' }],
                includeAncestorPath: true,
            },
        }),
    },
    {
        id: 'find-roots',
        label: 'Lineage roots (no upstream)',
        description:
            'Nodes with no incoming lineage edges — sources of truth. ' +
            'Lineage edges are resolved from the ontology.',
        icon: 'CornerLeftUp',
        featured: true,
        chipLabel: 'No upstream',
        inputs: [],
        build: () => ({
            predicate: { kind: 'isRoot', edgeClass: 'lineage' },
            options: {
                results: 'both',
                pageSize: 50,
                aggregations: [{ by: 'entityType' }],
                includeAncestorPath: true,
            },
        }),
    },
    {
        id: 'within-hops-of',
        label: 'Within N hops of a node',
        description:
            'Find everything reachable along lineage edges within the ' +
            'specified number of steps from an anchor URN.',
        icon: 'Radar',
        inputs: [
            {
                name: 'anchorUrn',
                kind: 'text',
                label: 'Anchor URN',
                placeholder: 'urn:li:dataset:orders',
            },
            {
                name: 'hops',
                kind: 'number',
                label: 'Max hops',
                defaultValue: 2, min: 1, max: 10,
            },
            {
                name: 'direction',
                kind: 'select',
                label: 'Direction',
                options: [
                    { value: 'out', label: 'Downstream' },
                    { value: 'in', label: 'Upstream' },
                    { value: 'both', label: 'Either way' },
                ],
                defaultValue: 'both',
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'withinHops',
                urns: [String(inputs.anchorUrn || '').trim()],
                hops: Math.max(1, Math.min(10, Number(inputs.hops) || 2)),
                direction:
                    (String(inputs.direction || 'both') as 'in' | 'out' | 'both'),
                edgeClass: 'lineage',
            },
            options: {
                results: 'both',
                pageSize: 50,
                aggregations: [{ by: 'entityType' }],
                includeAncestorPath: true,
            },
        }),
    },
    {
        id: 'path-between',
        label: 'Paths between two nodes',
        description:
            'Find every lineage path from a source URN to a target URN, ' +
            'up to a max hop length. Returns ordered node→edge→node ' +
            'sequences.',
        icon: 'Workflow',
        inputs: [
            {
                name: 'sourceUrn',
                kind: 'text',
                label: 'Source URN',
                placeholder: 'urn:li:dataset:orders',
            },
            {
                name: 'targetUrn',
                kind: 'text',
                label: 'Target URN',
                placeholder: 'urn:li:dataset:reporting',
            },
            {
                name: 'maxHops',
                kind: 'number',
                label: 'Max hops',
                defaultValue: 4, min: 1, max: 6,
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'path',
                sourceUrns: [String(inputs.sourceUrn || '').trim()],
                targetUrns: [String(inputs.targetUrn || '').trim()],
                maxHops: Math.max(1, Math.min(6, Number(inputs.maxHops) || 4)),
                edgeClass: 'lineage',
                direction: 'outgoing',
            },
            options: { results: 'paths' },
        }),
    },
    {
        id: 'path-high-confidence',
        label: 'High-confidence paths between two nodes',
        description:
            'Like "Paths between two nodes" but only counts edges whose ' +
            'confidence property exceeds the threshold. Surfaces only ' +
            'reliable lineage chains.',
        icon: 'ShieldCheck',
        inputs: [
            {
                name: 'sourceUrn',
                kind: 'text',
                label: 'Source URN',
                placeholder: 'urn:li:dataset:orders',
            },
            {
                name: 'targetUrn',
                kind: 'text',
                label: 'Target URN',
                placeholder: 'urn:li:dataset:reporting',
            },
            {
                name: 'minConfidence',
                kind: 'number',
                label: 'Minimum edge confidence',
                defaultValue: 0.9, min: 0, max: 1,
            },
            {
                name: 'maxHops',
                kind: 'number',
                label: 'Max hops',
                defaultValue: 4, min: 1, max: 6,
            },
        ],
        build: (inputs) => ({
            predicate: {
                kind: 'path',
                sourceUrns: [String(inputs.sourceUrn || '').trim()],
                targetUrns: [String(inputs.targetUrn || '').trim()],
                maxHops: Math.max(1, Math.min(6, Number(inputs.maxHops) || 4)),
                edgeClass: 'lineage',
                direction: 'outgoing',
                edgePredicate: {
                    kind: 'edgeProperty',
                    key: 'confidence',
                    op: 'gte',
                    value: Math.max(0, Math.min(1, Number(inputs.minConfidence) || 0.9)),
                },
            },
            options: { results: 'paths' },
        }),
    },
]

/** Look up a template by id. Throws — caller should always pass a valid id. */
export function findTemplate(id: string): SearchTemplate {
    const t = TEMPLATES.find((t) => t.id === id)
    if (!t) throw new Error(`Unknown template: ${id}`)
    return t
}

/** Templates surfaced as one-click chips on the AskBar. Order is preserved. */
export function featuredTemplates(): readonly SearchTemplate[] {
    return TEMPLATES.filter((t) => t.featured === true)
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
