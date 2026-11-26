/**
 * Visual harness for Property Manager's Properties tab — the view's entities' properties, and the
 * relationships' between them.
 *
 * Renders the REAL `PropertyManagerDrawer` (and the bulk dialog's host) against a provider whose
 * catalog requests are answered here, by subject, from a lineage view's realistic numbers. A draft
 * is open, so every change action is offered. `npm run harness:property-manager` opens the
 * Properties tab, switches to Relationships, opens a row or the bulk dialog, and writes PNGs to
 * .harness/.
 *
 *   npm run harness
 *   open http://localhost:5199/property-manager-harness.html?scene=relationships&theme=dark
 *
 *   scene   relationships (default) · reading (a read still running) · stale (read before the data
 *           changed) · empty (relationships that carry nothing) · unavailable (the provider answers
 *           501) · error (the read fails)
 *   theme   `dark` for the dark palette
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { PropertyManagerDrawer } from '../components/canvas/property-manager/PropertyManagerDrawer'
import { PropertyOpHost } from '../components/canvas/property-manager/PropertyOpHost'
import { ProviderOverride } from '../providers/GraphProviderContext'
import { RemoteGraphProvider } from '../providers/RemoteGraphProvider'
import { useAuthStore } from '../store/auth'
import { useBranchStore } from '../store/branchStore'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePreferencesStore } from '../store/preferences'
import { useSchemaStore } from '../store/schema'
import { useViewLibraryStore } from '../store/viewLibraryStore'
import { useWorkspacesStore } from '../store/workspaces'
import type { SearchCatalogProperty, SearchCatalogRequest, SearchCatalogResult } from '../types/search'


const params = new URLSearchParams(window.location.search)
const scene = params.get('scene') ?? 'relationships'
const dark = params.get('theme') === 'dark'

MotionGlobalConfig.skipAnimations = true

const VIEW = 'harness-view'
const p = (key: string, count: number, over: Partial<SearchCatalogProperty> = {}): SearchCatalogProperty => ({
    key, count, distinct: 0, distinctExact: true, byEntityType: {}, kinds: {}, values: [], residual: 0, ...over,
})
const v = (value: unknown, count: number, kind = typeof value === 'number' ? 'Integer' : typeof value === 'boolean' ? 'Boolean' : 'String') =>
    ({ value, kind, count })

/** A lineage view's relationships: jobs producing and consuming datasets, columns transformed into
 *  columns, containment, tags and glossary terms. */
const RELATIONSHIP_TYPES = [
    { id: 'TRANSFORMS', name: 'Transforms', color: '#6366f1', count: 14_820 },
    { id: 'PRODUCES', name: 'Produces', color: '#f97316', count: 6_210 },
    { id: 'CONSUMES', name: 'Consumes', color: '#0ea5e9', count: 5_930 },
    { id: 'CONTAINS', name: 'Contains', color: '#94a3b8', count: 3_410 },
    { id: 'TAGGED_WITH', name: 'Tagged with', color: '#d946ef', count: 620 },
    { id: 'DEFINED_BY', name: 'Defined by', color: '#10b981', count: 210 },
]
const RELATIONSHIPS = RELATIONSHIP_TYPES.reduce((n, t) => n + t.count, 0)

const RELATIONSHIP_PROPERTIES: SearchCatalogProperty[] = [
    p('confidence_source', 21_030, { kinds: { String: 21_030 }, distinct: 4,
        byEntityType: { TRANSFORMS: 14_820, PRODUCES: 3_300, CONSUMES: 2_910 },
        values: [v('parser', 15_480), v('manual', 3_120), v('inferred', 2_100), v('Parser', 330)] }),
    p('sla', 11_920, { kinds: { String: 11_920 }, distinct: 5, byEntityType: { PRODUCES: 6_210, CONSUMES: 5_710 },
        values: [v('4h', 6_400), v('1d', 3_900), v('15m', 1_200), v('4H', 300), v('1 d', 120)] }),
    p('pipeline', 11_840, { kinds: { String: 11_840 }, distinct: 1_840, distinctExact: false,
        byEntityType: { PRODUCES: 6_000, CONSUMES: 5_840 } }),
    p('retries', 6_210, { kinds: { Integer: 5_980, String: 230 }, distinct: 5, min: 0, max: 5, byEntityType: { PRODUCES: 6_210 },
        values: [v(3, 4_200), v(0, 1_100), v(5, 680), v('3', 200), v('n/a', 30)] }),
    p('lastRunAt', 5_930, { kinds: { String: 5_930 }, distinct: 940, distinctExact: true, byEntityType: { CONSUMES: 5_930 },
        values: [v('2026-11-24', 2_900), v('2026-11-23', 1_700), v('2026-11-22', 830)] }),
    p('certified', 820, { kinds: { Boolean: 820 }, distinct: 2, byEntityType: { DEFINED_BY: 210, TAGGED_WITH: 610 },
        values: [v(true, 640), v(false, 180)] }),
    p('transformSql', 410, { kinds: { String: 410 }, distinct: 410, distinctExact: true, residual: 410,
        byEntityType: { TRANSFORMS: 410 }, values: [v('SELECT order_id, amount FROM raw.orders', 12)] }),
]

const ENTITY_PROPERTIES: SearchCatalogProperty[] = [
    p('owner', 9_800, { kinds: { String: 9_800 }, distinct: 41, byEntityType: { dataset: 2_400, schemaField: 7_400 },
        values: [v('data-eng', 4_100), v('finance', 2_300), v('growth', 1_900)] }),
    p('tier', 2_400, { kinds: { String: 2_400 }, distinct: 3, byEntityType: { dataset: 2_400 },
        values: [v('gold', 900), v('silver', 1_000), v('bronze', 500)] }),
]

function result(over: Partial<SearchCatalogResult>): SearchCatalogResult {
    return {
        sessionId: 'harness', status: 'complete', stale: false, asOf: new Date(Date.now() - 4 * 60_000).toISOString(),
        entities: 0, entityTypes: [], properties: [], tags: [], ...over,
    }
}

const ENTITY_CATALOG = result({
    subject: 'entities', entities: 12_400, properties: ENTITY_PROPERTIES,
    entityTypes: [{ type: 'schemaField', count: 9_200 }, { type: 'dataset', count: 2_400 }, { type: 'dataJob', count: 800 }],
    tags: [{ tag: 'pii', count: 1_240 }, { tag: 'gold', count: 900 }],
})

function relationshipCatalog(): SearchCatalogResult {
    const all = result({
        subject: 'relationships', entities: RELATIONSHIPS, tagged: null, properties: RELATIONSHIP_PROPERTIES,
        entityTypes: RELATIONSHIP_TYPES.map((t) => ({ type: t.id, count: t.count })),
    })
    if (scene === 'reading') {
        // 42% of the way: about that share of each count, read so far.
        const part = (n: number) => Math.round(n * 0.42)
        return { ...all, status: 'running', entities: part(RELATIONSHIPS), progress: { scanned: 42, total: 100, matched: part(RELATIONSHIPS) },
            properties: RELATIONSHIP_PROPERTIES.slice(0, 4).map((prop) => ({ ...prop, count: part(prop.count),
                byEntityType: Object.fromEntries(Object.entries(prop.byEntityType).map(([t, n]) => [t, part(n)])),
                values: prop.values.map((x) => ({ ...x, count: part(x.count) })) })) }
    }
    if (scene === 'stale') return { ...all, stale: true, asOf: new Date(Date.now() - 3 * 3_600_000).toISOString() }
    if (scene === 'empty') return { ...all, properties: [] }
    return all
}

/** What the search builders discover, from the same fixtures: each entity type's and each
 *  relationship type's keys, with sample values. */
function discovery() {
    const samples = (props: SearchCatalogProperty[]) =>
        Object.fromEntries(props.map((prop) => [prop.key, prop.values.map((x) => x.value)]))
    const labels = Object.fromEntries(['Dataset', 'Table', 'Column'].map((label) => [label, {
        keys: ENTITY_PROPERTIES.map((prop) => prop.key), sampled: 200, valueSamplesByKey: samples(ENTITY_PROPERTIES),
    }]))
    const edges = Object.fromEntries(RELATIONSHIP_TYPES.map((t) => {
        const props = RELATIONSHIP_PROPERTIES.filter((prop) => t.id in prop.byEntityType)
        return [t.id, { keys: props.map((prop) => prop.key), sampled: Math.min(t.count, 5_000),
            valueSamplesByKey: samples(props),
            storedAs: Object.fromEntries(props.map((prop) => [prop.key, prop.residual ? 'json' : 'native'])) }]
    }))
    return { labels, edges, blobOnlyLabels: [], tagValues: [] }
}

class StatusError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
}

const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
Object.assign(provider, {
    fetch: async (path: string, opts: { body?: string; signal?: AbortSignal } = {}) => {
        if (path === '/search/counts') {
            // What a rule matches, counted: the editor's live "N will be styled".
            const asked = JSON.parse(opts.body ?? '{}') as { items?: Array<{ id: string }> }
            return { counts: Object.fromEntries((asked.items ?? []).map((item) =>
                [item.id, { count: 4_820, status: 'complete' }])) }
        }
        if (path === '/search/discover') return discovery()
        if (path !== '/search/catalog') return {}
        const body = JSON.parse(opts.body ?? '{}') as SearchCatalogRequest
        if (body.subject !== 'relationships') return ENTITY_CATALOG
        if (scene === 'unavailable') throw new StatusError('Not Implemented', 501)
        if (scene === 'error') throw new StatusError('The graph took too long to answer', 504)
        // A read still running: answered again and again, never further.
        if (scene === 'reading') await new Promise((r) => setTimeout(r, 400))
        return relationshipCatalog()
    },
})

// The view's display rules, read: none yet, and this viewer may add some.
useViewLibraryStore.setState({ viewId: VIEW, branchId: 'harness-draft', status: 'ready', error: null, canEdit: true,
    savedQueries: [], reusableChanges: [] } as never)

// A draft is open on a versioned data source: every change is offered.
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, editModeEnabled: true, versioningEnabled: true,
    semanticLayerEditMode: true } } as never)
// Who may edit the semantic layer, on a data source that has one: "Make it a field…" is offered.
useAuthStore.setState({ permissions: { sid: 'harness', global: ['system:admin'], ws: {} } } as never)
useWorkspacesStore.setState({ activeWorkspaceId: 'harness-ws', activeDataSourceId: 'harness-ds',
    workspaces: [{ id: 'harness-ws', name: 'Harness', dataSources: [{ id: 'harness-ds', label: 'Enterprise lineage',
        ontologyId: 'harness-layer', isPrimary: true }] }] } as never)
useBranchStore.setState({ workspaceId: 'harness-ws', dataSourceId: null, viewId: VIEW, graphId: 'harness-graph', currentBranchId: 'harness-draft' } as never)
useSchemaStore.setState({
    activeViewId: VIEW,
    schema: {
        id: 'harness', name: 'Harness', version: '1', entityTypes: [],
        relationshipTypes: RELATIONSHIP_TYPES.map((t) => ({
            id: t.id, name: t.name, sourceTypes: [], targetTypes: [], fields: [],
            visual: { strokeColor: t.color, strokeWidth: 2, strokeStyle: 'solid', animated: false, curveType: 'bezier' },
        })),
        views: [{
            id: VIEW, name: 'Enterprise lineage', workspaceId: 'harness-ws', content: {}, filters: {}, entityOverrides: {},
            isDefault: true, layout: {},
        }],
        defaultViewId: VIEW, containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['TRANSFORMS', 'PRODUCES', 'CONSUMES'],
    },
} as never)

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
// The data source's semantic layer, a draft version: a field is added to it in place.
queryClient.setQueryData(['ontology-def', 'harness-layer'], {
    id: 'harness-layer', name: 'Enterprise lineage', version: 4, isPublished: false, isSystem: false, deletedAt: null,
    entityTypeDefinitions: Object.fromEntries(['Dataset', 'Table', 'Column'].map((t) => [t, { name: t, fields: [] }])),
    relationshipTypeDefinitions: Object.fromEntries(RELATIONSHIP_TYPES.map((t) => [t.id, { name: t.name, fields: [] }])),
})


function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
    }, [setTheme])
    return (
        <MemoryRouter>
            <QueryClientProvider client={queryClient}>
                <ProviderOverride value={{
                    provider, isLoading: false, error: null, scopeKind: 'ready',
                    workspaceId: 'harness-ws', dataSourceId: 'harness-ds', providerReady: true, providerVersion: 1,
                } as never}>
                    <div className="fixed inset-0 flex flex-col bg-canvas-base text-ink">
                        <div className="h-11 shrink-0 flex items-center gap-3 px-4 border-b border-glass-border text-xs text-ink-muted">
                            <span className="font-display font-semibold text-ink">Enterprise lineage</span>
                            <span className="font-mono">scene={scene} · {dark ? 'dark' : 'light'}</span>
                        </div>
                        <div className="relative flex-1 min-h-0 flex">
                            <div className="flex-1 bg-[radial-gradient(circle,rgba(127,127,127,0.18)_1px,transparent_1px)] [background-size:18px_18px]" />
                            <PropertyManagerDrawer viewId={VIEW} open onClose={() => {}} onSearchPredicate={() => {}} />
                        </div>
                    </div>
                    <PropertyOpHost viewId={VIEW} knownEntityTypes={[]}
                        graphWrite={{ wsId: 'harness-ws', graphId: 'harness-graph', branchId: 'harness-draft' }} />
                </ProviderOverride>
            </QueryClientProvider>
        </MemoryRouter>
    )
}


createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Harness />
    </StrictMode>,
)
