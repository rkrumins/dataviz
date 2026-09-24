/**
 * Visual harness for the subset-view UI: the Subset Studio's three steps,
 * the virtual-hop path popover, the status chip and the create dialog —
 * the REAL components, over fixtures, with a stub provider and no API.
 *
 *   npx vite --port 5198
 *   open http://localhost:5198/subset-harness.html?fixture=studioPick&theme=dark
 *
 * `node scripts/subset-shot.mjs` drives Chromium over every fixture, in both
 * themes, and writes PNGs to .harness/subset/.
 */
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { MotionGlobalConfig } from 'framer-motion'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../styles/globals.css'

import { ProviderOverride } from '../providers/GraphProviderContext'
import type { GraphDataProvider, LineageBridgePathResult } from '../providers/GraphDataProvider'
import { CanvasStatusChips } from '../components/canvas/context-view/CanvasStatusChips'
import { SubsetStudioPanel } from '../features/view-subset/components/SubsetStudioPanel'
import { BridgePathPopover } from '../features/view-subset/components/BridgePathPopover'
import { SubsetCreateWizard } from '../features/view-subset/components/SubsetCreateWizard'
import type { LineageBridgesState } from '../features/view-subset/hooks/useLineageBridges'
import { useSubsetStudioStore, type SubsetPick } from '../features/view-subset/model/studioStore'

// A still frame of each surface at rest: framer's hardware-accelerated
// entrances do not advance under headless Chromium's virtual time, which
// would photograph every dialog at opacity 0.
MotionGlobalConfig.skipAnimations = true

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') ?? 'studioPick'
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

const layers = [
  { id: 'raw', name: 'Raw sources', color: '#64748b' },
  { id: 'staging', name: 'Staging', color: '#0ea5e9' },
  { id: 'marts', name: 'Marts', color: '#8b5cf6' },
  { id: 'bi', name: 'Dashboards', color: '#f59e0b' },
]
const pick = (urn: string, label: string, layerId: string, over: Partial<SubsetPick> = {}): SubsetPick =>
  ({ urn, label, layerId, inheritsChildren: true, origin: 'picked', entityType: 'table', ...over })
const PICKS = [
  pick('orders', 'raw.orders', 'raw'),
  pick('customers', 'raw.customers', 'raw', { origin: 'grown-up' }),
  pick('stg_rev', 'stg_revenue', 'staging', { origin: 'path' }),
  pick('fct_rev', 'fct_revenue_daily', 'marts'),
  pick('dim_cust', 'dim_customer', 'marts', { origin: 'grown-down' }),
  pick('board', 'Revenue board', 'bi', { entityType: 'dashboard', origin: 'outside' }),
  pick('legacy', 'legacy_ledger', 'raw', { inheritsChildren: false }),
]
const LINKS = [
  { source: 'orders', target: 'fct_rev', hops: 3 },
  { source: 'customers', target: 'dim_cust', hops: 1 },
  { source: 'fct_rev', target: 'board', hops: 2 },
  { source: 'dim_cust', target: 'board', hops: 4 },
  { source: 'stg_rev', target: 'fct_rev', hops: 1 },
]
const preview = (over: Partial<LineageBridgesState> = {}): LineageBridgesState => ({
  status: 'ready', links: LINKS, incomplete: [], depthLimited: false, isFetching: false, refetch: () => {}, ...over,
})

const PATH: LineageBridgePathResult = {
  source: 'orders', target: 'fct_rev', hops: 3,
  hiddenUrns: ['stg.o.id', 'stg.o.amt', 'int.r.amt', 'int.r2.amt'],
  endpointUrns: ['orders.amount', 'fct_rev.amount'],
  nodes: [
    { urn: 'orders', entityType: 'table', displayName: 'raw.orders', properties: {} },
    { urn: 'fct_rev', entityType: 'table', displayName: 'fct_revenue_daily', properties: {} },
    { urn: 'stg_orders', entityType: 'table', displayName: 'stg_orders', properties: {} },
    { urn: 'int_rev', entityType: 'table', displayName: 'int_revenue', properties: {} },
    { urn: 'int_rev2', entityType: 'table', displayName: 'int_revenue_adjusted', properties: {} },
    { urn: 'schema_stg', entityType: 'schema', displayName: 'staging', properties: {} },
    { urn: 'wh', entityType: 'database', displayName: 'warehouse', properties: {} },
    { urn: 'stg.o.id', entityType: 'column', displayName: 'id', properties: {} },
    { urn: 'stg.o.amt', entityType: 'column', displayName: 'amount', properties: {} },
    { urn: 'int.r.amt', entityType: 'column', displayName: 'amount', properties: {} },
    { urn: 'int.r2.amt', entityType: 'column', displayName: 'amount', properties: {} },
  ],
  edges: [
    { id: 'e1', sourceUrn: 'orders.amount', targetUrn: 'stg.o.amt', edgeType: 'TRANSFORMS' },
    { id: 'e2', sourceUrn: 'stg.o.amt', targetUrn: 'int.r.amt', edgeType: 'TRANSFORMS' },
    { id: 'e3', sourceUrn: 'stg.o.amt', targetUrn: 'int.r2.amt', edgeType: 'TRANSFORMS' },
    { id: 'e4', sourceUrn: 'int.r.amt', targetUrn: 'fct_rev.amount', edgeType: 'TRANSFORMS' },
    { id: 'e5', sourceUrn: 'int.r2.amt', targetUrn: 'fct_rev.amount', edgeType: 'TRANSFORMS' },
  ],
  ancestorChains: {
    'stg.o.amt': ['stg_orders', 'schema_stg', 'wh'],
    'int.r.amt': ['int_rev', 'schema_stg', 'wh'],
    'int.r2.amt': ['int_rev2', 'schema_stg', 'wh'],
    stg_orders: ['schema_stg', 'wh'], int_rev: ['schema_stg', 'wh'], int_rev2: ['schema_stg', 'wh'],
  },
  truncated: false,
}

const provider = {
  name: 'harness',
  scopeKey: 'harness',
  getLineageBridgePath: async () => PATH,
  getLineageBridges: async () => ({ links: LINKS, incomplete: [], depthLimited: false, truncated: false }),
} as unknown as GraphDataProvider

function seedStudio(step: 'pick' | 'connect' | 'shape') {
  const store = useSubsetStudioStore.getState()
  store.open('harness-source', { maxHops: 8 })
  store.add(PICKS, 'seed')
  store.setStep(step)
}

function Studio({ step }: { step: 'pick' | 'connect' | 'shape' }) {
  seedStudioOnce(step)
  return (
    <div className="h-screen flex bg-canvas">
      <div className="flex-1 grid place-items-center text-ink-muted text-sm">source canvas</div>
      <SubsetStudioPanel
        open
        sourceName="Finance lineage"
        layers={layers}
        layerCandidates={new Map(layers.map(l => [l.id, PICKS.filter(p => p.layerId === l.id)]))}
        containerUrns={new Set(['orders', 'fct_rev', 'legacy'])}
        preview={preview({ status: 'partial', incomplete: [{ urn: 'legacy', side: 'downstream', reason: 'hub' }] })}
        onGrow={() => {}}
        growing={false}
        onOpenHop={() => {}}
        onLocate={() => {}}
        onSave={() => {}}
      />
    </div>
  )
}

let seeded = false
function seedStudioOnce(step: 'pick' | 'connect' | 'shape') {
  if (seeded) return
  seeded = true
  seedStudio(step)
}

function Popover() {
  return (
    <div className="h-screen bg-canvas">
      <BridgePathPopover
        target={{ lineId: 'bridge-orders|fct_rev', links: [
          { source: 'orders', target: 'fct_rev', hops: 3 },
          { source: 'orders', target: 'dim_cust', hops: 5 },
        ], point: { x: 520, y: 80 } }}
        members={PICKS.map(p => ({ urn: p.urn }))}
        maxHops={10}
        labelOf={(urn) => PICKS.find(p => p.urn === urn)?.label}
        onClose={() => {}}
        onWalkInLens={() => {}}
        onIncludeSteps={() => {}}
      />
    </div>
  )
}

function Chip() {
  return (
    <div className="relative h-screen bg-canvas">
      <CanvasStatusChips
        unresolvedEdgeCount={0}
        unassignedEntities={[]}
        aggDetailShown={0}
        aggDetailTotal={0}
        virtualHops={{
          status: 'partial', isFetching: false, retryable: true, maxHops: 10,
          incompleteNames: ['legacy_ledger'],
          lines: [
            { lineId: 'l1', sourceLabel: 'raw.orders', targetLabel: 'fct_revenue_daily', hops: 3 },
            { lineId: 'l2', sourceLabel: 'fct_revenue_daily', targetLabel: 'Revenue board', hops: 2 },
          ],
          onOpenLine: () => {}, onRetry: () => {},
        }}
      />
    </div>
  )
}

function Wizard({ review }: { review: boolean }) {
  seedStudioOnce('shape')
  useEffect(() => {
    if (!review) return
    const t = setTimeout(() => {
      const next = [...document.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith('Next'))
      next?.click()
    }, 300)
    return () => clearTimeout(t)
  }, [review])
  return <SubsetCreateWizard source={{ id: 'harness-source', name: 'Finance lineage', workspaceName: 'Finance' }} layers={layers} preview={preview()} onClose={() => {}} />
}

function App() {
  switch (fixture) {
    case 'studioConnect': return <Studio step="connect" />
    case 'studioShape': return <Studio step="shape" />
    case 'pathPopover': return <Popover />
    case 'hopsChip': return <Chip />
    case 'wizardDetails': return <Wizard review={false} />
    case 'wizardReview': return <Wizard review />
    default: return <Studio step="pick" />
  }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ProviderOverride value={{
          provider, isLoading: false, error: null, scopeKind: 'ready',
          workspaceId: 'harness', dataSourceId: null, providerReady: true, providerVersion: 1,
        } as never}>
          <App />
        </ProviderOverride>
      </QueryClientProvider>
    </MemoryRouter>
  </StrictMode>,
)
