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
 *   fixture  populated | failing | empty        (default populated)
 *   mode     business | technical               (default business)
 *   theme    light | dark
 *   tab / section / ds — passed to the page's own address
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
import {
    ONTOLOGIES, STATS, readinessOf, viewsOf, workspaceOf, type WorkspaceFixtureName,
} from './workspaceFixtures'

const params = new URLSearchParams(window.location.search)
const as = (params.get('as') ?? 'viewer') as 'viewer' | 'member' | 'admin'
const fixture = (params.get('fixture') ?? 'populated') as WorkspaceFixtureName
const dark = params.get('theme') === 'dark'
const mode = (params.get('mode') ?? 'business') as 'business' | 'technical'

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
    if ((m = p.match(/^\/api\/v1\/admin\/workspaces\/([^/]+)$/))) return json(ws)
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
    permissions: { sid: 'harness', global: [], ws: { ws_fin: PERMS[as] } },
} as never)
usePersonaStore.setState({ mode })

function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
        document.body.style.background = getComputedStyle(document.documentElement).getPropertyValue('--nx-bg-canvas').trim() || '#fff'
    }, [setTheme])

    const page = new URLSearchParams()
    for (const k of ['tab', 'section', 'ds', 'dstab']) { const v = params.get(k); if (v) page.set(k, v) }
    const at = `/workspaces/ws_fin${page.toString() ? `?${page}` : ''}`

    return (
        <QueryClientProvider client={qc}>
            <ViewEditorContext.Provider value={{ openViewEditor: () => {}, closeViewEditor: () => {} }}>
                <MemoryRouter initialEntries={[at]}>
                    <div className="relative min-h-screen bg-canvas">
                        <Routes><Route path="/workspaces/:wsId" element={<WorkspaceDetailPage />} /></Routes>
                    </div>
                </MemoryRouter>
            </ViewEditorContext.Provider>
        </QueryClientProvider>
    )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
