/**
 * Visual harness for the Hierarchy canvas — the REAL `HierarchyCanvas`, its
 * toolbar, menus and toasts, against an in-memory warehouse. No API, no auth.
 * It exists to judge, in a real browser, what jsdom cannot: whether a tree of
 * thousands of rows scrolls, and how a level at a time reads.
 *
 *   npm run harness
 *   open http://localhost:5199/hierarchy-harness.html?theme=dark
 *
 *   containers  schemas in the warehouse (default 500)
 *   children    tables in each schema (default 200 — two pages each)
 *   theme       `dark` for the dark palette
 *   persona     `business` (default `technical`)
 *   latency     ms each child page waits (default 120)
 *
 * `window.__harness` reports the child-page requests the canvas made and the
 * most it ever had in flight at once, read off the real queue.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { HierarchyCanvas } from '../components/canvas/HierarchyCanvas'
import { NotificationStack } from '../components/ui/notifications'
import { toCanvasNode } from '../lib/canvasNodeMapper'
import { ProviderOverride } from '../providers/GraphProviderContext'
import { useBranchStore } from '../store/branchStore'
import { useCanvasStore, type LineageEdge } from '../store/canvas'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePersonaStore } from '../store/persona'
import { useSchemaStore } from '../store/schema'
import type { GraphDataProvider, GraphNode } from '../providers/GraphDataProvider'

const params = new URLSearchParams(window.location.search)
const dark = params.get('theme') === 'dark'
const persona = params.get('persona') === 'business' ? 'business' : 'technical'
const CONTAINERS = Number(params.get('containers') ?? 500)
const CHILDREN = Number(params.get('children') ?? 200)
const LATENCY = Number(params.get('latency') ?? 120)

MotionGlobalConfig.skipAnimations = params.get('motion') !== 'on'
document.documentElement.classList.toggle('dark', dark)
document.body.style.margin = '0'

// Warehouse › schema_i › table_i_j › column_i_j_k, built from the id on demand.
const COLUMNS = 3
const node = (urn: string, displayName: string, entityType: string, childCount: number): GraphNode =>
  ({ urn, displayName, entityType, childCount, properties: {} }) as unknown as GraphNode
const ROOTS: GraphNode[] = [
  node('wh', 'Warehouse', 'warehouse', CONTAINERS),
  node('lake', 'Data Lake', 'warehouse', 4),
]
function childrenOf(urn: string): GraphNode[] {
  if (urn === 'wh') return Array.from({ length: CONTAINERS }, (_, i) => node(`s${i}`, `schema_${String(i).padStart(3, '0')}`, 'schema', CHILDREN))
  if (urn === 'lake') return Array.from({ length: 4 }, (_, i) => node(`lk${i}`, `bucket_${i}`, 'schema', 0))
  const schema = urn.match(/^s(\d+)$/)
  if (schema) return Array.from({ length: CHILDREN }, (_, j) => node(`t${schema[1]}_${j}`, `table_${schema[1]}_${String(j).padStart(3, '0')}`, 'table', COLUMNS))
  const table = urn.match(/^t(\d+)_(\d+)$/)
  if (table) return Array.from({ length: COLUMNS }, (_, k) => node(`c${table[1]}_${table[2]}_${k}`, ['id', 'amount', 'created_at'][k]!, 'column', 0))
  return []
}
function parentOf(urn: string): string | undefined {
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

const report = { childPages: 0, inFlight: 0, maxInFlight: 0 }
;(window as unknown as { __harness: typeof report }).__harness = report
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const provider = {
  scopeKey: 'hierarchy-harness',
  getChildren: async (urn: string) => childrenOf(urn),
  getChildrenWithEdges: async (urn: string, opts?: { offset?: number; limit?: number }) => {
    report.childPages += 1
    report.inFlight += 1
    report.maxInFlight = Math.max(report.maxInFlight, report.inFlight)
    try {
      if (LATENCY) await wait(LATENCY)
      const all = childrenOf(urn)
      const offset = opts?.offset ?? 0
      const page = all.slice(offset, offset + (opts?.limit ?? 100))
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
    } finally {
      report.inFlight -= 1
    }
  },
  getParent: async (urn: string) => { const p = parentOf(urn); return p ? lookup(p) ?? null : null },
  getNodes: async (q?: { urns?: string[] }) => (q?.urns ?? []).map(lookup).filter((n): n is GraphNode => !!n),
  getEdges: async () => [],
  getEdgesBetween: async () => [],
  getAggregatedEdges: async () => ({ aggregatedEdges: [], totalSourceEdges: 0 }),
} as unknown as GraphDataProvider

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.includes('/api/')) return realFetch(input, init)
  const body = url.includes('/library') ? { viewId: 'harness-view', displayRules: [], savedQueries: [], canEdit: true } : {}
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof globalThis.fetch

const entityType = (id: string, name: string, color: string, canContain: string[]) => ({
  id, name, pluralName: `${name}s`, description: '', fields: [],
  visual: { icon: 'Box', color, shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  hierarchy: { level: 0, canContain, canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
  behavior: { selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
})

usePersonaStore.setState({ mode: persona })
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } } as never)
useBranchStore.setState({ workspaceId: null, dataSourceId: null, viewId: null, currentBranchId: null } as never)
useSchemaStore.setState({
  activeViewId: 'harness-view',
  schema: {
    id: 'harness', name: 'harness', version: '1',
    entityTypes: [
      entityType('warehouse', 'Warehouse', '#6366f1', ['schema']),
      entityType('schema', 'Schema', '#0ea5e9', ['table']),
      entityType('table', 'Table', '#10b981', ['column']),
      entityType('column', 'Column', '#f59e0b', []),
    ],
    relationshipTypes: [], globalVisuals: {},
    containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['TRANSFORMS'],
    rootEntityTypes: [], defaultViewId: 'harness-view',
    views: [{
      id: 'harness-view', name: 'Harness View', workspaceId: 'harness-ws',
      content: { visibleEntityTypes: [], visibleRelationshipTypes: [], defaultDepth: 3, maxDepth: 10, rootEntityTypes: [] },
      layout: { type: 'hierarchy' }, filters: {}, entityOverrides: {}, isDefault: true,
    }],
  },
} as never)
const store = useCanvasStore.getState()
store.setGraph(ROOTS.map((n) => toCanvasNode(n)), [] as LineageEdge[])
store.setHydrationPhase('complete')
store.setHydrationStatus('ready')

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProviderOverride value={{
        provider, isLoading: false, error: null, scopeKind: 'ready',
        workspaceId: 'harness-ws', dataSourceId: null, providerReady: true, providerVersion: 1,
      } as never}>
        <div style={{ height: '100vh', width: '100vw' }} className="bg-canvas">
          <HierarchyCanvas />
        </div>
        <NotificationStack />
      </ProviderOverride>
    </QueryClientProvider>
  </MemoryRouter>,
)
