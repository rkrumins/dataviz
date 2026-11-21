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
 *   page     workspace | reviews | playground-card | request-wizard | workspace-requests | groups | workspaces
 *            | dashboard | data-requests | data-request-wizard
 *            (reviews: the Review Center at /reviews; playground-card: the Playground card,
 *            &joined=0 before joining; request-wizard: asking for a workspace; workspace-requests:
 *            the platform team's queue, and &status=pending|changes_requested|approved|declined on
 *            page=workspace the reader's own request card); groups: the People tab's Groups
 *            panel (&platform=1 as a platform administrator, with the links waiting to confirm);
 *            workspaces: the Workspaces page, &tab=requests its queue; dashboard: the Dashboard, led by &mode;
 *            data-requests: the platform team's queue of requests for data; data-request-wizard: Ask
 *            for data. On page=workspace, Data → Sources lists the workspace's data requests too
 *   creator  1 — the reader may create workspaces (and so answers requests for them)
 *   tour / step — start that tour at that step (0-based) once the page has loaded
 *   details  0 — data source details off (on by default): the About card, badges, tags,
 *            the Sources filter and a source's Activity tab (open one with &ds=…&dstab=activity)
 *   steward  1 — the reader is a named Steward of every source, so may change its status
 *   click    a button's text, clicked once the page has loaded (e.g. "Edit details"; "Start"
 *            starts the first Playground sample, and it stays starting)
 *   fresh    1 — fixture=playground before the reader's first graph (their graphs and views gone)
 *   full     1 — fixture=playground with every graph of the reader's used
 *   sample   done — starting a sample answers (its Context View opens, with the notification)
 *            instead of staying on "Starting…"; &tours=1 offers the canvas tour in it
 *   byod     ok | errors — after &click=Bring your own data, the template files (errors: with a
 *            connection naming a key no thing has) are dropped on the dialog
 *   page=view     a sample's Context View: its header (the Playground chip), on the Playground
 *   page=publish  publishing a draft of one's own Playground graph as its maker (&as=member:
 *                 no publish permission — the server's canPublish says yes; &maker=0 says no)
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
import { WorkspaceGroupsPanel } from '../components/workspaces/WorkspaceGroupsPanel'
import { IdpLinkRequestsPanel } from '../components/workspaces/IdpLinkRequestsPanel'
import { WorkspacesPage } from '../pages/WorkspacesPage'
import { Dashboard } from '../components/dashboard/Dashboard'
import { TourOverlay } from '../features/tour/TourOverlay'
import { useTourStore } from '../features/tour/tourStore'
import { useProviderStatusStore } from '../store/providerStatus'
import { AskForDataWizard, AskForDataWizardHost } from '../components/data-requests/AskForDataWizard'
import { DataRequestsPanel } from '../components/data-requests/DataRequestsPanel'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { useWorkspacesStore } from '../store/workspaces'
import { NotificationStack } from '../components/ui/notifications'
import { ViewPageHeader } from '../components/views/ViewPageHeader'
import { CommitDialog } from '../features/versioning/components/CommitDialog'
import { useActiveDraftAccess } from '../features/versioning/hooks/useActiveDraftAccess'
import { buildChangeSet } from '../features/versioning/model/changeModel'
import { TEMPLATE_FILES } from '../components/playground/ownData'
import {
    ONTOLOGIES, STATS, contactsOf, metadataOf, readinessOf, sourceActivityOf, viewsOf, workspaceOf, type WorkspaceFixtureName,
} from './workspaceFixtures'

const params = new URLSearchParams(window.location.search)
const as = (params.get('as') ?? 'viewer') as 'viewer' | 'member' | 'admin'
const fixture = (params.get('fixture') ?? 'populated') as WorkspaceFixtureName
const dark = params.get('theme') === 'dark'
const mode = (params.get('mode') ?? 'business') as 'business' | 'technical'
const page = params.get('page') ?? 'workspace'
const tour = params.get('tour')
const tourStep = Number(params.get('step') ?? 0)
const platform = params.get('platform') === '1'
const steward = params.get('steward') === '1'
const click = params.get('click')
const fresh = params.get('fresh') === '1'
const full = params.get('full') === '1'
const sampleDone = params.get('sample') === 'done'
const byod = params.get('byod')
/** Without the reader's own rows, before their first graph (`&fresh=1`). */
const notMine = <T,>(rows: readonly T[]): T[] => rows.filter(r => !fresh || (r as { createdBy?: string }).createdBy !== 'usr_me')
const graphsUsed = full ? 5 : fresh ? 0 : 2

// The People tab's groups: two of the workspace's own, one following the directory and one
// whose link waits; and a platform-wide group bound here.
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const person = (id: string, displayName: string) => ({ id, displayName })
const GROUPS = [
    { id: 'grp_eng', name: 'Finance Risk · Engineers', shortName: 'Engineers', description: 'The people who build and fix the lineage',
        owned: true, role: 'workspace_member', roleLabel: 'Member', memberCount: 7, source: 'local',
        memberPreview: [person('usr_ada', 'Ada Okafor'), person('usr_ben', 'Ben Hall'), person('usr_cy', 'Cy Park'), person('usr_di', 'Dina Roy')],
        idpLinks: [{ mappingId: 'map_1', idpGroup: 'AD-FinRisk-Engineers', providerName: 'Entra ID' }], pendingIdpLink: null, createdAt: ago(400) },
    { id: 'grp_view', name: 'Finance Risk · Analysts', shortName: 'Analysts', description: null,
        owned: true, role: 'workspace_viewer', roleLabel: 'Viewer', memberCount: 23, source: 'local',
        memberPreview: [person('usr_li', 'Liam Chen'), person('usr_pr', 'Priya Nair'), person('usr_ow', 'Owen Diaz')],
        idpLinks: [], pendingIdpLink: { requestId: 'ilr_1', idpGroup: 'AD-FinRisk-Analysts', requestedBy: 'usr_me', requestedByName: 'Sam Reader', requestedAt: ago(20) }, createdAt: ago(200) },
    { id: 'grp_pub', name: 'Finance Risk · Publishers', shortName: 'Publishers', description: null,
        owned: true, role: 'workspace_publisher', roleLabel: 'Publisher', memberCount: 2, source: 'local',
        memberPreview: [person('usr_ada', 'Ada Okafor'), person('usr_me', 'Sam Reader')], idpLinks: [], pendingIdpLink: null, createdAt: ago(100) },
    { id: 'grp_all', name: 'All risk analysts', shortName: 'All risk analysts', description: null,
        owned: false, role: 'workspace_viewer', roleLabel: 'Viewer', memberCount: 140, source: 'sso',
        memberPreview: [person('usr_x1', 'Mo Adams'), person('usr_x2', 'Kit Ng'), person('usr_x3', 'Rae Holm')], idpLinks: [], pendingIdpLink: null, createdAt: ago(900) },
]
const GROUP_MEMBERS = [
    { id: 'usr_ada', displayName: 'Ada Okafor', email: 'ada@example.com', source: 'local', addedAt: ago(300) },
    { id: 'usr_ben', displayName: 'Ben Hall', email: 'ben@example.com', source: 'sso', addedAt: ago(30) },
    { id: 'usr_cy', displayName: 'Cy Park', email: 'cy@example.com', source: 'sso', addedAt: ago(30) },
]
const IDP_GROUPS = ['AD-FinRisk-Engineers', 'AD-FinRisk-Analysts', 'AD-Finance-All', 'AD-Risk-Managers']
const LINK_REQUESTS = [
    { id: 'ilr_1', groupId: 'grp_view', groupName: 'Finance Risk · Analysts', workspaceId: 'ws_fin', workspaceName: 'Finance Risk',
        idpGroup: 'AD-FinRisk-Analysts', providerId: null, requestedBy: 'usr_me', requestedByName: 'Sam Reader', requestedAt: ago(20),
        status: 'pending', source: 'workspace', seenCount: 18 },
    { id: 'ilr_2', groupId: 'grp_ml', groupName: 'ML lineage · Engineers', workspaceId: 'ws_ml', workspaceName: 'ML lineage',
        idpGroup: 'ML-Engineers', providerId: null, requestedBy: 'usr_ada', requestedByName: 'Ada Okafor', requestedAt: ago(52),
        status: 'pending', source: 'workspace_request', seenCount: 0 },
]

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
// The Playground's samples, as GET /playground/samples lists them.
const PLAYGROUND_SAMPLES = [
    { id: 'retail-pipeline', title: 'Retail data pipeline', icon: 'ShoppingCart', color: 'amber', nodeCount: 46, edgeCount: 58,
        description: 'Sales from the store, tills and payments, through the warehouse to the dashboards.',
        entityTypes: ['Source system', 'Ingestion job', 'Warehouse table', 'Transformation', 'Dashboard'] },
    { id: 'customer-360', title: 'Customer 360', icon: 'Users', color: 'sky', nodeCount: 36, edgeCount: 50,
        description: 'CRM, support and billing records matched into one view of each customer.',
        entityTypes: ['Business system', 'Source record', 'Unified entity', 'Profile', 'Report'] },
    { id: 'ml-features', title: 'ML feature pipeline', icon: 'BrainCircuit', color: 'emerald', nodeCount: 26, edgeCount: 33,
        description: 'Raw events becoming features, the models they train, and where predictions go.',
        entityTypes: ['Data source', 'Dataset', 'Feature set', 'Model', 'Application'] },
].map(s => ({ ...s, viewType: 'graph' }))
// A workspace request: Ada's proof of concept, with a teammate and a Playground graph.
const WS_REQUEST = {
    id: 'wsr_1', requesterId: 'usr_ada', requesterName: 'Ada Okafor', name: 'ML platform lineage', purpose: 'poc',
    description: 'Where every feature in the ML platform comes from, for the model review board.',
    teamName: 'ML Engineering', teammateIds: ['usr_ben'], teammates: [{ id: 'usr_ben', displayName: 'Ben Hall' }],
    playgroundSourceIds: ['ds_pg_ml'], playgroundSources: [{ id: 'ds_pg_ml', label: 'ML feature pipeline', viewCount: 2 }],
    groups: [
        { key: 'g1', name: 'Engineers', role: 'workspace_publisher', memberIds: ['usr_ben'], members: [{ id: 'usr_ben', displayName: 'Ben Hall' }], idpGroup: 'SG-ML-Engineers' },
        { key: 'g2', name: 'Stakeholders', role: 'workspace_viewer', memberIds: [], members: [], idpGroup: null },
    ],
    dataNeeds: 'Snowflake ML marts and the dbt project “features”.', note: 'We’d like it before the January model review.',
    status: 'pending', createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
}
// Data requests in Finance Risk: Snowflake marts waiting, dbt in progress, a file connected.
const DATA_REQUESTS = [
    {
        id: 'dr_1', workspaceId: 'ws_fin', workspaceName: 'Finance Risk', requestedBy: 'usr_me', requesterName: 'Sam Reader',
        title: 'Finance marts', system: 'snowflake', details: 'FIN_DB.MARTS — gl_balances, ap_invoices and the views on them',
        purpose: 'Trace month-end figures back to the ledger for the March audit.', urgency: 'this_month',
        contactIds: ['usr_ada'], contacts: [{ id: 'usr_ada', displayName: 'Ada Okafor' }], status: 'pending',
        createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    },
    {
        id: 'dr_2', workspaceId: 'ws_fin', workspaceName: 'Finance Risk', requestedBy: 'usr_liam', requesterName: 'Liam Chen',
        title: 'dbt project “core”', system: 'dbt', details: 'finance and marts models, and the sources they read', purpose: null,
        urgency: 'this_week', contactIds: [], contacts: [], status: 'in_progress', assigneeId: 'usr_olga', assigneeName: 'Olga Ivanova',
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
    {
        id: 'dr_3', workspaceId: 'ws_fin', workspaceName: 'Finance Risk', requestedBy: 'usr_priya', requesterName: 'Priya Nair',
        title: 'System inventory spreadsheet', system: 'file', details: null, purpose: null, urgency: 'no_rush', contactIds: [],
        contacts: [], status: 'connected', dataSourceId: 'ds_gl', dataSourceLabel: 'General ledger', resolutionNote: 'Loaded with the ledger.',
        createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString(), resolvedAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
]
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

// A sample started, as POST /playground/samples/{id} answers: its Context View opens first.
const STARTED_SAMPLE = {
    dataSourceId: 'ds_pg_retail', viewId: 'v_pg_ctx', viewIds: { context: 'v_pg_ctx', graph: 'v_pg_graph', hierarchy: 'v_pg_tree' },
    draftId: 'br_example', reviewId: 'pr_example',
}
const SAMPLE_VIEW = {
    id: 'v_pg_ctx', name: 'Retail data pipeline', viewType: 'context', layoutType: 'context', workspaceId: 'ws_fin', workspaceName: 'Playground',
    dataSourceId: 'ds_pg_retail', dataSourceName: 'Retail data pipeline', visibility: 'workspace', sourceKind: 'versioned',
    description: 'Sales from the store, tills and payments, through the warehouse to the dashboards — one layer per kind of thing.',
    config: { icon: 'ShoppingCart', content: { visibleEntityTypes: ['Source system', 'Ingestion job', 'Warehouse table', 'Transformation', 'Dashboard', 'Metric'] } },
    createdBy: 'usr_me', createdByName: 'Sam Reader', isPinned: false, favouriteCount: 0, isFavourited: false, tags: ['sample'],
    createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: new Date(Date.now() - 120_000).toISOString(),
    access: { canEdit: true, canManageGrants: true, canChangeVisibility: true, canPublish: false, canRequestPublish: false, accessVia: 'owner', dataAccess: 'full' },
}
// The example draft of a sample, as its maker reads it: theirs to publish (`canPublish`).
const EXAMPLE_FRESHNESS = {
    behind: false, behindBy: 0, mainHeadCommitSeq: 1, baseCommitSeq: 1, status: 'open', headCommitSeq: 2, visibility: 'private',
    access: { canRead: true, canWrite: true, canManage: true, canPublish: params.get('maker') !== '0' },
}
const DRAFTS_POLICY = {
    overrides: {}, workspace: {},
    effective: { defaultVisibility: 'private', levels: {}, selfApproval: true, selfMerge: true, requiredApprovals: 1, threadsHold: false, sources: {} },
}
const EXAMPLE_CHANGES = buildChangeSet([
    { entityId: 'urn:finance-dashboard', kind: 'node', status: 'added', label: 'Finance dashboard', origin: { source: 'committed' } },
    { entityId: 'urn:powers', kind: 'edge', status: 'added', label: 'POWERS', origin: { source: 'committed' } },
] as never)

// ── fetch, answered from the fixtures ─────────────────────────────────
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const p = url.pathname
    if (!p.startsWith('/api/')) return realFetch(input, init)
    const base = workspaceOf(fixture)
    const ws = { ...base, dataSources: notMine<(typeof base.dataSources)[number]>(base.dataSources) }
    const views = notMine<ReturnType<typeof viewsOf>[number]>(viewsOf(fixture))
    let m: RegExpMatchArray | null
    // A data source's details, contacts and history.
    if ((m = p.match(/^\/api\/v1\/admin\/workspaces\/ws_fin\/data-sources\/([^/]+)\/metadata(\/trust)?$/))) {
        const current = metadataOf(m[1], as, steward)
        if (init?.method !== 'PUT') return json(current)
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        const trust = m[2] ? { trustStatusBy: body.trustStatus ? { id: 'usr_me', displayName: 'Sam Reader', email: null, avatarId: null, hasImage: false, deleted: false } : null,
            trustStatusAt: body.trustStatus ? new Date().toISOString() : null } : {}
        return json({ ...current, ...body, ...trust, updatedAt: new Date().toISOString() })
    }
    if ((m = p.match(/^\/api\/v1\/admin\/workspaces\/ws_fin\/data-sources\/([^/]+)\/contacts$/))) return json(contactsOf(m[1], as))
    // The drawer's "Where this lives" card: no graph store here, so it stays out of the way.
    if (p === '/api/v1/admin/graph-store/placement') return new Response('{"detail":"Not Found"}', { status: 404 })
    if ((m = p.match(/^\/api\/v1\/admin\/workspaces\/ws_fin\/data-sources\/([^/]+)\/activity\/events$/))) {
        return json({ events: sourceActivityOf(m[1]), nextCursor: null })
    }
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
    if (p === '/api/v1/admin/workspaces/ws_fin/groups') return json(GROUPS)
    if (p.match(/^\/api\/v1\/admin\/workspaces\/ws_fin\/groups\/[^/]+\/members$/)) return json(GROUP_MEMBERS)
    if (p === '/api/v1/idp-groups/suggestions') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        return json(IDP_GROUPS.filter(g => g.toLowerCase().includes(q)).map((g, i) => ({ idpGroup: g, ...(platform ? { seenCount: 30 - i * 7 } : {}) })))
    }
    if (p === '/api/v1/admin/idp-groups/preview') {
        return json({ idpGroup: url.searchParams.get('idpGroup'), seenCount: 9,
            people: [person('usr_ada', 'Ada Okafor'), person('usr_ben', 'Ben Hall'), person('usr_cy', 'Cy Park'), person('usr_li', 'Liam Chen')],
            note: 'Who had this group at their last sign-in through your identity provider. Someone added to it since appears after their next one.' })
    }
    if (p === '/api/v1/admin/idp-link-requests') return json(LINK_REQUESTS)
    if (p === '/api/v1/admin/idp-providers') return json([{ id: 'idp_entra', displayName: 'Entra ID' }, { id: 'idp_okta', displayName: 'Okta' }])
    if (p === '/api/v1/admin/workspaces/ws_fin/data-requests') {
        return init?.method === 'POST' ? json({ ...DATA_REQUESTS[0], id: 'dr_new' }) : json(DATA_REQUESTS)
    }
    if (p === '/api/v1/admin/data-requests') return json(DATA_REQUESTS.filter(r => url.searchParams.get('status') === 'all' || ['pending', 'in_progress'].includes(r.status)))
    if ((m = p.match(/^\/api\/v1\/(?:admin|me)\/data-requests\/([^/]+)\/(start|connect|decline|withdraw)$/))) {
        const status = { start: 'in_progress', connect: 'connected', decline: 'declined', withdraw: 'withdrawn' }[m[2]]
        return json({ ...(DATA_REQUESTS.find(r => r.id === m![1]) ?? DATA_REQUESTS[0]), status, assigneeName: 'Sam Reader' })
    }
    if (p === '/api/v1/directory') return json({ users: [{ id: 'usr_ada', displayName: 'Ada Okafor', email: 'ada@example.com' }, { id: 'usr_ben', displayName: 'Ben Hall', email: 'ben@example.com' }], groups: [] })
    if (p === '/api/v1/playground') {
        return json({
            enabled: true, exists: true, workspaceId: 'ws_fin', name: 'Playground', joined: params.get('joined') !== '0',
            graphQuota: 5, graphsUsed, canSetUp: as === 'admin', sandboxProviderId: 'prov_sandbox',
        })
    }
    if (p === '/api/v1/playground/samples') return json({ quotaLeft: 5 - graphsUsed, samples: PLAYGROUND_SAMPLES })
    // Starting one stays starting — the card's spinner, for a screenshot — unless &sample=done:
    // then it answers as a sample does now, its Context View first, with an example review.
    if (p.startsWith('/api/v1/playground/samples/')) {
        return sampleDone ? json(STARTED_SAMPLE) : new Promise<Response>(() => {})
    }
    if (p === '/api/v1/playground/imports') {
        return json({ dataSourceId: 'ds_pg_coffee', viewId: 'v_pg_ctx', viewIds: { context: 'v_pg_ctx', graph: 'v_pg_graph' } }, 201)
    }
    // A sample's Context View, and publishing a draft of it as its maker.
    if (p === `/api/v1/views/${SAMPLE_VIEW.id}`) return json(SAMPLE_VIEW)
    if (p.endsWith('/branches/br_example/freshness')) return json(EXAMPLE_FRESHNESS)
    if (p.endsWith('/branches/br_example/view-changes')) return json({ branchId: 'br_example', views: [], hidden: 0 })
    if (p.endsWith('/drafts-policy')) return json(DRAFTS_POLICY)
    if (p === '/api/v1/admin/workspaces/summary') {
        const row = { id: ws.id, name: ws.name, isDefault: false, dataSources: ws.dataSources.length, activeDataSources: ws.dataSources.length,
            pendingDataSources: 0, nodes: 64_610, edges: 160_655, entityTypes: ['Table', 'Column', 'Report'], views: views.length, sources: {} }
        return json({ coverage: 'granted', totals: { workspaces: 1, dataSources: ws.dataSources.length, activeDataSources: ws.dataSources.length,
            pendingDataSources: 0, nodes: 64_610, edges: 160_655, entityTypes: ['Table', 'Column', 'Report'], views: views.length, sharedGraphs: 0 }, workspaces: [row] })
    }
    if (p === '/api/v1/admin/workspaces/summary/trend') return json({ days: [], workspaces: [], dataSources: [], views: [], nodes: [], edges: [] })
    if ((m = p.match(/^\/api\/v1\/admin\/data-sources\/([^/]+)\/projection-health$/))) {
        // In the failing workspace, Regulatory Reporting is also behind its published changes.
        const behind = fixture === 'failing' && m[1] === 'ds_reg'
        return json({ dataSourceId: m[1], projectorCurrent: behind ? false : true, projectionCommitsBehind: behind ? 3 : 0 })
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
    // The reader's own reviews and drafts, for the Playground's first steps: none before their first
    // graph; after it, a draft of their own (a review not yet).
    if (p.endsWith('/review-inbox')) {
        return json({ ...centerCounts([]), queue: url.searchParams.get('queue') ?? 'needs_review', items: [], total: 0 })
    }
    if (p === '/api/v1/views/me/drafts') {
        return json(fresh || fixture !== 'playground' ? [] : [{
            draftId: 'br_mine', graphId: 'g_pg_crm', viewId: 'v_pg_crm', viewName: 'Where leads go', viewType: 'graph', workspaceId: 'ws_fin',
            name: null, createdAt: ago(1), updatedAt: ago(0.5),
        }])
    }
    if (p.endsWith('/review-inbox/counts')) {
        return json({ counts: { needs_review: as === 'viewer' ? 0 : 2, waiting: 1, sent_back: 0, ready: 0, open: 3, done: 12 }, unread: {}, capped: false })
    }
    // Counted on the workspace page; the Workspaces page would list them in full, so none there.
    if (p.includes('/access-requests') || p.includes('/to-answer')) return json(as === 'admin' && page !== 'workspaces' ? [{ id: 'ar1' }, { id: 'ar2' }, { id: 'ar3' }] : [])
    if (p.includes('/drafts/owner-left')) return json([])
    if (p.includes('transfer')) return json([])
    if (p === '/api/v1/layout-templates') return json({ items: [], total: 0 })
    if (p.includes('/activity') || p === '/api/v1/views/me/feed') {
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
    permissions: { sid: 'harness', global: platform ? ['system:admin'] : page === 'workspace-requests' || page === 'data-requests' || params.get('creator') === '1' ? ['system:workspaces:create'] : [], ws: { ws_fin: PERMS[as] } },
} as never)
usePersonaStore.setState({ mode })
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true, workspaceRequestsEnabled: true, dataRequestsEnabled: true, toursEnabled: !!tour || params.get('tours') === '1',
    dataSourceMetadataEnabled: params.get('details') !== '0' } })
if (page === 'dashboard') {
    useProviderStatusStore.setState({ statuses: {
        prov_fdb: { id: 'prov_fdb', name: 'FalkorDB · finance', status: 'ready', lastCheckedAt: null },
        prov_neo: { id: 'prov_neo', name: 'Neo4j · risk models', status: fixture === 'failing' ? 'unavailable' : 'ready', lastCheckedAt: null, error: 'Connection refused' },
        prov_dh: { id: 'prov_dh', name: 'DataHub', status: 'ready', lastCheckedAt: null },
    } })
}
if (page === 'request-wizard') useWorkspacesStore.setState({ workspaces: [workspaceOf('playground')] } as never)
if (page === 'groups') useWorkspacesStore.setState({ workspaces: [{ id: 'ws_fin', name: 'Finance Risk' }] } as never)
if (page === 'reviews') useWorkspacesStore.setState({ workspaces: REVIEW_WS.map(w => ({ ...w, dataSources: [] })) } as never)

function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    const [qc] = useState(() => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        // `&ds=` opens a source's drawer only once the page knows the workspace: the page
        // drops a `ds` it cannot check yet, so the workspace is there from the first render.
        if (params.get('ds')) client.setQueryData(['workspace', 'ws_fin'], workspaceOf(fixture))
        return client
    })
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
        document.body.style.background = getComputedStyle(document.documentElement).getPropertyValue('--nx-bg-canvas').trim() || '#fff'
    }, [setTheme])
    // A button pressed once the page has loaded, for a form a screenshot cannot open.
    useEffect(() => {
        if (!click) return
        const t = window.setTimeout(() => {
            // Its text, or the name it is given (a card named by its title: "Bring your own data").
            const named = (b: HTMLButtonElement) => b.getAttribute('aria-label')
                ?? document.getElementById(b.getAttribute('aria-labelledby') ?? '')?.textContent?.trim()
            const hit = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === click || named(b) === click)
            hit?.click()
        }, 1200)
        return () => window.clearTimeout(t)
    }, [])
    // Bring your own data: the templates dropped on the dialog once it is open (&byod=ok|errors).
    useEffect(() => {
        if (!byod) return
        const t = window.setTimeout(() => {
            const input = document.querySelector<HTMLInputElement>('input[type="file"][aria-label="Choose files"]')
            if (!input) return
            const connections = byod === 'errors'
                ? `${TEMPLATE_FILES['connections.csv']}daily_sales,FEEDS,finance_forecast\nloyalty_report,,customers\n`
                : TEMPLATE_FILES['connections.csv']
            const files = new DataTransfer()
            files.items.add(new File([TEMPLATE_FILES['things.csv']], 'coffee-shop-things.csv', { type: 'text/csv' }))
            files.items.add(new File([connections], 'coffee-shop-connections.csv', { type: 'text/csv' }))
            input.files = files.files
            input.dispatchEvent(new Event('change', { bubbles: true }))
        }, 1700)
        return () => window.clearTimeout(t)
    }, [])
    // A tour, at a step, once the page has had time to load what it spotlights.
    useEffect(() => {
        if (!tour) return
        const t = window.setTimeout(() => {
            useTourStore.getState().start(tour)
            useTourStore.getState().goTo(tourStep)
        }, 1200)
        return () => window.clearTimeout(t)
    }, [])

    const address = new URLSearchParams()
    for (const k of ['tab', 'section', 'ds', 'dstab']) { const v = params.get(k); if (v) address.set(k, v) }
    const at = page === 'workspaces' ? `/workspaces${params.get('tab') ? `?tab=${params.get('tab')}` : ''}`
        : page === 'dashboard' ? '/dashboard'
        : page === 'view' ? `/views/${SAMPLE_VIEW.id}`
        : ['playground-card', 'request-wizard', 'workspace-requests', 'request-card', 'groups', 'data-requests', 'data-request-wizard', 'publish'].includes(page) ? `/${page}` : page === 'reviews'
        ? `/reviews${params.get('workspace') ? `?workspace=${params.get('workspace')}` : ''}`
        : `/workspaces/ws_fin${address.toString() ? `?${address}` : ''}`

    return (
        <QueryClientProvider client={qc}>
            <ViewEditorContext.Provider value={{ openViewEditor: () => {}, closeViewEditor: () => {} }}>
                <MemoryRouter initialEntries={[at]}>
                    <div className="relative min-h-screen bg-canvas">
                        <Routes>
                            <Route path="/workspaces" element={<WorkspacesPage />} />
                            <Route path="/dashboard" element={<Dashboard />} />
                            <Route path="/workspaces/:wsId" element={<WorkspaceDetailPage />} />
                            <Route path="/reviews" element={<ReviewCenterPage />} />
                            <Route path="/request-wizard" element={<RequestWorkspaceWizard onClose={() => {}} />} />
                            <Route path="/workspace-requests" element={
                                <div className="mx-auto max-w-5xl space-y-6 p-8">
                                    <WorkspaceRequestsPanel />
                                </div>
                            } />
                            <Route path="/groups" element={
                                <div className="mx-auto max-w-5xl space-y-6 p-8">
                                    {platform && <IdpLinkRequestsPanel />}
                                    <WorkspaceGroupsPanel workspaceId="ws_fin" canManage={as === 'admin'} />
                                </div>
                            } />
                            <Route path="/data-requests" element={
                                <div className="mx-auto max-w-5xl space-y-6 p-8">
                                    <DataRequestsPanel />
                                </div>
                            } />
                            <Route path="/data-request-wizard" element={<AskForDataWizard workspace={{ id: 'ws_fin', name: 'Finance Risk' }} onClose={() => {}} />} />
                            <Route path="/request-card" element={<div className="mx-auto max-w-5xl p-8"><WorkspaceRequestPrompt /></div>} />
                            <Route path="/views/:viewId" element={<SampleViewPage />} />
                            <Route path="/publish" element={<MakerPublish />} />
                            <Route path="/playground-card" element={
                                <div className="mx-auto max-w-5xl space-y-6 p-8">
                                    <PlaygroundCard />
                                    <PlaygroundCard compact />
                                </div>
                            } />
                        </Routes>
                        {/* Ask for data, from the workspace page (the app shell mounts it). */}
                        <AskForDataWizardHost />
                        <NotificationStack />
                        {/* Headless Chromium's virtual time doesn't run the cards' entrance: show them as they settle. */}
                        <style>{'[data-testid="notification-stack"] > * { opacity: 1 !important; transform: none !important; }'}</style>
                        {tour && <TourOverlay />}
                    </div>
                </MemoryRouter>
            </ViewEditorContext.Provider>
        </QueryClientProvider>
    )
}

/** A view page in the Playground: its header over the canvas's place (the canvas has harnesses of its own). */
function SampleViewPage() {
    return (
        <div className="flex h-screen flex-col">
            <ViewPageHeader viewId={SAMPLE_VIEW.id} workspaceName="Playground" />
            <div className="relative flex-1 bg-canvas" style={{ backgroundImage: 'radial-gradient(circle, var(--nx-border-glass, rgba(100,116,139,.25)) 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
        </div>
    )
}

/** Publishing the example draft of a sample, as its maker: what may be done is the server's word. */
function MakerPublish() {
    const access = useActiveDraftAccess('ws_fin', 'g_pg_retail', null, 'br_example')
    return (
        <CommitDialog workspaceId="ws_fin" graphId="g_pg_retail" branchId="br_example" dataSourceId="ds_pg_retail"
            changeSet={EXAMPLE_CHANGES} onClose={() => {}} canPublishDraft={access.canManage} canPublish={access.canPublish} />
    )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
