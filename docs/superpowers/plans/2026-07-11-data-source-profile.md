# Data Source Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the standalone data-source page into one reusable, context-aware `DataSourceProfile` surfaced as a slide-over drawer in Ingestion, an Insights tab in the Workspaces data-source drawer, and a thin deep-link page.

**Architecture:** A single React Query hook (`useDataSourceProfile`) bundles catalog + provider + stats + consumers. A presentational `DataSourceProfile` component renders catalog-level "core" sections always, and per-binding "enhanced" sections (semantic layer, aggregation status, vocab alignment) only when optional workspace `context` is passed. A `DataSourceProfileDrawer` wraps it in the app's existing portal+Backdrop+motion slide-over. Three mount points reuse the one component.

**Tech Stack:** React 18 + TypeScript, `@tanstack/react-query` v5, framer-motion, Tailwind (glass/ink tokens), Vitest + Testing Library.

## Global Constraints

- Follow the design system: `border-glass-border`, `bg-canvas-elevated`, `text-ink`/`text-ink-muted`, indigo/emerald accents, `tabular-nums` for numbers. No new fonts/colors.
- Page width standard: `max-w-[1440px] mx-auto px-6 md:px-10 lg:px-12` for the full-page frame.
- All reads via React Query; permission-gated at the service layer (services already `silent403`).
- `tsc --noEmit` must stay at the repo baseline (currently 65 pre-existing errors, none in touched files). **Run `tsc`, not just vitest, after adding any test file** — vitest (esbuild) does not type-check.
- Plain-language, non-technical microcopy (see `premium-nontechnical-ui-principle`). No jargon in section titles.
- **Leverage the Insights Service primitives for ALL data + freshness — do NOT reinvent.** Specifically: stats/composition come from `useAssetStats` → `AssetStatsPayload` (node/edge counts, `entityTypeCounts`, `edgeTypeCounts`); freshness/staleness/provider-health from `StatusChip` + the `InsightsMeta` envelope (`meta.status`, `meta.updated_at`, `meta.refreshing`, `meta.provider_health`); the "Refresh now" action reuses `providerService.refreshAssetStats(providerId, assetName)` + `queryClient.invalidateQueries([ASSET_STATS_QUERY_KEY_PREFIX, …])` (or the existing `RefreshControl` component), NOT a new refresh path; any polling cadence from `useInsightsConfig`. Before writing a data/freshness/refresh element, check `frontend/src/components/insights/` and `frontend/src/hooks/useAssetStats.ts`/`useInsightsConfig.ts`/`useInsightsJob.ts` for an existing piece and reuse it.
- Spec: `docs/superpowers/specs/2026-07-11-data-source-profile-design.md`.

---

## File Structure

- Create `frontend/src/hooks/useDataSourceProfile.ts` — bundled data hook. One responsibility: fetch + normalize one data source's profile data.
- Create `frontend/src/components/insights/DataSourceProfile.tsx` — the shared, context-aware presentational component (core + enhanced sections + section primitives).
- Create `frontend/src/components/insights/DataSourceProfileDrawer.tsx` — slide-over wrapper (portal + Backdrop + motion) used by Ingestion.
- Modify `frontend/src/pages/DataSourceOverviewPage.tsx` — slim to a thin full-page wrapper around `DataSourceProfile`.
- Modify `frontend/src/components/admin/RegistryAssets.tsx` — row insights link opens the drawer via `?profile=<catalogId>` instead of routing.
- Modify `frontend/src/components/admin/workspace/DataSourceDetailPanel.tsx` — Insights tab body → `DataSourceProfile` with workspace context; delete the inline stats/ratio markup.
- Tests: `useDataSourceProfile.test.ts`, `DataSourceProfile.test.tsx`, update `DataSourceOverviewPage.test.tsx`.

---

## Task 1: `useDataSourceProfile` hook

**Files:**
- Create: `frontend/src/hooks/useDataSourceProfile.ts`
- Test: `frontend/src/hooks/useDataSourceProfile.test.ts`

**Interfaces:**
- Consumes: `catalogService.get`, `catalogService.getImpact`, `providerService.get`, `useAssetStats` (existing).
- Produces: `useDataSourceProfile(catalogId: string | null): DataSourceProfileData` where
  ```ts
  interface DataSourceProfileData {
    item: CatalogItemResponse | undefined
    provider: ProviderResponse | undefined
    stats: AssetStatsPayload | undefined      // stats envelope .data
    meta: InsightsMeta | undefined            // stats envelope .meta (freshness)
    consumers: ProviderImpactResponse | undefined  // { workspaces, views }
    isLoading: boolean
    notFound: boolean
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/hooks/useDataSourceProfile.test.ts
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/catalogService', () => ({
  catalogService: {
    get: vi.fn().mockResolvedValue({ id: 'cat-1', providerId: 'p-1', sourceIdentifier: 'orders', name: 'Orders', status: 'active', permittedWorkspaces: ['*'], createdAt: '', updatedAt: '' }),
    getImpact: vi.fn().mockResolvedValue({ catalogItems: [], workspaces: [{ id: 'w', name: 'WS', type: 'workspace' }], views: [] }),
  },
}))
vi.mock('@/services/providerService', () => ({
  providerService: { get: vi.fn().mockResolvedValue({ id: 'p-1', name: 'Falkor', providerType: 'falkordb' }) },
}))
vi.mock('@/hooks/useAssetStats', () => ({
  ASSET_STATS_QUERY_KEY_PREFIX: 'insights-asset-stats',
  useAssetStats: () => ({ isLoading: false, data: { data: { nodeCount: 10, edgeCount: 20, entityTypeCounts: {}, edgeTypeCounts: {} }, meta: { status: 'fresh' } } }),
}))

import { useDataSourceProfile } from './useDataSourceProfile'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useDataSourceProfile', () => {
  it('bundles item, provider, stats, and consumers', async () => {
    const { result } = renderHook(() => useDataSourceProfile('cat-1'), { wrapper })
    await waitFor(() => expect(result.current.item?.name).toBe('Orders'))
    expect(result.current.provider?.name).toBe('Falkor')
    expect(result.current.stats?.nodeCount).toBe(10)
    expect(result.current.consumers?.workspaces[0].name).toBe('WS')
    expect(result.current.notFound).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/useDataSourceProfile.test.ts`
Expected: FAIL — "Cannot find module './useDataSourceProfile'".

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/hooks/useDataSourceProfile.ts
import { useQuery } from '@tanstack/react-query'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { providerService, type ProviderResponse, type ProviderImpactResponse } from '@/services/providerService'
import { useAssetStats } from '@/hooks/useAssetStats'
import type { AssetStatsPayload, InsightsMeta } from '@/types/insights'

export interface DataSourceProfileData {
  item: CatalogItemResponse | undefined
  provider: ProviderResponse | undefined
  stats: AssetStatsPayload | undefined
  meta: InsightsMeta | undefined
  consumers: ProviderImpactResponse | undefined
  isLoading: boolean
  notFound: boolean
}

export function useDataSourceProfile(catalogId: string | null): DataSourceProfileData {
  const itemQuery = useQuery({
    queryKey: ['catalog-item', catalogId],
    queryFn: () => catalogService.get(catalogId!),
    enabled: !!catalogId,
    staleTime: 30_000,
  })
  const item = itemQuery.data

  const providerQuery = useQuery({
    queryKey: ['provider', item?.providerId],
    queryFn: () => providerService.get(item!.providerId),
    enabled: !!item?.providerId,
    staleTime: 60_000,
  })

  const impactQuery = useQuery({
    queryKey: ['catalog-impact', catalogId],
    queryFn: () => catalogService.getImpact(catalogId!),
    enabled: !!catalogId,
    staleTime: 30_000,
  })

  const statsQuery = useAssetStats(item?.providerId ?? '', item?.sourceIdentifier ?? '', {
    enabled: !!item?.providerId && !!item?.sourceIdentifier,
  })

  return {
    item,
    provider: providerQuery.data,
    stats: statsQuery.data?.data ?? undefined,
    meta: statsQuery.data?.meta,
    consumers: impactQuery.data,
    isLoading: itemQuery.isLoading,
    notFound: itemQuery.isError,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/useDataSourceProfile.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"` (Expected: baseline, unchanged)
```bash
git add frontend/src/hooks/useDataSourceProfile.ts frontend/src/hooks/useDataSourceProfile.test.ts
git commit -m "Add useDataSourceProfile hook"
```

---

## Task 2: `DataSourceProfile` core component

Extract the section primitives and core sections from the existing `DataSourceOverviewPage.tsx` into a reusable component. The page currently contains (real, in-repo) helpers to move verbatim: `compactNum`, `timeAgo`, `connectivity`, `PROVIDER_TINT`, `Card`, `CardHeader`, `StatTile`, `TypeBreakdown`, `DetailRow`, `UsedByList`, plus the hero/metrics/composition/used-by/explore JSX. Move them into the new component and have it read from `useDataSourceProfile` instead of local queries.

**Files:**
- Create: `frontend/src/components/insights/DataSourceProfile.tsx`
- Test: `frontend/src/components/insights/DataSourceProfile.test.tsx`
- Reference (source of moved code): `frontend/src/pages/DataSourceOverviewPage.tsx`

**Interfaces:**
- Consumes: `useDataSourceProfile` (Task 1), `useProviderHealth`, `PROVIDER_HEALTH_META`, `StatusChip`, `getProviderLogo`.
- Produces: `DataSourceProfile({ catalogId, context }: { catalogId: string; context?: DataSourceProfileContext | null })` where
  ```ts
  export interface DataSourceProfileContext {
    wsId: string
    dataSourceId: string
    ontologyId?: string | null
    ontologyName?: string | null
  }
  ```
  In this task `context` is accepted but unused (enhanced sections land in Task 3).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/insights/DataSourceProfile.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/hooks/useDataSourceProfile', () => ({
  useDataSourceProfile: () => ({
    item: { id: 'cat-1', providerId: 'p-1', sourceIdentifier: 'orders', name: 'Orders Graph', status: 'active', createdAt: new Date().toISOString(), updatedAt: '' },
    provider: { id: 'p-1', name: 'Falkor Docker', providerType: 'falkordb' },
    stats: { nodeCount: 67870, edgeCount: 568001, entityTypeCounts: { Party: 4000 }, edgeTypeCounts: { HOLDS: 5000 } },
    meta: { status: 'fresh', updated_at: new Date().toISOString(), refreshing: false, provider_health: 'ok' },
    consumers: { catalogItems: [], workspaces: [{ id: 'w', name: 'Analytics', type: 'workspace' }], views: [{ id: 'v', name: 'Revenue', type: 'view' }] },
    isLoading: false, notFound: false,
  }),
}))
vi.mock('@/store/providerHealthModel', () => ({
  useProviderHealth: () => ({ state: 'ready' }),
  PROVIDER_HEALTH_META: { ready: { dot: 'bg-emerald-400', label: 'Healthy' } },
}))
vi.mock('@/components/insights/StatusChip', () => ({ StatusChip: () => <span data-testid="chip" /> }))

import { DataSourceProfile } from './DataSourceProfile'

describe('DataSourceProfile', () => {
  it('renders core sections: name, metrics, and consumers', async () => {
    render(<MemoryRouter><DataSourceProfile catalogId="cat-1" /></MemoryRouter>)
    expect(screen.getByText('Orders Graph')).toBeInTheDocument()
    expect(screen.getByText('68k')).toBeInTheDocument()          // 67870 compacted
    expect(screen.getByText('Analytics')).toBeInTheDocument()    // Used by
    expect(screen.getByText('Revenue')).toBeInTheDocument()
  })

  it('does not render enhanced sections without context', () => {
    render(<MemoryRouter><DataSourceProfile catalogId="cat-1" /></MemoryRouter>)
    expect(screen.queryByText('Semantic layer')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/insights/DataSourceProfile.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the component**

Create `frontend/src/components/insights/DataSourceProfile.tsx`. Move the helpers and section components listed above **verbatim** from `DataSourceOverviewPage.tsx`, then assemble the component body to read from the hook:

```tsx
// frontend/src/components/insights/DataSourceProfile.tsx
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
// ...lucide icons used by the moved sections (Boxes, Spline, Tag, Waypoints,
//    Building2, Eye, Clock, ExternalLink, ShieldCheck, Loader2, Compass,
//    GitBranch, Layers, Database)...
import { cn } from '@/lib/utils'
import { useDataSourceProfile } from '@/hooks/useDataSourceProfile'
import { useProviderHealth, PROVIDER_HEALTH_META } from '@/store/providerHealthModel'
import { StatusChip } from '@/components/insights/StatusChip'
import { getProviderLogo } from '@/components/admin/ProviderLogos'

export interface DataSourceProfileContext {
  wsId: string
  dataSourceId: string
  ontologyId?: string | null
  ontologyName?: string | null
}

// —— move verbatim from DataSourceOverviewPage.tsx: compactNum, timeAgo,
//    connectivity, PROVIDER_TINT, Card, CardHeader, StatTile, TypeBreakdown,
//    DetailRow, UsedByList ——

export function DataSourceProfile({ catalogId, context: _context }: {
  catalogId: string
  context?: DataSourceProfileContext | null
}) {
  const { item, provider, stats, meta, consumers, isLoading, notFound } = useDataSourceProfile(catalogId)
  const health = useProviderHealth(item?.providerId)
  const healthMeta = PROVIDER_HEALTH_META[health.state]
  const workspaces = consumers?.workspaces ?? []
  const views = consumers?.views ?? []
  const primaryExplorerHref = workspaces[0] ? `/explorer?workspace=${workspaces[0].id}` : null
  // ...render the hero + metric tiles + "What's inside" + "Shape & connectivity"
  //    + "Where it's used" + "Explore lineage" using the moved section
  //    components — identical layout to the current page body, minus the
  //    outer page frame/back button (those stay in the page wrapper, Task 7).
  // notFound → a compact "Data source not found" card.
  // isLoading → skeleton/spinner states already present in the moved sections.
  return (/* assembled JSX */ null)
}
```

Keep the exact JSX/classes from the page's `<>…</>` body (hero, metrics grid, the two `TypeBreakdown` cards, the connectivity card, the Used-by card, the per-workspace Explore card). Do **not** include the page's outer `absolute inset-0 overflow-y-auto` frame or the "← Data Sources" button — those belong to the page wrapper.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/insights/DataSourceProfile.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"` (Expected: baseline)
```bash
git add frontend/src/components/insights/DataSourceProfile.tsx frontend/src/components/insights/DataSourceProfile.test.tsx
git commit -m "Add DataSourceProfile core component"
```

---

## Task 3: Enhanced (workspace-context) sections

Add the three per-binding sections that render only when `context` is present: **Semantic layer** (ontology link from context), **Aggregation status** (read-only, from `aggregationService.getReadiness`), and **Vocabulary alignment** (reuse existing `VocabAlignmentWarning`).

**Files:**
- Modify: `frontend/src/components/insights/DataSourceProfile.tsx`
- Test: `frontend/src/components/insights/DataSourceProfile.test.tsx` (extend)
- Reference: `frontend/src/services/aggregationService.ts` (`getReadiness`, `DataSourceReadinessResponse`), `frontend/src/components/admin/workspace/VocabAlignmentWarning.tsx`

**Interfaces:**
- Consumes: `aggregationService.getReadiness(dataSourceId): Promise<DataSourceReadinessResponse>` — confirm field names in `aggregationService.ts`; the section reads `aggregationStatus`, `lastAggregatedAt`, `aggregationEdgeCount`, `driftDetected`.
- Produces: none new (internal sections).

- [ ] **Step 1: Write the failing test**

```tsx
// add to DataSourceProfile.test.tsx
vi.mock('@/services/aggregationService', () => ({
  aggregationService: { getReadiness: vi.fn().mockResolvedValue({ aggregationStatus: 'ready', lastAggregatedAt: new Date().toISOString(), aggregationEdgeCount: 1234, driftDetected: false }) },
}))
vi.mock('@/components/admin/workspace/VocabAlignmentWarning', () => ({ VocabAlignmentWarning: () => <div data-testid="vocab" /> }))

it('renders enhanced sections when workspace context is provided', async () => {
  const ctx = { wsId: 'w', dataSourceId: 'ds-1', ontologyId: 'o-1', ontologyName: 'Core Ontology' }
  render(<MemoryRouter><DataSourceProfile catalogId="cat-1" context={ctx} /></MemoryRouter>)
  expect(await screen.findByText('Semantic layer')).toBeInTheDocument()
  expect(screen.getByText('Core Ontology')).toBeInTheDocument()
  expect(screen.getByTestId('vocab')).toBeInTheDocument()
})
```

Wrap the enhanced test render in a `QueryClientProvider` (the aggregation section uses `useQuery`) — reuse the wrapper pattern from `useDataSourceProfile.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/insights/DataSourceProfile.test.tsx`
Expected: FAIL — "Semantic layer" not found.

- [ ] **Step 3: Implement enhanced sections**

In `DataSourceProfile.tsx`, when `context` is truthy, render after the core sidebar cards:

```tsx
{context && (
  <>
    {/* Semantic layer */}
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-3">
        <Layers className="w-4 h-4 text-ink-muted" />
        <h3 className="text-sm font-bold text-ink">Semantic layer</h3>
      </div>
      {context.ontologyId ? (
        <Link to={`/schema/${context.ontologyId}`} className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
          {context.ontologyName ?? 'View ontology'}
        </Link>
      ) : (
        <p className="text-xs text-ink-muted/80">No semantic layer assigned.</p>
      )}
    </Card>

    <AggregationStatusCard dataSourceId={context.dataSourceId} wsId={context.wsId} />

    {/* Vocabulary alignment (existing component, self-fetches) */}
    <VocabAlignmentWarning wsId={context.wsId} dataSourceId={context.dataSourceId} />
  </>
)}
```

Add the `AggregationStatusCard` sub-component in the same file:

```tsx
function AggregationStatusCard({ dataSourceId }: { dataSourceId: string; wsId: string }) {
  const { data } = useQuery({
    queryKey: ['ds-readiness', dataSourceId],
    queryFn: () => aggregationService.getReadiness(dataSourceId),
    staleTime: 30_000,
  })
  if (!data) return null
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-3">
        <Waypoints className="w-4 h-4 text-ink-muted" />
        <h3 className="text-sm font-bold text-ink">Aggregation</h3>
      </div>
      <div className="space-y-1.5 text-xs">
        <DetailRow label="Status" value={data.aggregationStatus ?? '—'} />
        <DetailRow label="Rolled-up edges" value={compactNum(data.aggregationEdgeCount ?? 0)} />
        <DetailRow label="Last aggregated" value={timeAgo(data.lastAggregatedAt)} />
        {data.driftDetected && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            Source changed since last aggregation — re-aggregate from the workspace to refresh.
          </p>
        )}
      </div>
    </Card>
  )
}
```

Add imports: `useQuery` from `@tanstack/react-query`, `aggregationService` from `@/services/aggregationService`, `VocabAlignmentWarning` from `@/components/admin/workspace/VocabAlignmentWarning`. Confirm `DataSourceReadinessResponse` field names against `aggregationService.ts`; adjust the `data.*` reads if they differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/insights/DataSourceProfile.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"` (Expected: baseline)
```bash
git add frontend/src/components/insights/DataSourceProfile.tsx frontend/src/components/insights/DataSourceProfile.test.tsx
git commit -m "Add DataSourceProfile enhanced (workspace-context) sections"
```

---

## Task 4: `DataSourceProfileDrawer`

A right-side slide-over that renders `DataSourceProfile`, matching the app's existing drawer pattern (portal + `Backdrop` + framer-motion, as in `DataSourceDetailPanel.tsx`).

**Files:**
- Create: `frontend/src/components/insights/DataSourceProfileDrawer.tsx`
- Reference: `frontend/src/components/admin/workspace/DataSourceDetailPanel.tsx` (portal/Backdrop/motion pattern), `frontend/src/components/ui/Backdrop.tsx`

**Interfaces:**
- Consumes: `DataSourceProfile` (Task 2/3), `Backdrop`.
- Produces: `DataSourceProfileDrawer({ catalogId, isOpen, onClose }: { catalogId: string | null; isOpen: boolean; onClose: () => void })`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/insights/DataSourceProfileDrawer.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
vi.mock('./DataSourceProfile', () => ({ DataSourceProfile: () => <div data-testid="profile" /> }))
import { DataSourceProfileDrawer } from './DataSourceProfileDrawer'

describe('DataSourceProfileDrawer', () => {
  it('renders the profile when open and closes on the close button', async () => {
    const onClose = vi.fn()
    render(<DataSourceProfileDrawer catalogId="cat-1" isOpen onClose={onClose} />)
    expect(screen.getByTestId('profile')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    const { container } = render(<DataSourceProfileDrawer catalogId={null} isOpen={false} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/insights/DataSourceProfileDrawer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the drawer**

```tsx
// frontend/src/components/insights/DataSourceProfileDrawer.tsx
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { DataSourceProfile } from './DataSourceProfile'

export function DataSourceProfileDrawer({ catalogId, isOpen, onClose }: {
  catalogId: string | null
  isOpen: boolean
  onClose: () => void
}) {
  return createPortal(
    <AnimatePresence>
      {isOpen && catalogId && (
        <>
          <Backdrop onClick={onClose} />
          <motion.div
            role="dialog" aria-label="Data source profile"
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
            className="fixed right-0 top-0 z-50 h-full w-full max-w-2xl overflow-y-auto bg-canvas border-l border-glass-border shadow-2xl"
          >
            <div className="sticky top-0 z-10 flex items-center justify-end p-3 bg-canvas/80 backdrop-blur">
              <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 pb-8">
              <DataSourceProfile catalogId={catalogId} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}
```

Confirm `Backdrop`'s prop name (`onClick`) against `frontend/src/components/ui/Backdrop.tsx`; adjust if it differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/insights/DataSourceProfileDrawer.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"` (Expected: baseline)
```bash
git add frontend/src/components/insights/DataSourceProfileDrawer.tsx frontend/src/components/insights/DataSourceProfileDrawer.test.tsx
git commit -m "Add DataSourceProfileDrawer slide-over"
```

---

## Task 5: Wire Ingestion — open the drawer via `?profile=`

The row insights link (added in `b39f2b32`) currently routes to `/datasources/:id`. Change it to open the drawer in-context by setting a `profile` search param; render `DataSourceProfileDrawer` from that param.

**Files:**
- Modify: `frontend/src/components/admin/RegistryAssets.tsx`

**Interfaces:**
- Consumes: `DataSourceProfileDrawer` (Task 4), `useSearchParams` (already imported).

- [ ] **Step 1: Change the row link to set the param**

In `AssetRow`, replace the `<Link to={/datasources/${catalogId}}>` insights button with a button that calls a passed `onOpenProfile(catalogId)`:

```tsx
{catalogId && (
  <button
    onClick={(e) => { e.stopPropagation(); onOpenProfile(catalogId) }}
    title="Open data source profile"
    aria-label={`Open profile for ${assetName}`}
    className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors"
  >
    <ArrowUpRight className="w-3.5 h-3.5" />
  </button>
)}
```

Add `onOpenProfile: (catalogId: string) => void` to `AssetRow`'s props and pass it in the `pagedAssets.map(...)`: `onOpenProfile={(id) => setSearchParams({ tab: 'assets', provider: selectedProviderId ?? '', profile: id })}`.

- [ ] **Step 2: Render the drawer from the param**

Near the component's other dialogs (end of the `RegistryAssets` return), add:

```tsx
<DataSourceProfileDrawer
  catalogId={searchParams.get('profile')}
  isOpen={!!searchParams.get('profile')}
  onClose={() => { const p = new URLSearchParams(searchParams); p.delete('profile'); setSearchParams(p) }}
/>
```

Import `DataSourceProfileDrawer` from `@/components/insights/DataSourceProfileDrawer`.

- [ ] **Step 3: Typecheck + build**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"` (Expected: baseline)
Run: `cd frontend && npm run build 2>&1 | grep -E "error|built in"` (Expected: built, no error)

- [ ] **Step 4: Manual verification**

Dev server on :5173 → Ingestion → Data Sources → click the ↗ on a registered row → the drawer slides in with the profile; the URL gains `?profile=<id>`; closing removes the param. (No unit test — this is URL/route glue best verified live.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/admin/RegistryAssets.tsx
git commit -m "Open data source profile as an in-context drawer from Ingestion"
```

---

## Task 6: Wire Workspaces — Insights tab uses `DataSourceProfile`

Replace the `DataSourceDetailPanel` Insights tab body with `DataSourceProfile` + workspace context, and delete the now-duplicated inline stats/ratio markup.

**Files:**
- Modify: `frontend/src/components/admin/workspace/DataSourceDetailPanel.tsx`

**Interfaces:**
- Consumes: `DataSourceProfile`, `DataSourceProfileContext` (Task 2). The panel already has `ds` (with `id`, `catalogItemId`, `ontologyId`), `wsId`, `ontologyName`.

- [ ] **Step 1: Swap the Insights tab body**

Locate the Insights tab render (`DataSourceDetailPanel.tsx:356-416`). Replace its inner content (MiniKPIs + DetailRows + entity-type chips + node/edge ratio) with:

```tsx
{ds?.catalogItemId ? (
  <DataSourceProfile
    catalogId={ds.catalogItemId}
    context={{ wsId, dataSourceId: ds.id, ontologyId, ontologyName }}
  />
) : (
  <p className="text-sm text-ink-muted">This data source isn’t linked to a catalog item.</p>
)}
```

Import `DataSourceProfile` and its `DataSourceProfileContext` type from `@/components/insights/DataSourceProfile`. Remove the `MiniKpi` component and the `DataSourceStats`/ratio code paths **only if** they become unused after this change (check for other references in the file first; leave shared helpers used elsewhere).

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "DataSourceDetailPanel|DataSourceProfile" || echo clean`
Expected: `clean`. Then confirm total is at baseline: `npx tsc --noEmit 2>&1 | grep -c "error TS"`.

- [ ] **Step 3: Build + manual verification**

Run: `cd frontend && npm run build 2>&1 | grep -E "error|built in"` (Expected: built)
Live: Workspaces → open a workspace → open a data source → Insights tab shows the full profile (metrics with counts, what's inside, used-by, explore) **plus** Semantic layer, Aggregation status, and Vocabulary alignment. Aggregation/Views/Versioning tabs unchanged.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/admin/workspace/DataSourceDetailPanel.tsx
git commit -m "Reuse DataSourceProfile as the Workspaces Insights tab (superset)"
```

---

## Task 7: Slim the deep-link page + final verification

Reduce `DataSourceOverviewPage` to a thin full-page wrapper around `DataSourceProfile` (keep the route + the "← Data Sources" back button + page frame). Update its test.

**Files:**
- Modify: `frontend/src/pages/DataSourceOverviewPage.tsx`
- Modify: `frontend/src/pages/DataSourceOverviewPage.test.tsx`

**Interfaces:**
- Consumes: `DataSourceProfile`.

- [ ] **Step 1: Replace the page body**

```tsx
// frontend/src/pages/DataSourceOverviewPage.tsx
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { DataSourceProfile } from '@/components/insights/DataSourceProfile'

export function DataSourceOverviewPage() {
  const { catalogId = '' } = useParams()
  const navigate = useNavigate()
  useDocumentTitle('Data Source')
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="max-w-[1440px] mx-auto px-6 md:px-10 lg:px-12 py-8 animate-in fade-in duration-500">
        <button onClick={() => navigate('/ingestion?tab=assets')} className="mb-6 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Data Sources
        </button>
        <DataSourceProfile catalogId={catalogId} />
      </div>
    </div>
  )
}
```

Delete the now-unused helpers/sections left in the page (they moved to the component in Task 2).

- [ ] **Step 2: Update the page test**

Replace the deep render assertions with a wrapper check (the profile is unit-tested separately):

```tsx
vi.mock('@/components/insights/DataSourceProfile', () => ({ DataSourceProfile: () => <div data-testid="profile" /> }))
// ...render the page at /datasources/cat-1 and assert getByTestId('profile') is present
//    and the "Data Sources" back link renders.
```

- [ ] **Step 3: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/pages/DataSourceOverviewPage.test.tsx`
Expected: PASS.
Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"` (Expected: baseline)

- [ ] **Step 4: Full verification**

Run: `cd frontend && npm run build 2>&1 | grep -E "error|built in"` (Expected: built)
Run the touched-area tests together:
`cd frontend && npx vitest run src/hooks/useDataSourceProfile.test.ts src/components/insights/ src/pages/DataSourceOverviewPage.test.tsx` (Expected: all green)
Live: deep-link `/datasources/:catalogId` renders full-page; Ingestion drawer + Workspaces Insights both render the same profile.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/DataSourceOverviewPage.tsx frontend/src/pages/DataSourceOverviewPage.test.tsx
git commit -m "Slim data source page to a thin DataSourceProfile wrapper"
```

---

## Self-Review

- **Spec coverage:** three frames (Ingestion drawer = Task 5, Workspaces Insights = Task 6, deep-link page = Task 7); one component (Task 2/3) + hook (Task 1) + drawer (Task 4); core vs enhanced split (Task 2 core, Task 3 enhanced); bring-over superset (Task 6 replaces the count-less inline stats). Out-of-scope (orphan analytics) correctly absent. Covered.
- **Type consistency:** `DataSourceProfileData` (Task 1) consumed by `DataSourceProfile` (Task 2); `DataSourceProfileContext` defined Task 2, consumed Tasks 3/6; `DataSourceProfileDrawer` signature (Task 4) consumed Task 5. Names align.
- **Open confirmations flagged in-task (not placeholders):** `DataSourceReadinessResponse` field names (Task 3) and `Backdrop` prop name (Task 4) — each step says to confirm against the named real file and adjust.
