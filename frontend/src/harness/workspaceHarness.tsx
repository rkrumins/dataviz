/**
 * Visual harness for the workspace page.
 *
 * Renders the REAL WorkspaceDetailPage with `fetch` answered from fixtures, so
 * each reader's view of it can be looked at without a backend, three accounts
 * and a workspace in each state:
 *
 *   npx vite --port 5199 --strictPort
 *   open http://localhost:5199/workspace-harness.html?as=admin&fixture=failing&tab=data&section=processing
 *
 *   as       viewer | member | admin            (default viewer)
 *   fixture  populated | failing | empty | playground  (default populated)
 *   mode     business | technical               (default business)
 *   theme    light | dark
 *   tab / section / ds — passed to the page's own address
 *   page     workspace | reviews | playground-card | request-wizard | workspace-requests
 *            (reviews: the Review Center at /reviews; playground-card: the Playground card,
 *            &joined=0 before joining; request-wizard: asking for a workspace; workspace-requests:
 *            the platform team's queue, and &status=pending|changes_requested|approved|declined on
 *            page=workspace the reader's own request card)
 *
 * `npm run harness:workspace` drives Chromium over the main combinations and
 * writes PNGs to .harness/.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import '../styles/globals.css'
import { usePreferencesStore } from '../store/preferences'
import { usePersonaStore } from '../store/persona'
import { useAuthStore } from '../store/auth'
import { ViewEditorContext } from '../components/layout/viewEditorContext'
import { WorkspaceDetailPage } from '../pages/WorkspaceDetailPage'
import { ReviewCenterPage } from '../pages/ReviewCenterPage'
import { PlaygroundCard } from '../components/playground/PlaygroundCard'
import { RequestWorkspaceWizard } from '../components/workspace-requests/RequestWorkspaceWizard'
import { WorkspaceRequestsPanel } from '../components/workspace-requests/WorkspaceRequestsPanel'
import { WorkspaceRequestPrompt } from '../components/workspace-requests/WorkspaceRequestCard'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { useWorkspacesStore } from '../store/workspaces'
import {
    ONTOLOGIES, STATS, readinessOf, viewsOf, workspaceOf, type WorkspaceFixtureName,
} from './workspaceFixtures'

const params = new URLSearchParams(window.location.search)
const as = (params.get('as') ?? 'viewer') as 'viewer' | 'member' | 'admin'
const fixture = (params.get('fixture') ?? 'populated') as WorkspaceFixtureName
const dark = params.get('theme') === 'dark'
const mode = (params.get('mode') ?? 'business') as 'business' | 'technical'
const page = params.get('page') ?? 'workspace'

// The Review Center's reviews, across three workspaces.
const REVIEW_WS = [
    { id: 'ws_fin', name: 'Finance Risk' }, { id: 'ws_ops', name: 'Operations' }, { id: 'ws_mkt', name: 'Marketing Insights' },
]
const reviewRow = (n: number, title: string, ws: { id: string; name: string }, h: number, who: string) => ({
    prId: `pr_${n}`, title, graphId: 'g', targetGraphId: 'g', sourceBranchId: `b_${n}`, sourceBranchName: title.toLowerCase().replace(/\W+/g, '-').slice(0, 24),
    targetBranch: 'main', status: 'open', createdAt: new Date(Date.now() - h * 7_200_000).toISOString(),
    updatedAt: new Date(Date.now() - h * 3_600_000).toISOString(), lastActivityAt: new Date(Date.now() - h * 3_600_000).toISOString(),
    actor: `u_${n}`, userNames: { [`u_${n}`]: who }, workspaceId: ws.id, workspaceName: ws.name, unread: n % 2 === 0,
})
const REVIEWS = [
    reviewRow(1, 'Reclassify counterparty tiers', REVIEW_WS[0], 1, 'Ada Okafor'),
    reviewRow(2, 'Add EMEA settlement feeds', REVIEW_WS[1], 3, 'Liam Chen'),
    reviewRow(3, 'Retire legacy GL mappings', REVIEW_WS[0], 7, 'Priya Nair'),
    reviewRow(4, 'Campaign attribution owners', REVIEW_WS[2], 20, 'Tom Weiss'),
]
// A workspace request: Ada's proof of concept, with a teammate and a Playground graph.
const WS_REQUEST = {
    id: 'wsr_1', requesterId: 'usr_ada', requesterName: 'Ada Okafor', name: 'ML platform lineage', purpose: 'poc',
    description: 'Where every feature in the ML platform comes from, for the model review board.',
    teamName: 'ML Engineering', teammateIds: ['usr_ben'], teammates: [{ id: 'usr_ben', displayName: 'Ben Hall' }],
    playgroundSourceIds: ['ds_pg_ml'], playgroundSources: [{ id: 'ds_pg_ml', label: 'ML feature pipeline', viewCount: 2 }],
    dataNeeds: 'Snowflake ML marts and the dbt project “features”.', note: 'We’d like it before the January model review.',
    status: 'pending', createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
}
const centerCounts = (rows: unknown[]) => ({ counts: { needs_review: rows.length, waiting: 1, sent_back: 1, ready: 0, open: rows.length + 2, done: 9 }, unread: { needs_review: 2 }, capped: false })

const PERMS: Record<typeof as, string[]> = {
    viewer: ['workspace:view:read', 'workspace:datasource:read', 'workspace:ontology:read'],
    member: ['workspace:view:read', 'workspace:view:create', 'workspace:view:edit', 'workspace:view:delete',
        'workspace:datasource:read', 'workspace:datasource:manage', 'workspace:ontology:read'],
    // As the server sends them: `workspace:admin` comes with every workspace leaf,
    // collapsed to wildcards (permission_service._fold_sets / _collapse_wildcards).
    admin: ['workspace:admin', 'workspace:view:*', 'workspace:datasource:*', 'workspace:members:*',
        'workspace:ontology:*', 'workspace:catalog:*', 'workspace:provider:*'],
}

// ── fetch, answered from the fixtures ─────────────────────────────────
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const p = url.pathname
    if (!p.startsWith('/api/')) return realFetch(input, init)
    const ws = workspaceOf(fixture)
    const views = viewsOf(fixture)
    let m: RegExpMatchArray | null
    if (p === '/api/v1/me/workspace-requests') {
        const status = params.get('status')
        return json(status ? [{ ...WS_REQUEST, requesterId: 'usr_me', status,
            question: status === 'changes_requested' ? 'Which team will own it once the project ends?' : null,
            resolutionNote: status === 'declined' ? 'Finance Data already covers this — ask to join it.' : null,
            resolvedAt: status === 'approved' || status === 'declined' ? new Date().toISOString() : null,
            workspaceId: status === 'approved' ? 'ws_new' : null }] : [])
    }
    if (p === '/api/v1/admin/workspace-requests') return json([WS_REQUEST, { ...WS_REQUEST, id: 'wsr_2', name: 'Quarter-end reporting', purpose: 'reporting',
        requesterName: 'Liam Chen', teammateIds: [], playgroundSourceIds: [], status: 'changes_requested', createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }])
    if (p.startsWith('/api/v1/admin/workspace-requests/')) return json(WS_REQUEST)
    if (p === '/api/v1/directory') return json({ users: [{ id: 'usr_ada', displayName: 'Ada Okafor', email: 'ada@example.com' }, { id: 'usr_ben', displayName: 'Ben Hall', email: 'ben@example.com' }], groups: [] })
    if (p === '/api/v1/playground') {
        return json({
            enabled: true, exists: true, workspaceId: 'ws_fin', name: 'Playground', joined: params.get('joined') !== '0',
            graphQuota: 5, graphsUsed: 2, canSetUp: as === 'admin', sandboxProviderId: 'prov_sandbox',
        })
    }
    if ((m = p.match(/^\/api\/v1\/admin\/workspaces\/([^/]+)$/))) return json(ws)
    if (p === '/api/v1/admin/workspaces' || p === '/api/v1/admin/workspaces/') {
        return json(page === 'reviews' ? REVIEW_WS.map(w => ({ ...w, dataSources: [], isDefault: false, isActive: true, createdAt: '', updatedAt: '' })) : [ws])
    }
    if (p === '/api/v1/admin/workspaces/datasources/cached-stats') {
        const data = Object.fromEntries(ws.dataSources.map(d => [`ws_fin/${d.id}`, STATS[d.id]]))
        return json({ data, meta: {
            status: 'fresh', source: 'cache', age_seconds: 30, ttl_seconds: 300, missing_fields: [],
            data_source_id: '', stats_service_status: 'ok', provider_health: 'healthy', refreshing: false,
        } })
    }
    if ((m = p.match(/^\/api\/v1\/admin\/data-sources\/([^/]+)\/readiness$/))) return json(readinessOf(fixture, m[1]))
    if (p === '/api/v1/admin/ontologies' || p === '/api/v1/admin/ontologies/') return json(ONTOLOGIES)
    if (p.startsWith('/api/v1/admin/catalog') || p.startsWith('/api/v1/admin/providers')) return json([])
    if (p === '/api/v1/views/' || p === '/api/v1/views') {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const items = views.slice(0, limit)
        return json({ items, total: views.length, hasMore: false, nextOffset: null, popular: [] })
    }
    if (p === '/api/v1/views/me/recent') {
        return json(views.slice(0, 3).map((v, i) => ({
            viewId: v.id, viewName: v.name, viewType: v.viewType, workspaceId: 'ws_fin', workspaceName: 'Finance Risk',
            dataSourceId: v.dataSourceId, dataSourceName: v.dataSourceName, visitedAt: new Date(Date.now() - (i + 1) * 5_400_000).toISOString(),
        })))
    }
    if (p === '/api/v1/insights/views') {
        const ids = (url.searchParams.get('ids') ?? '').split(',')
        return json({ views: Object.fromEntries(ids.map((id, i) => [id, {
            viewId: id, opens: 240 - i * 37, uniqueViewers: 14 - i * 2, lastOpenedAt: new Date().toISOString(), trend: [],
        }])) })
    }
    if (p === '/api/v1/insights/workspaces') {
        return json({ workspaces: { ws_fin: fixture === 'empty'
            ? { workspaceId: 'ws_fin', views: 0, opens: 0, uniqueViewers: 0, topView: null, windowDays: 30 }
            : { workspaceId: 'ws_fin', views: 8, opens: 1_284, uniqueViewers: 23, topView: { viewId: 'v_exposure', name: 'Counterparty exposure lineage', opens: 412 }, windowDays: 30 } } })
    }
    if (p === '/api/v1/review-inbox/counts') {
        return json({ ...centerCounts(REVIEWS), byWorkspace: Object.fromEntries(REVIEW_WS.map(w => [w.id, centerCounts(REVIEWS.filter(r => r.workspaceId === w.id))])) })
    }
    if (p === '/api/v1/review-inbox') {
        const only = url.searchParams.getAll('workspaceId')
        const rows = only.length ? REVIEWS.filter(r => only.includes(r.workspaceId)) : REVIEWS
        return json({ ...centerCounts(rows), byWorkspace: {}, queue: url.searchParams.get('queue') ?? 'needs_review', items: rows, total: rows.length })
    }
    if (p.endsWith('/review-inbox') && page === 'reviews') {
        const wsId = p.split('/')[3]
        const rows = REVIEWS.filter(r => r.workspaceId === wsId)
        return json({ ...centerCounts(rows), queue: url.searchParams.get('queue') ?? 'needs_review', items: rows, total: rows.length })
    }
    if (p.endsWith('/review-inbox/counts')) {
        return json({ counts: { needs_review: as === 'viewer' ? 0 : 2, waiting: 1, sent_back: 0, ready: 0, open: 3, done: 12 }, unread: {}, capped: false })
    }
    if (p.includes('/access-requests') || p.includes('/to-answer')) return json(as === 'admin' ? [{ id: 'ar1' }, { id: 'ar2' }, { id: 'ar3' }] : [])
    if (p.includes('/drafts/owner-left')) return json([])
    if (p.includes('transfer')) return json([])
    if (p.includes('/activity')) {
        if (fixture === 'empty') return json([])
        const row = (i: number, action: string, viewName: string, actorName: string, summary: string, h: number) => ({
            id: `act${i}`, viewId: `v${i}`, action, actor: `usr_${i}`, actorName, actorEmail: null, summary, changes: null,
            createdAt: new Date(Date.now() - h * 3_600_000).toISOString(), viewName, workspaceId: 'ws_fin', workspaceName: 'Finance Risk',
        })
        return json([
            row(1, 'updated', 'Counterparty exposure lineage', 'Ada Okafor', 'Updated the layout', 1),
            row(2, 'created', 'VaR model inputs', 'Liam Chen', 'Created "VaR model inputs"', 5),
            row(3, 'visibility_changed', 'FR Y-9C return sources', 'Ada Okafor', 'Shared with everyone', 26),
            row(4, 'favourited', 'Chart of accounts', 'Priya Nair', 'Favourited', 30),
        ])
    }
    console.warn('[harness] unanswered', p + url.search)
    return json([])
}

// ── the reader ────────────────────────────────────────────────────────
useAuthStore.setState({
    status: 'authenticated', isAuthenticated: true, permissionsStatus: 'ready',
    user: { id: 'usr_me', firstName: 'Sam', lastName: 'Reader', email: 'sam@example.com' },
    permissions: { sid: 'harness', global: page === 'workspace-requests' ? ['system:workspaces:create'] : [], ws: { ws_fin: PERMS[as] } },
} as never)
usePersonaStore.setState({ mode })
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, workspaceRequestsEnabled: true } })
if (page === 'request-wizard') useWorkspacesStore.setState({ workspaces: [workspaceOf('playground')] } as never)
if (page === 'reviews') useWorkspacesStore.setState({ workspaces: REVIEW_WS.map(w => ({ ...w, dataSources: [] })) } as never)

function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
        document.body.style.background = getComputedStyle(document.documentElement).getPropertyValue('--nx-bg-canvas').trim() || '#fff'
    }, [setTheme])

    const address = new URLSearchParams()
    for (const k of ['tab', 'section', 'ds', 'dstab']) { const v = params.get(k); if (v) address.set(k, v) }
    const at = ['playground-card', 'request-wizard', 'workspace-requests', 'request-card'].includes(page) ? `/${page}` : page === 'reviews'
        ? `/reviews${params.get('workspace') ? `?workspace=${params.get('workspace')}` : ''}`
        : `/workspaces/ws_fin${address.toString() ? `?${address}` : ''}`

    return (
        <QueryClientProvider client={qc}>
            <ViewEditorContext.Provider value={{ openViewEditor: () => {}, closeViewEditor: () => {} }}>
                <MemoryRouter initialEntries={[at]}>
                    <div className="relative min-h-screen bg-canvas">
                        <Routes>
                            <Route path="/workspaces/:wsId" element={<WorkspaceDetailPage />} />
                            <Route path="/reviews" element={<ReviewCenterPage />} />
                            <Route path="/request-wizard" element={<RequestWorkspaceWizard onClose={() => {}} />} />
                            <Route path="/workspace-requests" element={
                                <div className="mx-auto max-w-5xl space-y-6 p-8">
                                    <WorkspaceRequestsPanel />
                                </div>
                            } />
                            <Route path="/request-card" element={<div className="mx-auto max-w-5xl p-8"><WorkspaceRequestPrompt /></div>} />
                            <Route path="/playground-card" element={
                                <div className="mx-auto max-w-5xl space-y-6 p-8">
                                    <PlaygroundCard />
                                    <PlaygroundCard compact />
                                </div>
                            } />
                        </Routes>
                    </div>
                </MemoryRouter>
            </ViewEditorContext.Provider>
        </QueryClientProvider>
    )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
