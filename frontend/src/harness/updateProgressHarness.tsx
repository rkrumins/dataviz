/**
 * Visual harness for update progress (`UpdateProgress`): the component in every state, and each
 * place it shows — the view header's sync chip (both lenses, its card open in the technical one),
 * the canvas's refreshing badge and read-route chip, the fast read layer's card, and a graph's
 * settings drawer opening on its health — the REAL components and their queries, against an
 * in-memory API. No backend, no auth. `scripts/update-progress-shot.mjs` drives it in Chromium.
 *
 *   npm run harness
 *   open http://localhost:5199/update-progress-harness.html?view=places&state=updating&theme=dark
 *
 *   view    states (every state of the component) | places | drawer (default states)
 *   state   a name in `PROGRESS_STATES` (default updating)
 *   lens    business | technical (places: the persona the page reads in; default technical)
 *   theme   `dark` for the dark palette
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { GraphHealthPanel } from '../components/admin/AdminVersionedGraphs/GraphHealthPanel'
import { GraphSettingsDrawer } from '../components/admin/AdminVersionedGraphs/GraphSettingsDrawer'
import { HEALTH } from '../components/admin/AdminVersionedGraphs/__fixtures__/api'
import { SyncStatusChip } from '../features/sync-status/SyncStatusChip'
import type { SyncStatus } from '../features/sync-status/syncStatusApi'
import { ProjectionHealthCard } from '../features/versioning/components/ProjectionHealthCard'
import { ReadRouteChip } from '../features/versioning/components/ReadRouteChip'
import { RefreshingBadge } from '../features/versioning/components/RefreshingBadge'
import { UpdateProgress } from '../features/versioning/components/UpdateProgress'
import type { GraphUpdateProgress, Watermark } from '../services/versioningApiService'
import { useAuthStore } from '../store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePersonaStore } from '../store/persona'
import { usePreferencesStore } from '../store/preferences'
import { PROGRESS_STATES } from './updateProgressFixtures'
import { GRAPH, WS, versionedGraphsFetch } from './versionedGraphsFixtures'

const params = new URLSearchParams(window.location.search)
const view = params.get('view') ?? 'states'
const stateName = params.get('state') ?? 'updating'
const dark = params.get('theme') === 'dark'
const lens = params.get('lens') === 'business' ? 'business' : 'technical'

// Every animation lands on its end state at once: a screenshot otherwise catches a bar mid-sweep.
MotionGlobalConfig.skipAnimations = true
const still = document.createElement('style')
still.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }'
document.head.appendChild(still)

/** The update this page shows, as version 214 of the drawer's graph (its health fixture's head). */
const PROGRESS: GraphUpdateProgress | null = PROGRESS_STATES[stateName]
    ? { ...PROGRESS_STATES[stateName].progress, targetSeq: 214, targetVersion: 214 } : null

const ago = (secs: number) => new Date(Date.now() - secs * 1000).toISOString()
const REV = { commitId: 'cm_214', createdAt: ago(180), actorName: 'Alice Martin', message: 'Q4 import' }

/** The watermark and sync status of a graph whose version 214 is being written as `p` says. */
function scene(p: GraphUpdateProgress | null): { wm: Watermark; sync: SyncStatus } {
    const phase = p?.phase ?? 'updating'
    const beside = phase === 'building' || phase === 'switching'
    const fromDatabase = phase === 'seeding' || phase === 'loading'
    const status = beside ? 'idle' : phase === 'loading' ? 'rehydrating' : phase === 'seeding' ? 'rebuilding' : 'projecting'
    const served = fromDatabase ? null : 213
    const candidate = beside ? { id: 'build_7', step: phase === 'switching' ? 'catching_up' as const : 'copying' as const, attempts: 0 } : null
    const wm: Watermark = {
        committed: 214, projected: fromDatabase ? 0 : 213, fresh: false, status, served, target: 214,
        readRoute: { main: served == null ? 'postgres' : 'falkordb', drafts: 'overlay' },
        projectionKey: 'gv_sales_lineage', providerId: 'prov_1', providerName: 'Primary graph store', owned: true,
        epoch: 19, failedAttempts: 0, nextRetryAt: null, livenessError: null, residency: 'standard',
        residencyState: phase === 'loading' ? 'rehydrating' : 'resident', readMode: beside ? 'beside' : 'in_place',
        candidate, progress: p,
    }
    const sync: SyncStatus = {
        kind: 'versioned', dataSourceId: 'ds_sales', checkedAt: ago(4),
        versioned: {
            graphId: GRAPH, committed: 214, projected: wm.projected, fresh: false, status, served,
            committedRevision: REV, projectedRevision: REV, servedRevision: served == null ? null : { ...REV, commitId: 'cm_213', message: 'Q3 corrections' },
            lastProjectedAt: ago(3600), readMode: wm.readMode, candidate, progress: p,
        },
        summaries: { aggregationStatus: 'ready', driftState: 'managed', lastJobStatus: 'completed', lastSuccessAt: ago(3600) },
        counts: { nodes: 18_400, edges: 26_120, readAt: ago(300) },
    }
    return { wm, sync }
}

const PLACEMENT = {
    dataSourceId: 'ds_sales', providerId: 'prov_1', providerName: 'Primary graph store', instanceId: 'i1', mode: 'cluster',
    reachable: true,
    placements: [{
        graphKey: 'gv_sales_lineage', role: 'projection', slot: 4321, shardIndex: 1, present: true,
        master: { endpoint: '10.0.0.2:6379', role: 'master', status: 'up', memory: { used: 2 ** 30, maxmemory: 4 * 2 ** 30, usedPct: 25 } },
        replicas: [], siblings: 0, siblingsSample: [], edgeCount: 26_120, measuredBytes: 9.4 * 2 ** 30,
    }],
    totals: { masters: 3, replicas: 3, nodesUp: 6, nodesTotal: 6, graphs: 12, unregisteredGraphs: 0 },
    cacheAgeMs: 0, stale: false,
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function progressFetch(): typeof fetch {
    const settings = versionedGraphsFetch('workspace-admin')
    const { wm, sync } = scene(PROGRESS)
    return async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
        const p = url.pathname
        if (p.endsWith('/watermark')) return json(wm)
        if (p.endsWith('/graph/sync-status')) return json(sync)
        if (p.endsWith('/admin/graph-store/placement')) return json(PLACEMENT)
        if (p.endsWith('/health')) {
            // Built beside: its readers switch when ready, and its build is running. A first copy
            // or a load: its readers read the database, at the head, meanwhile.
            const beside = PROGRESS?.phase === 'building' || PROGRESS?.phase === 'switching'
            const fromDatabase = PROGRESS?.phase === 'seeding' || PROGRESS?.phase === 'loading'
            return json({
                ...HEALTH, progress: PROGRESS,
                ...(beside ? {
                    readMode: { effective: 'beside', declared: 'beside', source: 'graph', why: [] },
                    lastBuild: { outcome: 'running', at: PROGRESS!.startedAt, why: null },
                    problems: [],
                } : {}),
                ...(fromDatabase ? {
                    serving: { ...HEALTH.head!, source: 'database' }, versionsBehind: 0,
                    memory: { ...HEALTH.memory!, loaded: false, node: null },
                } : {}),
            })
        }
        return settings(input, init)
    }
}

window.fetch = progressFetch()
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never)
useAuthStore.setState({ permissions: { sid: 'harness', global: ['system:admin'], ws: {} }, permissionsStatus: 'ready' } as never)
usePersonaStore.setState({ mode: lens })

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })

function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
    return (
        <section className="min-w-0 rounded-2xl border border-glass-border bg-canvas-elevated/60 p-4">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{title}</h2>
            {note && <p className="mt-0.5 text-[11.5px] text-ink-secondary">{note}</p>}
            <div className="mt-3">{children}</div>
        </section>
    )
}

/** Every state of the component: a card's block, and the chips hosts set it in. */
function States() {
    return (
        <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(PROGRESS_STATES).map(([name, s]) => (
                <Panel key={name} title={s.title} note={`state=${name}`}>
                    <UpdateProgress progress={s.progress} />
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] font-medium">
                        <span className="flex min-w-0 items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                            <UpdateProgress progress={s.progress} variant="chip" />
                        </span>
                        {s.progress.total != null && (
                            <span className="flex min-w-0 items-center gap-1.5 rounded-md border border-glass-border bg-black/[0.04] px-2 py-0.5 text-ink-secondary dark:bg-white/[0.06]">
                                #213 shown · <UpdateProgress progress={s.progress} variant="chip" withVersion={false} />
                            </span>
                        )}
                    </div>
                </Panel>
            ))}
        </div>
    )
}

/** Each place it shows, for the graph whose version 214 is being written. */
function Places() {
    return (
        <div className="grid gap-4">
            <Panel title="View header" note={`The sync chip, in the ${lens} lens (the header shows it from 640 px wide)`}>
                {/* As the view header sets it. */}
                <SyncStatusChip workspaceId={WS} dataSourceId="ds_sales" viewId="v1" className="ml-1.5 hidden sm:inline-flex" />
            </Panel>
            <Panel title="Canvas versioning bar" note="The refreshing badge and the read-route chip">
                {/* As the canvas's versioning bar lays them out. */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-glass-border bg-black/[0.025] px-3 py-1.5 text-sm dark:bg-white/[0.025]">
                    <RefreshingBadge workspaceId={WS} graphId={GRAPH} />
                    <ReadRouteChip workspaceId={WS} graphId={GRAPH} isDraft={false} />
                </div>
            </Panel>
            <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="Data health" note="The fast read layer">
                    <ProjectionHealthCard wsId={WS} graphId={GRAPH} />
                </Panel>
                <Panel title="Graph settings drawer" note="Health now">
                    <GraphHealthPanel workspaceId={WS} graphId={GRAPH} enabled />
                </Panel>
            </div>
        </div>
    )
}

export function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
    }, [setTheme])
    return (
        <div className="min-h-screen bg-canvas p-4 text-ink sm:p-6">
            <MemoryRouter>
                <h1 className="mb-4 text-sm font-semibold text-ink">
                    Update progress · {view === 'states' ? 'every state' : PROGRESS_STATES[stateName]?.title ?? stateName}
                </h1>
                {view === 'states' && <States />}
                {view === 'places' && <Places />}
                {view === 'drawer' && <GraphSettingsDrawer workspaceId={WS} graphId={GRAPH} open onOpenChange={() => {}} label="Sales lineage" />}
            </MemoryRouter>
        </div>
    )
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <Harness />
        </QueryClientProvider>
    </StrictMode>,
)
