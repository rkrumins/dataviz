/**
 * Visual harness for the Context View canvas — the REAL `ContextViewCanvas`,
 * its header, columns, status stack, menus and toasts, against an in-memory
 * graph. No API, no auth. It exists because the canvas's layering cannot be
 * judged anywhere else: jsdom has no layout and no stacking, so a notice that
 * a column header paints over is "in the document" there.
 *
 *   npm run harness
 *   open http://localhost:5199/context-view-harness.html?fixture=top&theme=dark
 *
 *   fixture   `top`    every notice the top of the canvas can show at once
 *                      (`searchMode=isolate|hide` for the header search token's others)
 *             `trace`  a trace walking (its capsule), with the provider pill
 *             `scale`  a warehouse of `containers` schemas × `children` tables
 *                      (default 500 × 200), to expand a level at a time
 *             `create` a draft whose columns each add differently: Finance (a
 *                      column mapped to the Finance domain), Domains (several
 *                      top-level domains) and Apps (a type that needs a domain)
 *   theme     `dark` for the dark palette
 *   persona   `business` (default `technical`)
 *   latency   ms each child page waits (default 0; `scale` defaults to 120)
 *   batch     `0` for a provider without `getChildrenBatch` (an older server)
 *   typed     a search typed in the header box is answered, by name, over the
 *             warehouse's schemas and tables and the dashboards (the search
 *             panel asks the API for more than that, so leave it shut)
 *
 * `window.__harness` reports the child-page requests the canvas made (single
 * pages, and batches of first pages) and the most it ever had in flight at
 * once — the expansion's bound, read off the real queue rather than asserted
 * about it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { ContextViewCanvas } from '../components/canvas/context-view/ContextViewCanvas'
import { CanvasProviderStatePill } from '../components/canvas/CanvasProviderStateOverlay'
import { CanvasProviderPillSlot } from '../components/canvas/canvasProviderPill'
import { NotificationStack } from '../components/ui/notifications'
import { specFor, visibilityOf } from '../features/narrow/model'
import { useNarrowStore } from '../features/narrow/narrowStore'
import { toCanvasNode } from '../lib/canvasNodeMapper'
import { ProviderOverride } from '../providers/GraphProviderContext'
import { RemoteGraphProvider } from '../providers/RemoteGraphProvider'
import { useBranchStore } from '../store/branchStore'
import { useCanvasStore, type LineageEdge } from '../store/canvas'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePersonaStore } from '../store/persona'
import { usePreferencesStore } from '../store/preferences'
import { useSchemaStore } from '../store/schema'
import { useSearchStore, type CanvasFilterMode } from '../store/searchStore'
import type { GraphDataProvider, GraphNode } from '../providers/GraphDataProvider'
import type { MembershipResult } from '../types/membership'

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') ?? 'top'
const dark = params.get('theme') === 'dark'
const persona = params.get('persona') === 'business' ? 'business' : 'technical'
const CONTAINERS = Number(params.get('containers') ?? (fixture === 'scale' ? 500 : 12))
const CHILDREN = Number(params.get('children') ?? (fixture === 'scale' ? 200 : 8))
const LATENCY = Number(params.get('latency') ?? (fixture === 'scale' ? 120 : 0))
const BATCH = params.get('batch') !== '0'

MotionGlobalConfig.skipAnimations = true
document.documentElement.classList.toggle('dark', dark)
document.body.style.margin = '0'

// ── The graph ─────────────────────────────────────────────────────────────
// Warehouse › schema_i › table_i_j › column_i_j_k, built on demand from the
// id: a 100,000-table warehouse costs nothing until a page of it is asked for.
const COLUMNS = 3
const node = (urn: string, displayName: string, entityType: string, childCount: number): GraphNode =>
  ({ urn, displayName, entityType, childCount, properties: {} }) as unknown as GraphNode
const CREATE = fixture === 'create'
const DOMAINS = ['Finance', 'Sales', 'Marketing', 'Operations', 'People']
const APPS: Record<string, string[]> = { Finance: ['Billing', 'Ledger', 'Payroll'], Sales: ['CRM', 'Quotes'], Marketing: ['Campaigns'] }
const ROOTS: GraphNode[] = CREATE ? DOMAINS.map((d) => node(`dom:${d}`, d, 'domain', APPS[d]?.length ?? 0)) : [
  node('wh', 'Warehouse', 'warehouse', CONTAINERS),
  node('lake', 'Data Lake', 'warehouse', 4),
  ...['Revenue', 'Churn', 'Pipeline', 'Retention'].map((name, i) => node(`d${i}`, `${name} dashboard`, 'dashboard', 0)),
]
function childrenOf(urn: string): GraphNode[] {
  if (CREATE) return (APPS[urn.replace(/^dom:/, '')] ?? []).map((a) => node(`app:${a}`, a, 'app', 0))
  if (urn === 'wh') return Array.from({ length: CONTAINERS }, (_, i) => node(`s${i}`, `schema_${String(i).padStart(3, '0')}`, 'schema', CHILDREN))
  if (urn === 'lake') return Array.from({ length: 4 }, (_, i) => node(`lk${i}`, `bucket_${i}`, 'schema', 0))
  const schema = urn.match(/^s(\d+)$/)
  if (schema) return Array.from({ length: CHILDREN }, (_, j) => node(`t${schema[1]}_${j}`, `table_${schema[1]}_${String(j).padStart(3, '0')}`, 'table', COLUMNS))
  const table = urn.match(/^t(\d+)_(\d+)$/)
  if (table) return Array.from({ length: COLUMNS }, (_, k) => node(`c${table[1]}_${table[2]}_${k}`, ['id', 'amount', 'created_at'][k]!, 'column', 0))
  return []
}
function parentOf(urn: string): string | undefined {
  if (CREATE) {
    const d = Object.keys(APPS).find((k) => APPS[k].includes(urn.replace(/^app:/, '')))
    return urn.startsWith('app:') && d ? `dom:${d}` : undefined
  }
  if (/^s\d+$/.test(urn)) return 'wh'
  if (/^lk\d+$/.test(urn)) return 'lake'
  const t = urn.match(/^t(\d+)_\d+$/)
  if (t) return `s${t[1]}`
  const c = urn.match(/^c(\d+)_(\d+)_\d+$/)
  return c ? `t${c[1]}_${c[2]}` : undefined
}
function lookup(urn: string): GraphNode | undefined {
  const root = ROOTS.find((r) => r.urn === urn)
  if (root) return root
  const parent = parentOf(urn)
  return parent ? childrenOf(parent).find((c) => c.urn === urn) : undefined
}

const LAYERS = CREATE ? [
  { id: 'fin', name: 'Finance', color: '#10b981', order: 0, entityTypes: [], rules: [], anchorUrn: 'dom:Finance' },
  { id: 'domains', name: 'Domains', color: '#6366f1', order: 1, entityTypes: ['domain'], rules: [] },
  { id: 'apps', name: 'Apps', color: '#f59e0b', order: 2, entityTypes: ['app'], rules: [] },
] : [
  { id: 'sources', name: 'Sources', color: '#6366f1', order: 0, entityTypes: [], rules: [] },
  { id: 'reports', name: 'Reports', color: '#f59e0b', order: 1, entityTypes: [], rules: [] },
]
const ASSIGNMENTS: Record<string, { layerId: string }> = CREATE
  ? Object.fromEntries(DOMAINS.map((d) => [`dom:${d}`, { layerId: d === 'Finance' ? 'fin' : 'domains' }]))
  : {
    wh: { layerId: 'sources' }, lake: { layerId: 'sources' },
    d0: { layerId: 'reports' }, d1: { layerId: 'reports' }, d2: { layerId: 'reports' }, d3: { layerId: 'reports' },
  }
// `create`'s ontology: a Domain holds Apps and Data Platforms; an App holds Services.
const type = (id: string, name: string, icon: string, color: string, level: number, canContain: string[], canBeContainedBy: string[]) => ({
  id, name, pluralName: `${name}s`, description: '', visual: { icon, color, shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  fields: [], behavior: { selectable: true, draggable: true, expandable: canContain.length > 0, traceable: true, collapsible: true },
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})
const ENTITY_TYPES = CREATE ? [
  type('domain', 'Domain', 'Building2', '#6366f1', 0, ['app', 'dataPlatform'], []),
  type('app', 'App', 'AppWindow', '#10b981', 1, ['service'], ['domain']),
  type('dataPlatform', 'Data Platform', 'Database', '#0ea5e9', 1, [], ['domain']),
  type('service', 'Service', 'Server', '#f59e0b', 2, [], ['app']),
] : []
const RELATIONSHIP_TYPES = CREATE ? [{
  id: 'CONTAINS', name: 'Contains', sourceTypes: [], targetTypes: [], isContainment: true, isLineage: false,
  visual: { strokeColor: '#94a3b8', strokeWidth: 1, strokeStyle: 'solid', animated: false, curveType: 'bezier' },
}] : []

// ── The network ───────────────────────────────────────────────────────────
const report = { childPages: 0, batches: 0, inFlight: 0, maxInFlight: 0 }
;(window as unknown as { __harness: typeof report }).__harness = report
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function request<T>(read: () => T): Promise<T> {
  report.inFlight += 1
  report.maxInFlight = Math.max(report.maxInFlight, report.inFlight)
  try {
    if (LATENCY) await wait(LATENCY)
    return read()
  } finally {
    report.inFlight -= 1
  }
}
function pageOf(urn: string, offset = 0, limit = 100) {
  const all = childrenOf(urn)
  const page = all.slice(offset, offset + limit)
  const next = offset + page.length
  return {
    children: page,
    containmentEdges: page.map((c) => ({ id: `c:${urn}>${c.urn}`, sourceUrn: urn, targetUrn: c.urn, edgeType: 'CONTAINS' })),
    lineageEdges: [],
    totalChildren: all.length,
    hasMore: next < all.length,
    nextOffset: next < all.length ? next : null,
    nextCursor: null,
  }
}

const provider = {
  scopeKey: 'harness',
  getChildren: async (urn: string) => childrenOf(urn),
  getChildrenWithEdges: async (urn: string, opts?: { offset?: number; limit?: number }) => {
    report.childPages += 1
    return request(() => pageOf(urn, opts?.offset, opts?.limit))
  },
  ...(BATCH ? {
    getChildrenBatch: async (parents: Array<{ urn: string; offset?: number }>, opts?: { limit?: number }) => {
      report.batches += 1
      return request(() => Object.fromEntries(parents.map((p) => [p.urn, pageOf(p.urn, p.offset, opts?.limit)])))
    },
  } : {}),
  getParent: async (urn: string) => { const p = parentOf(urn); return p ? lookup(p) ?? null : null },
  getNodes: async (q?: { urns?: string[] }) => (q?.urns ?? []).map(lookup).filter((n): n is GraphNode => !!n),
  getEdges: async () => [],
  getEdgesBetween: async (urns: string[]) => {
    const asked = new Set(urns)
    return urns.filter((u) => asked.has(parentOf(u) ?? ''))
      .map((u) => ({ id: `c:${parentOf(u)}>${u}`, sourceUrn: parentOf(u)!, targetUrn: u, edgeType: 'CONTAINS' }))
  },
  getAggregatedEdges: async () => ({ aggregatedEdges: [], totalSourceEdges: 0 }),
  getAncestorChains: async (urns: string[]) => Object.fromEntries(urns.map((u) => {
    const chain: string[] = []
    for (let p = parentOf(u); p; p = parentOf(p)) chain.push(p)
    return [u, chain]
  })),
  // A walk that never lands: the capsule stays up, narrating.
  traceClosure: () => new Promise<never>(() => {}),
  computeLayerAssignments: async () => ({
    assignments: new Map(Object.entries(ASSIGNMENTS).map(([entityId, a]) => [entityId, { entityId, layerId: a.layerId, isInherited: false }])),
    parentMap: new Map(),
    edges: [],
    unassignedEntityIds: [],
    stats: { totalNodes: ROOTS.length, assignedNodes: ROOTS.length, computeTimeMs: 0 },
  }),
} as unknown as GraphDataProvider

// `typed`: the header box's own search, answered by name. The session asks
// only the live API, so for this fixture the in-memory provider passes for it.
if (params.has('typed')) {
  const searchable = [...ROOTS, ...childrenOf('wh'), ...childrenOf('wh').flatMap((s) => childrenOf(s.urn))]
  const ancestry = (urn: string) => {
    const path = []
    for (let p = parentOf(urn); p; p = parentOf(p)) {
      const n = lookup(p)!
      path.unshift({ urn: n.urn, displayName: n.displayName, entityType: n.entityType })
    }
    return path
  }
  Object.assign(provider, {
    searchAdvanced: async (query: { predicate: unknown }) => {
      const text = (JSON.stringify(query.predicate).match(/"value":"([^"]*)"/)?.[1] ?? '').toLowerCase()
      const hits = searchable
        .filter((n) => text && n.displayName.toLowerCase().includes(text))
        .map((n) => ({ node: n, ancestorPath: ancestry(n.urn), highlights: [] }))
      return {
        hits, aggregates: [], truncated: false, candidateCount: hits.length, totalCount: hits.length,
        deadlineExceeded: false, elapsedMs: 4, cacheHit: false,
      }
    },
  })
  const plain = Function.prototype[Symbol.hasInstance]
  Object.defineProperty(RemoteGraphProvider, Symbol.hasInstance, {
    value: (o: unknown) => o === provider || plain.call(RemoteGraphProvider, o),
  })
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.includes('/api/')) return realFetch(input, init)
  const view = {
    id: 'harness-view',
    config: { layout: { type: 'reference', referenceLayout: { layers: LAYERS, assignments: ASSIGNMENTS } }, content: { entityScope: 'curated' } },
  }
  const body = url.includes('/api/v1/views/')
    ? (url.includes('/library') ? { viewId: view.id, displayRules: [], savedQueries: [], canEdit: true } : view)
    : {}
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof globalThis.fetch

// ── The stores ────────────────────────────────────────────────────────────
usePersonaStore.setState({ mode: persona })
usePreferencesStore.setState({ canvasDensity: 'comfortable' } as never)
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, viewMembershipEnabled: true, ...(CREATE ? { editModeEnabled: true, versioningEnabled: true } : {}) } } as never)
// `create` edits: a draft is open.
useBranchStore.setState((CREATE
  ? { workspaceId: 'harness-ws', dataSourceId: null, viewId: 'harness-view', currentBranchId: 'harness-branch' }
  : { workspaceId: null, dataSourceId: null, viewId: null, currentBranchId: null }) as never)
useSchemaStore.setState({
  activeViewId: 'harness-view',
  schema: {
    id: 'harness', name: 'harness', version: '1',
    entityTypes: ENTITY_TYPES, relationshipTypes: RELATIONSHIP_TYPES, globalVisuals: {},
    containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['TRANSFORMS', 'AGGREGATED'],
    rootEntityTypes: CREATE ? ['domain'] : [], defaultViewId: 'harness-view',
    views: [{
      id: 'harness-view', name: 'Harness View', workspaceId: 'harness-ws',
      content: { visibleEntityTypes: [], visibleRelationshipTypes: [], defaultDepth: 3, maxDepth: 10, rootEntityTypes: [], entityScope: 'curated' },
      layout: { type: 'reference', referenceLayout: { layers: LAYERS, assignments: ASSIGNMENTS } },
      filters: {}, entityOverrides: {}, isDefault: true,
    }],
  },
} as never)
const store = useCanvasStore.getState()
store.setGraph(ROOTS.map((n) => toCanvasNode(n)), [] as LineageEdge[])
store.setHydrationPhase('complete')
store.setHydrationStatus('ready')

if (fixture === 'top') {
  // An edge read that failed: its banner, in flow at the very top.
  useCanvasStore.setState({ edgeFetchFailures: 1 })
  // A narrowing, whose chip sat UNDER the column headers.
  const result: MembershipResult = {
    specHash: 'h', members: [{ urn: 'wh', why: ['seed'] }, { urn: 'd0', why: ['downstream'] }] as never, wholeSubtree: ['wh'], chains: {},
    counts: { seeds: 1, inside: null, upstream: 40, downstream: 0, partnerInside: 0, total: 412 },
    missingSeeds: 0, truncated: [], dataVersion: '', elapsedMs: 0,
  }
  useNarrowStore.setState({
    viewId: 'harness-view',
    applied: { spec: specFor({ urns: ['wh'] }, { children: 'all', upstream: 'all' }), seedsLabel: 'Warehouse', result, visibility: visibilityOf(result) },
  })
  // A search left on the canvas with its panel closed (`searchMode` picks how it filters).
  useSearchStore.setState({
    viewId: 'harness-view', matchUrnSet: new Set(['wh', 'd0']), orderedMatchUrns: ['wh', 'd0'],
    canvasFilterMode: (params.get('searchMode') ?? 'highlight') as CanvasFilterMode,
  } as never)
}

// The pill CanvasRouter hands a canvas that has data on it but a load that ended short.
const pill = fixture === 'top' || fixture === 'trace'
  ? <CanvasProviderStatePill state="slow" partial missingEntities={38} retrying onRetry={() => {}} />
  : null

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProviderOverride value={{
        provider, isLoading: false, error: null, scopeKind: 'ready',
        workspaceId: 'harness-ws', dataSourceId: null, providerReady: true, providerVersion: 1,
      } as never}>
        <div style={{ height: '100vh', width: '100vw' }} className="bg-canvas">
          <CanvasProviderPillSlot value={pill}>
            <ContextViewCanvas />
          </CanvasProviderPillSlot>
        </div>
        <NotificationStack />
      </ProviderOverride>
    </QueryClientProvider>
  </MemoryRouter>,
)

if (fixture === 'trace') {
  // Select a dashboard and press the header's Trace, as a reader does.
  setTimeout(() => {
    useCanvasStore.getState().selectNode('d0')
    setTimeout(() => {
      const button = [...document.querySelectorAll('button')].find((b) => /trace lineage/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))
      button?.click()
    }, 300)
  }, 600)
}
