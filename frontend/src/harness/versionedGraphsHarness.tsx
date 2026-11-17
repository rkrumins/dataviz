/**
 * Visual harness for the versioned-graph settings pages: Admin → Versioned graphs, a workspace's
 * Versioned graphs tab and a data source's Versioning tab. The REAL components — their own queries,
 * editor and dialogs — against `versionedGraphsFetch`, an in-memory settings API. No backend, no
 * auth. Every state is a URL away, in both themes and at any width;
 * `scripts/versioned-graphs-shot.mjs` drives it in Chromium (staging, Review, the drawer) and writes
 * PNGs to .harness/.
 *
 *   npm run harness
 *   open http://localhost:5199/versioned-graphs-harness.html?tab=settings&lens=business&theme=dark
 *
 *   page       admin | workspace | datasource (default admin)
 *   tab        admin: overview | settings | history (default overview);
 *              workspace: defaults | graphs | history (default defaults)
 *   lens       business | operator (the persona the page opens on)
 *   scenario   ok | loading | error | empty | readonly | workspace-admin | fork | conflict
 *              (`ok` is a system admin; `readonly` someone who may only read)
 *   drawer     1: a graph's settings drawer, open (admin page)
 *   theme      `dark` for the dark palette
 *   coach      1: the guided setup's coach mark, as a first visit in the Business view shows it
 *              (otherwise it is marked seen, so every other shot is of the page alone)
 *   motion     1: animations run (confetti mid-flight); otherwise each lands on its end state
 *
 * The app's motion policy applies as in the app: the OS's reduced motion (a browser's emulation of
 * it) quiets framer-motion and the guide's confetti.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig, MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import '../styles/globals.css'
import { AdminVersionedGraphs } from '../components/admin/AdminVersionedGraphs'
import { GraphSettingsDrawer } from '../components/admin/AdminVersionedGraphs/GraphSettingsDrawer'
import { WorkspaceVersionedGraphs } from '../components/admin/AdminVersionedGraphs/WorkspaceVersionedGraphs'
import { markSetupIntroSeen } from '../components/admin/AdminVersionedGraphs/setupIntro'
import { PageContainer } from '../components/layout/PageContainer'
import { markPersonaIntroSeen } from '../components/persona/personaIntro'
import { NotificationStack } from '../components/ui/notifications'
import { DataSourceVersioningTab } from '../features/versioning/components/DataSourceVersioningTab'
import { useAuthStore } from '../store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePersonaStore } from '../store/persona'
import { usePreferencesStore } from '../store/preferences'
import { GRAPH, WS, versionedGraphsFetch, type Scenario } from './versionedGraphsFixtures'

const params = new URLSearchParams(window.location.search)
const page = params.get('page') ?? 'admin'
const scenario = (params.get('scenario') ?? 'ok') as Scenario
const tab = params.get('tab') ?? (page === 'workspace' ? 'defaults' : 'overview')
const dark = params.get('theme') === 'dark'
const drawer = params.get('drawer') === '1'

// Every animation lands on its end state at once: a screenshot otherwise catches a panel mid-slide.
if (params.get('motion') !== '1') {
    MotionGlobalConfig.skipAnimations = true
    const still = document.createElement('style')
    still.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }'
    document.head.appendChild(still)
}
// The guided setup's coach mark only when asked for. It waits for the Business view's own intro,
// which shows on the app's top bar: there is none here, so that one counts as seen.
if (params.get('coach') === '1') markPersonaIntroSeen()
else markSetupIntroSeen()

window.fetch = versionedGraphsFetch(scenario)
useFeaturesStore.setState({
    values: { ...DEFAULT_FEATURES, versioningEnabled: true, forksEnabled: true, residencyEnabled: true, candidateKeysEnabled: false },
} as never)
// Admin: a system admin. A workspace's and a data source's pages: as the scenario says who is looking.
const WS_ADMIN = ['workspace:admin', 'workspace:datasource:read', 'workspace:datasource:manage', 'workspace:datasource:publish']
const asWorkspace = page !== 'admin' && (scenario === 'readonly' || scenario === 'workspace-admin')
const permissions = asWorkspace
    ? { sid: 'harness', global: [], ws: { [WS]: scenario === 'readonly' ? ['workspace:datasource:read'] : WS_ADMIN } }
    : { sid: 'harness', global: ['system:admin'], ws: {} }
useAuthStore.setState({ permissions, permissionsStatus: 'ready' } as never)
usePersonaStore.setState({ mode: params.get('lens') === 'business' ? 'business' : 'technical' })

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

/** The workspace's page around its Versioned graphs tab: its name and its section tabs; the tab can send you to Data Sources. */
function WorkspacePage() {
    const sections = ['Data Sources', 'Views', 'Aggregation', 'Ontology', 'Reviews', 'Versioned graphs', 'Members', 'Activity']
    const [section, setSection] = useState('Versioned graphs')
    return (
        <PageContainer className="py-8">
            <p className="text-sm text-ink-muted">Workspaces / <span className="font-medium text-ink">Finance</span></p>
            <h2 className="mt-3 text-2xl font-bold text-ink">Finance</h2>
            <div className="mt-6 flex items-center gap-1 overflow-x-auto border-b border-glass-border" aria-hidden>
                {sections.map((s) => (
                    <span key={s} className={s === section
                        ? 'whitespace-nowrap border-b-2 border-indigo-500 px-5 py-3 text-sm font-semibold text-indigo-600 dark:text-indigo-400'
                        : 'whitespace-nowrap border-b-2 border-transparent px-5 py-3 text-sm font-semibold text-ink-muted'}>{s}</span>
                ))}
            </div>
            {section === 'Versioned graphs'
                ? <WorkspaceVersionedGraphs workspaceId={WS} workspaceName="Finance" onOpenDataSources={() => setSection('Data Sources')} />
                : <p className="py-8 text-sm text-ink-secondary">The workspace’s data sources, on the real page.</p>}
        </PageContainer>
    )
}

/** A data source's detail panel, on its Versioning tab. */
function DataSourcePanel() {
    return (
        <div className="flex min-h-screen justify-end bg-black/30">
            <aside className="w-full max-w-2xl border-l border-glass-border/60 bg-canvas-elevated px-6 py-6">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Data source</p>
                <h2 className="mt-0.5 text-lg font-semibold text-ink">Sales lineage</h2>
                <div className="mt-4 mb-5 flex gap-4 border-b border-glass-border text-sm font-medium" aria-hidden>
                    {['Overview', 'Views', 'Profiling', 'Versioning'].map((t) => (
                        <span key={t} className={t === 'Versioning' ? '-mb-px border-b-2 border-accent-lineage pb-2 text-ink' : 'pb-2 text-ink-muted'}>{t}</span>
                    ))}
                </div>
                <DataSourceVersioningTab wsId={WS} dataSourceId="ds_sales" label="Sales lineage" />
            </aside>
        </div>
    )
}

export function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    const calm = usePreferencesStore((s) => s.reducedMotion)
    const [open, setOpen] = useState(drawer)
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
    }, [setTheme])
    const start = page === 'workspace' ? `/workspaces/${WS}?tab=versioned-graphs&vg=${tab}${window.location.hash}`
        : page === 'datasource' ? `/workspaces/${WS}?ds=ds_sales&dstab=versioning`
            : `/admin/versioned-graphs?tab=${tab}${window.location.hash}`
    return (
        // The app's motion policy (App.tsx): its calm mode, else the OS's setting.
        <MotionConfig reducedMotion={calm ? 'always' : 'user'}>
            <div className="min-h-screen bg-canvas text-ink">
                <MemoryRouter initialEntries={[start]}>
                    <Routes>
                        <Route path="/admin/versioned-graphs" element={<AdminVersionedGraphs />} />
                        <Route path="/workspaces/:wsId" element={page === 'datasource' ? <DataSourcePanel /> : <WorkspacePage />} />
                        <Route path="*" element={<p className="p-8 text-sm">Left the page.</p>} />
                    </Routes>
                    {drawer && page === 'admin' && <GraphSettingsDrawer workspaceId={WS} graphId={GRAPH} open={open} onOpenChange={setOpen} label="Sales lineage" />}
                </MemoryRouter>
                <NotificationStack />
            </div>
        </MotionConfig>
    )
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <Harness />
        </QueryClientProvider>
    </StrictMode>,
)
