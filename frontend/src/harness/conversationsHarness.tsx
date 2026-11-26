/**
 * Visual harness for questions and conversations.
 *
 * Renders the REAL drawer, panel, thread and Inbox with `fetch` answered from fixtures, so each
 * state can be looked at without a backend:
 *
 *   npx vite --port 5377 --strictPort
 *   open http://localhost:5377/conversations-harness.html?page=thread&state=answered&theme=dark
 *
 *   page   view-drawer | thread | ask | rows | inbox | profile | profile-other | contacts | source-tab | hovercard
 *          | cards   (default view-drawer)
 *          view-drawer: a view's questions in the drawer; thread: one conversation in it;
 *          ask: the ask box (&entity=1 about a node on the canvas); rows: the panel inline, with
 *          Who to ask and the Questions button; inbox: the bell, open, with conversation messages;
 *          source-tab: a data source's Questions tab; hovercard: a person's card, open, with
 *          View profile and Ask a question; cards: Explorer view cards and rows, and data source cards,
 *          with their question counts (open, unread, all settled but unread, none)
 *   state  open | answered | private | anchored | deleted | closed   (page=thread; default open)
 *          overview | conversations | thread | watching   (page=profile: your own; default overview)
 *          named | derived | edit   (page=contacts: a data source's Who to ask card; edit: its
 *          editor, opened; default named)
 *          views | sources | rows   (page=cards: just that part, for a phone's screen; default all)
 *   theme  light | dark
 *   hover  1: the first entity a question is about, hovered (its full details)
 *
 * `npm run harness:conversations` drives Chromium over every page at 1280px and 390px, light
 * and dark, and writes PNGs to .harness/.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { MessageCircleQuestion } from 'lucide-react'

import '../styles/globals.css'
import { usePreferencesStore } from '../store/preferences'
import { useAuthStore } from '../store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { NotificationStack } from '../components/ui/notifications'
import { InboxBell } from '../components/inbox/InboxBell'
import { DiscussionsDrawerHost } from '../features/discussions/DiscussionsDrawer'
import { DiscussionPanel } from '../features/discussions/DiscussionPanel'
import { QuestionsButton } from '../features/discussions/QuestionsButton'
import { WhoToAsk } from '../features/discussions/WhoToAsk'
import { QuestionRowMark } from '../features/discussions/QuestionRowMark'
import { useDiscussionsDrawer } from '../features/discussions/drawerStore'
import { useAnchorStore } from '../features/discussions/anchorStore'
import { PersonProfilePage } from '../pages/PersonProfilePage'
import { DataContactsCard } from '../components/admin/workspace/DataContactsCard'
import { PersonHoverCard } from '../components/explorer/PersonHoverCard'
import { UserAvatar } from '../components/ui/UserAvatar'
import { ExplorerViewCard } from '../components/explorer/ExplorerViewCard'
import { ExplorerListRow } from '../components/explorer/ExplorerListRow'
import { ExplorerListHeader } from '../components/explorer/ExplorerListHeader'
import { DataSourceGridCard } from '../components/admin/workspace/DataSourceGridCard'
import { useSubjectCounts } from '../features/discussions/useDiscussions'
import type { DataSourceResponse } from '../services/workspaceService'
import type { View } from '../services/viewApiService'
import type { Message, SubjectCount, ThreadDetail } from '../services/discussionsService'
import {
    INBOX, MENTIONABLE, PEOPLE, SOURCE, SOURCE_PEOPLE, SOURCE_SUMMARY, SOURCE_THREADS, STATE_THREAD, SUBJECT_PEOPLE, SUMMARY,
    THREADS, VIEW, summaryOf,
} from './conversationsFixtures'

const params = new URLSearchParams(window.location.search)
const page = params.get('page') ?? 'view-drawer'
const state = params.get('state') ?? 'open'
const dark = params.get('theme') === 'dark'
const withEntity = params.get('entity') === '1'
const hover = params.get('hover') === '1'
// The person card opens after the page settles; headless Chromium's virtual clock never runs its
// fade-in, so it would be captured still invisible.
if (page === 'hovercard') MotionGlobalConfig.skipAnimations = true
// Likewise a hovered tip: its rise-and-fade would be captured half drawn, and the drawer still
// sliding in when it is placed would leave it pointing at where the drawer was.
if (hover) {
    MotionGlobalConfig.skipAnimations = true
    document.documentElement.classList.add('reduce-motion')
}

// ── fetch, answered from the fixtures ─────────────────────────────────
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
const subjectBase = `/api/v1/discussions/subjects/view/${VIEW.id}`
const sourceBase = `/api/v1/discussions/subjects/data_source/${SOURCE.id}`
let posted = 0

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const p = url.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    if (!p.startsWith('/api/')) return realFetch(input, init)
    let m: RegExpMatchArray | null
    if (p === `${subjectBase}/summary`) return json(SUMMARY)
    if (p === `${subjectBase}/people`) return json(SUBJECT_PEOPLE)
    if (p === `${sourceBase}/summary`) return json(SOURCE_SUMMARY)
    if (p === '/api/v1/discussions/summaries') {
        const ids = url.searchParams.getAll('ids')
        return json({ summaries: Object.fromEntries(ids.filter((id) => CARD_COUNTS[id]).map((id) => [id, CARD_COUNTS[id]])) })
    }
    if (p === `${sourceBase}/people`) return json(SOURCE_PEOPLE)
    if (p === `${subjectBase}/mentionable` || p === `${sourceBase}/mentionable`) {
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        return json({ people: MENTIONABLE.filter((x) => !q || x.displayName.toLowerCase().split(' ').some((w) => w.startsWith(q))) })
    }
    if (p === `${subjectBase}/watch` || p === `${sourceBase}/watch`) return json({ watching: method === 'PUT' })
    if (p === sourceBase && method === 'GET') {
        const status = url.searchParams.get('status') ?? 'all'
        const rows = Object.values(SOURCE_THREADS).filter((t) => status === 'all' || t.status === status).map(summaryOf)
        return json({ threads: rows, nextCursor: null, latest: SOURCE_SUMMARY.latest, people: PEOPLE })
    }
    if (p === subjectBase && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        const q: Message = { id: `dmsg_new${++posted}`, kind: 'question', authorId: 'usr_me', body: body.body, mentions: body.mentions, createdAt: new Date().toISOString(),
            editedAt: null, deletedAt: null, version: 1, roles: ['asker'] }
        const t: ThreadDetail = { ...THREADS.th_private, id: `th_new${posted}`, visibility: body.visibility, messages: [q], excerpt: body.body.slice(0, 200),
            entityId: body.entityId ?? null, entityLabel: body.entityLabel ?? null, entityPath: body.entityPath ?? null,
            entityType: body.entityType ?? null, privateAudience: body.visibility === 'private' ? ['usr_me', 'usr_ana'] : null,
            messageCount: 1, participantIds: ['usr_me'], participantCount: 1, unread: false, status: 'open' }
        THREADS[t.id] = t
        return json({ thread: t, reached: ['usr_ana', 'usr_eli', 'usr_bo'], notReached: [{ personId: 'usr_fay', reason: 'cannot_read' }], usedFallback: false }, 201)
    }
    if (p === subjectBase) {
        const status = url.searchParams.get('status') ?? 'all'
        const entityId = url.searchParams.get('entityId')
        const mine = url.searchParams.get('mine') === 'true'
        const rows = Object.values(THREADS)
            .filter((t) => status === 'all' || t.status === status)
            .filter((t) => !entityId || t.entityId === entityId)
            .filter((t) => !mine || t.askedBy === 'usr_me' || t.participantIds.includes('usr_me'))
            .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
            .map(summaryOf)
        return json({ threads: rows, nextCursor: null, latest: SUMMARY.latest, people: PEOPLE })
    }
    if ((m = p.match(/^\/api\/v1\/discussions\/([^/]+)\/messages$/)) && method === 'POST') {
        const t = THREADS[m[1]]
        const body = JSON.parse(String(init?.body ?? '{}'))
        const message: Message = { id: `dmsg_r${++posted}`, kind: 'reply', authorId: 'usr_me', body: body.body, mentions: body.mentions,
            createdAt: new Date().toISOString(), editedAt: null, deletedAt: null, version: 1, roles: t.askedBy === 'usr_me' ? ['asker'] : [] }
        t.messages = [...t.messages, message]
        t.messageCount += 1
        t.lastActivityAt = message.createdAt
        return json({ message, thread: summaryOf(t), people: PEOPLE }, 201)
    }
    if (/^\/api\/v1\/discussions\/[^/]+\/read$/.test(p)) return json({ lastReadAt: new Date().toISOString() })
    if (/^\/api\/v1\/discussions\/[^/]+\/me$/.test(p)) return json({ muted: false, following: false, ...JSON.parse(String(init?.body ?? '{}')) })
    if ((m = p.match(/^\/api\/v1\/discussions\/([^/]+)$/))) {
        const t = THREADS[m[1]] ?? SOURCE_THREADS[m[1]]
        if (!t) return json({ detail: { type: 'not_found', message: 'Not found' } }, 404)
        const since = url.searchParams.get('since')
        if (since) {
            const after = Date.parse(since)
            return json({ ...t, messages: t.messages.filter((x) => [x.createdAt, x.editedAt, x.deletedAt].some((s) => s && Date.parse(s) > after)) })
        }
        return json(t)
    }
    // Profiles, your own conversations, and a data source's contacts.
    if ((m = p.match(/^\/api\/v1\/people\/([^/]+)$/))) {
        const id = m[1]
        return json({
            person: { ...PEOPLE[id], isServiceAccount: false }, isMe: id === 'usr_me',
            workspacesTheyRun: id === 'usr_me' ? [] : [{ id: 'ws_fin', name: 'Finance Risk' }, { id: 'ws_ops', name: 'Operations' }],
            dataContacts: [
                { dataSourceId: 'ds_gl', dataSourceName: 'General Ledger', workspaceId: 'ws_fin', workspaceName: 'Finance Risk', role: 'owner', via: 'direct' },
                { dataSourceId: 'ds_crm', dataSourceName: 'CRM accounts', workspaceId: 'ws_fin', workspaceName: 'Finance Risk', role: 'steward', via: 'group' },
            ],
        })
    }
    if (p === '/api/v1/views/' || p === '/api/v1/views') return json({ items: [], total: 0, hasMore: false })
    // The reader manages the view's sharing: the ask box offers Share beside Fay, who can't open it.
    if (p === `/api/v1/views/${VIEW.id}`) {
        return json({ id: VIEW.id, name: VIEW.name, workspaceId: 'ws_fin', workspaceName: 'Finance Risk', viewType: 'graph', config: {},
            visibility: 'workspace', isPinned: false, favouriteCount: 0, isFavourited: false, createdAt: '2026-10-03T09:00:00Z', updatedAt: '2026-11-20T09:00:00Z',
            access: { canEdit: true, canManageGrants: true, canChangeVisibility: true, canPublish: false, accessVia: 'owner', dataAccess: 'full' } })
    }
    if (p === `/api/v1/views/${VIEW.id}/grants`) return json([])
    if (p === '/api/v1/me/discussions') {
        const box = url.searchParams.get('box') ?? 'to-me'
        const rows = Object.values(THREADS).map(summaryOf)
            .filter((t) => box !== 'mine' || t.askedBy === 'usr_me')
            .map((t, i) => (i === 1 ? { ...t, subject: SOURCE } : t))
        return json({ threads: rows, nextCursor: null, people: PEOPLE })
    }
    if (p === '/api/v1/me/watches') {
        return json({ items: [
            { subject: VIEW, createdAt: '2026-11-02T09:00:00Z', open: 3 },
            { subject: SOURCE, createdAt: '2026-10-14T09:00:00Z', open: 1 },
        ], nextCursor: null })
    }
    if (p === '/api/v1/admin/workspaces/ws_fin/data-sources/ds_gl/contacts') return json(CONTACTS[state === 'derived' ? 'derived' : 'named'])
    if (p === '/api/v1/directory') {
        return json({ users: MENTIONABLE.map((x) => ({ id: x.id, displayName: x.displayName, email: x.email ?? '' })),
            groups: [{ id: 'grp_fin', name: 'Finance data team', memberCount: 7 }, { id: 'grp_all', name: 'Everyone in Finance', memberCount: 212 }] })
    }
    if (p === '/api/v1/me/notifications') return json({ items: INBOX, unread: INBOX.filter((i) => !i.readAt).length })
    if (p === '/api/v1/me/discussions/summary') return json({ toMe: { unread: 2, waiting: 1 }, mine: { unread: 1, open: 2 }, mentions: { unread: 1 }, watching: { unread: 0 }, totalUnread: 4 })
    if (p.match(/^\/api\/v1\/users\/[^/]+\/avatar$/)) return new Response(null, { status: 404 })
    console.warn('[harness] unanswered', method, p + url.search)
    return json([])
}

// ── the reader ────────────────────────────────────────────────────────
useAuthStore.setState({
    status: 'authenticated', isAuthenticated: true, permissionsStatus: 'ready',
    user: { id: 'usr_me', firstName: 'Sam', lastName: 'Reader', displayName: 'Sam Reader', email: 'sam@example.com' },
    permissions: { sid: 'harness', global: [], ws: { ws_fin: ['workspace:view:read'] } },
} as never)
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
// The view is open on the canvas: its question marks count, and Show on canvas is offered.
useAnchorStore.getState().set(VIEW.id, SUMMARY.byEntity)

const subject = { type: 'view' as const, id: VIEW.id, name: VIEW.name }
const sourceSubject = { type: 'data_source' as const, id: SOURCE.id, name: SOURCE.name }
const CONTACTS = {
    named: {
        owner: { subjectType: 'user', subjectId: 'usr_ana', name: 'Ana Silva', memberCount: null, via: 'named_owner' },
        stewards: [
            { subjectType: 'user', subjectId: 'usr_bo', name: 'Bo Chen', memberCount: null, via: 'named_steward' },
            { subjectType: 'group', subjectId: 'grp_fin', name: 'Finance data team', memberCount: 7, via: 'named_steward' },
        ],
        provenance: 'named', updatedAt: '2026-11-10T10:00:00Z', canEdit: true, canEditOwner: false, people: PEOPLE,
    },
    derived: {
        owner: { subjectType: 'user', subjectId: 'usr_eli', name: 'Eli Novak', memberCount: null, via: 'created_source' },
        stewards: [{ subjectType: 'user', subjectId: 'usr_dee', name: 'Dee Okafor', memberCount: null, via: 'data_request' }],
        provenance: 'derived', updatedAt: null, canEdit: true, canEditOwner: true, people: PEOPLE,
    },
}
const PROFILE_URL: Record<string, string> = {
    overview: '/me/profile', conversations: '/me/profile?tab=conversations',
    thread: '/me/profile?tab=conversations&thread=th_answered', watching: '/me/profile?tab=watching',
}
const startAt = page === 'profile' ? PROFILE_URL[state] ?? '/me/profile' : page === 'profile-other' ? '/people/usr_ana' : `/views/${VIEW.id}`

function FauxViewPage({ children }: { children?: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-canvas">
            <header className="flex items-center gap-3 border-b border-glass-border/70 bg-canvas-elevated px-5 py-3">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center"><MessageCircleQuestion className="w-4 h-4" /></div>
                <div className="min-w-0 flex-1">
                    <h1 className="text-sm font-bold text-ink truncate">{VIEW.name}</h1>
                    <p className="text-xs text-ink-muted truncate">Finance Risk · Context view</p>
                </div>
                <QuestionsButton subject={subject}
                    className="inline-flex items-center gap-1.5 rounded-lg font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 px-3 py-2 text-[13px]" />
            </header>
            <div className="h-[calc(100vh-61px)] bg-[radial-gradient(circle,rgba(127,127,127,0.18)_1px,transparent_1px)] [background-size:18px_18px]">{children}</div>
        </div>
    )
}

/** A data source's drawer on its Questions tab, as the workspace's Sources page opens it. */
function FauxSourceDrawer() {
    const tabs = ['Overview', 'Insights', 'Profiling', 'Views', 'Questions']
    return (
        <div className="min-h-screen bg-canvas sm:flex sm:justify-end">
            <aside className="min-h-screen w-full sm:max-w-[40rem] border-l border-glass-border/70 bg-canvas-elevated">
                <div className="flex items-center gap-3 border-b border-glass-border/70 px-6 py-4">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600" aria-hidden />
                    <div className="min-w-0">
                        <h1 className="text-base font-bold text-ink truncate">{SOURCE.name}</h1>
                        <p className="text-xs text-ink-muted truncate">{SOURCE.workspaceName} · FalkorDB</p>
                    </div>
                </div>
                <div className="flex gap-1 overflow-x-auto border-b border-glass-border/70 px-4">
                    {tabs.map((t) => (
                        <span key={t} className={t === 'Questions'
                            ? 'shrink-0 border-b-2 border-accent-lineage px-3 py-2.5 text-xs font-semibold text-ink'
                            : 'shrink-0 px-3 py-2.5 text-xs font-medium text-ink-muted'}>
                            {t}{t === 'Questions' && <span className="ml-1.5 rounded-full bg-accent-lineage/15 px-1.5 text-[10px] tabular-nums">{SOURCE_SUMMARY.open}</span>}
                        </span>
                    ))}
                </div>
                <div className="px-6 py-5"><DiscussionPanel subject={sourceSubject} onOpenThread={() => {}} /></div>
            </aside>
        </div>
    )
}

/** A view's creator, with their card open: View profile and Ask a question. */
function PersonCardPage() {
    const ana = PEOPLE.usr_ana
    return (
        <div className="min-h-screen bg-canvas p-4 sm:p-8">
            <div className="mx-auto max-w-md rounded-2xl border border-glass-border/70 bg-canvas-elevated p-4">
                <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">Created by</p>
                <PersonHoverCard userId={ana.id} displayName={ana.displayName} email={ana.email} roles={['Created · 3 Oct', 'View owner']}
                    onAsk={() => useDiscussionsDrawer.getState().open({ subject, compose: true, recipients: [ana.id] })}>
                    <div tabIndex={0} data-harness-person className="mt-2 flex items-center gap-3 rounded-xl px-1 py-1 outline-none">
                        <UserAvatar userId={ana.id} name={ana.displayName} className="w-9 h-9 text-xs font-bold" />
                        <span className="min-w-0">
                            <span className="block text-sm font-semibold text-ink">{ana.displayName}</span>
                            <span className="block text-xs text-ink-muted">{VIEW.name}</span>
                        </span>
                    </div>
                </PersonHoverCard>
            </div>
        </div>
    )
}

// ── page=cards: lists of cards with their question counts ────────────
const CARD_COUNTS: Record<string, SubjectCount> = {
    view_rev: { open: 3, answered: 4, total: 8, unread: 1 },
    view_churn: { open: 2, answered: 0, total: 2, unread: 0 },
    view_ar: { open: 0, answered: 2, total: 2, unread: 1 },
    ds_gl: { open: 4, answered: 1, total: 5, unread: 2 },
    ds_crm: { open: 1, answered: 0, total: 1, unread: 0 },
}
const cardView = (id: string, name: string, viewType: string, description: string, favouriteCount: number): View => ({
    id, name, viewType, description, favouriteCount, workspaceId: 'ws_fin', workspaceName: 'Finance Risk', dataSourceId: 'ds_gl',
    dataSourceName: 'General Ledger', visibility: 'workspace', config: {}, isPinned: false, isFavourited: favouriteCount > 2,
    tags: ['finance', 'month-end'], createdBy: 'usr_ana', createdByName: 'Ana Silva', createdAt: '2026-10-03T09:00:00Z',
    updatedAt: '2026-11-20T09:00:00Z',
}) as View
const CARD_VIEWS = [
    cardView('view_rev', 'Revenue lineage — FY26', 'graph', 'Where reported revenue comes from, table by table.', 12),
    cardView('view_churn', 'Customer churn drivers', 'reference', 'The signals behind churn, by segment.', 4),
    cardView('view_ar', 'Receivables ageing', 'hierarchy', 'Open invoices by age bucket.', 2),
    cardView('view_fx', 'FX exposure', 'graph', 'Currency positions across entities.', 0),
]
const cardSource = (id: string, label: string, isPrimary: boolean): DataSourceResponse => ({
    id, label, isPrimary, workspaceId: 'ws_fin', accessLevel: 'read', isActive: true, aggregationStatus: 'ready',
    aggregationEdgeCount: 0, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z',
}) as DataSourceResponse
const CARD_SOURCES = [cardSource('ds_gl', 'General Ledger', true), cardSource('ds_crm', 'CRM accounts', false), cardSource('ds_ops', 'Ops graph', false)]
const noop = () => {}

function CardsPage() {
    const views = useSubjectCounts('view', CARD_VIEWS.map((v) => v.id))
    const sources = useSubjectCounts('data_source', CARD_SOURCES.map((d) => d.id))
    const openView = (v: View) => useDiscussionsDrawer.getState().open({ subject: { type: 'view', id: v.id, name: v.name } })
    const heading = 'text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted'
    return (
        <div className="min-h-screen bg-canvas p-4 sm:p-8">
            <div className="mx-auto max-w-6xl space-y-6">
                {(state === 'open' || state === 'views') && (<>
                    <p className={heading}>Explorer</p>
                    <div className="grid items-start grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {CARD_VIEWS.map((v) => (
                            <ExplorerViewCard key={v.id} view={v} questions={views[v.id]} onToggleFavourite={noop} onShare={noop}
                                onPreview={() => openView(v)} />
                        ))}
                    </div>
                </>)}
                {(state === 'open' || state === 'sources') && (<>
                    <p className={heading}>Data sources</p>
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                        {CARD_SOURCES.map((d) => (
                            <DataSourceGridCard key={d.id} ds={d} viewCount={d.id === 'ds_gl' ? 4 : 1} isSelected={false} onSelect={noop}
                                stats={{ nodeCount: 12_400, edgeCount: 31_000, entityTypes: [] }}
                                questions={sources[d.id]} onOpenQuestions={noop} />
                        ))}
                    </div>
                </>)}
                {(state === 'open' || state === 'rows') && (
                    <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-x-auto custom-scrollbar">
                        <div className="min-w-[760px]">
                            <ExplorerListHeader sort="most-opened" onSortChange={noop} withCheckbox={false} />
                            {CARD_VIEWS.map((v) => <ExplorerListRow key={v.id} view={v} questions={views[v.id]} onToggleFavourite={noop} onShare={noop} />)}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
        document.body.style.background = getComputedStyle(document.documentElement).getPropertyValue('--nx-bg-canvas').trim() || '#fff'
    }, [setTheme])
    useEffect(() => {
        const open = useDiscussionsDrawer.getState().open
        if (page === 'view-drawer') open({ subject })
        if (page === 'thread') open({ subject, threadId: STATE_THREAD[state] ?? 'th_open', messageId: state === 'answered' ? THREADS.th_answered.answerMessageId : null })
        if (page === 'ask') open({ subject, compose: true, entity: withEntity ? {
            id: 'urn:fin:net_revenue', label: 'Net revenue (monthly)', path: ['Finance Risk', 'Reporting', 'Monthly', 'Revenue'], type: 'metric',
        } : null })
        if (hover) {
            // What a question is about, hovered: its full details.
            const t = window.setTimeout(() => document.querySelector('[data-testid="entity-anchor"]')?.parentElement
                ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })), 700)
            return () => window.clearTimeout(t)
        }
        if (page === 'inbox') {
            const t = window.setTimeout(() => document.querySelector<HTMLButtonElement>('button[aria-label^="Inbox"]')?.click(), 400)
            return () => window.clearTimeout(t)
        }
        if (page === 'contacts' && state === 'edit') {
            const t = window.setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>('section button')]
                .find((b) => /^(Edit|Name them)$/.test(b.textContent?.trim() ?? ''))?.click(), 400)
            return () => window.clearTimeout(t)
        }
        if (page === 'hovercard') {
            // A pointer arriving (headless Chromium sends no focus events to an unfocused page).
            const t = window.setTimeout(() => document.querySelector<HTMLElement>('[data-harness-person]')
                ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })), 400)
            return () => window.clearTimeout(t)
        }
    }, [])

    return (
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[startAt]}>
                {page === 'profile' || page === 'profile-other' ? (
                    <div className="relative h-screen bg-canvas">
                        <Routes>
                            <Route path="/me/profile" element={<PersonProfilePage />} />
                            <Route path="/people/:userId" element={<PersonProfilePage />} />
                        </Routes>
                    </div>
                ) : page === 'contacts' ? (
                    <div className="min-h-screen bg-canvas p-4 sm:p-8">
                        <div className="mx-auto max-w-xl"><DataContactsCard wsId="ws_fin" dsId="ds_gl" onAsk={() => {}} /></div>
                    </div>
                ) : page === 'source-tab' ? (
                    <FauxSourceDrawer />
                ) : page === 'hovercard' ? (
                    <PersonCardPage />
                ) : page === 'cards' ? (
                    <CardsPage />
                ) : page === 'rows' ? (
                    <div className="min-h-screen bg-canvas p-4 sm:p-8">
                        <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_20rem]">
                            <div className="rounded-2xl border border-glass-border/70 bg-canvas-elevated p-4 sm:p-5">
                                <DiscussionPanel subject={subject} onOpenThread={() => {}} />
                            </div>
                            <div className="space-y-4">
                                <WhoToAsk subject={subject} />
                                <div className="rounded-2xl border border-glass-border/70 bg-canvas-elevated p-4 space-y-3">
                                    <QuestionsButton subject={subject}
                                        className="inline-flex items-center gap-1.5 rounded-lg font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 px-3 py-2 text-[13px]" />
                                    {/* Canvas rows as the Context View draws them, with their question marks. */}
                                    <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">On the canvas</p>
                                    {[
                                        { urn: 'urn:fin:net_revenue', name: 'Net revenue (monthly)' },
                                        { urn: 'urn:fin:gl_balances', name: 'gl_balances' },
                                        { urn: 'urn:fin:dim_customer', name: 'dim_customer' },
                                        { urn: 'urn:fin:fx_rates', name: 'fx_rates' },
                                    ].map((row) => (
                                        <div key={row.urn} className="nx-row-card flex items-center gap-2 rounded-xl border border-glass-border/70 px-3 py-2">
                                            <span className="w-2 h-2 rounded-full bg-indigo-500" />
                                            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{row.name}</span>
                                            <QuestionRowMark urn={row.urn} label={row.name} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : page === 'inbox' ? (
                    <div className="min-h-screen bg-canvas">
                        <header className="flex items-center justify-end gap-2 border-b border-glass-border/70 bg-canvas-elevated px-5 py-2"><InboxBell /></header>
                    </div>
                ) : (
                    <FauxViewPage />
                )}
                <DiscussionsDrawerHost />
                <NotificationStack />
            </MemoryRouter>
        </QueryClientProvider>
    )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
