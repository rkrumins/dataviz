/**
 * Visual harness for questions and conversations.
 *
 * Renders the REAL drawer, panel, thread and Inbox with `fetch` answered from fixtures, so each
 * state can be looked at without a backend:
 *
 *   npx vite --port 5377 --strictPort
 *   open http://localhost:5377/conversations-harness.html?page=thread&state=answered&theme=dark
 *
 *   page   view-drawer | thread | ask | rows | inbox      (default view-drawer)
 *          view-drawer: a view's questions in the drawer; thread: one conversation in it;
 *          ask: the ask box (&entity=1 about a node on the canvas); rows: the panel inline, with
 *          Who to ask and the Questions button; inbox: the bell, open, with conversation messages
 *   state  open | answered | private | anchored | deleted | closed   (page=thread; default open)
 *   theme  light | dark
 *
 * `npm run harness:conversations` drives Chromium over every page at 1280px and 390px, light
 * and dark, and writes PNGs to .harness/.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
import type { Message, ThreadDetail } from '../services/discussionsService'
import {
    INBOX, MENTIONABLE, PEOPLE, STATE_THREAD, SUBJECT_PEOPLE, SUMMARY, THREADS, VIEW, summaryOf,
} from './conversationsFixtures'

const params = new URLSearchParams(window.location.search)
const page = params.get('page') ?? 'view-drawer'
const state = params.get('state') ?? 'open'
const dark = params.get('theme') === 'dark'
const withEntity = params.get('entity') === '1'

// ── fetch, answered from the fixtures ─────────────────────────────────
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const realFetch = window.fetch.bind(window)
const subjectBase = `/api/v1/discussions/subjects/view/${VIEW.id}`
let posted = 0

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const p = url.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    if (!p.startsWith('/api/')) return realFetch(input, init)
    let m: RegExpMatchArray | null
    if (p === `${subjectBase}/summary`) return json(SUMMARY)
    if (p === `${subjectBase}/people`) return json(SUBJECT_PEOPLE)
    if (p === `${subjectBase}/mentionable`) {
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        return json({ people: MENTIONABLE.filter((x) => !q || x.displayName.toLowerCase().split(' ').some((w) => w.startsWith(q))) })
    }
    if (p === `${subjectBase}/watch`) return json({ watching: method === 'PUT' })
    if (p === subjectBase && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        const q: Message = { id: `dmsg_new${++posted}`, kind: 'question', authorId: 'usr_me', body: body.body, mentions: body.mentions, createdAt: new Date().toISOString(),
            editedAt: null, deletedAt: null, version: 1, roles: ['asker'] }
        const t: ThreadDetail = { ...THREADS.th_private, id: `th_new${posted}`, visibility: body.visibility, messages: [q], excerpt: body.body.slice(0, 200),
            entityId: body.entityId ?? null, entityLabel: body.entityLabel ?? null, privateAudience: body.visibility === 'private' ? ['usr_me', 'usr_ana'] : null,
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
    if ((m = p.match(/^\/api\/v1\/discussions\/([^/]+)\/read$/))) return json({ lastReadAt: new Date().toISOString() })
    if ((m = p.match(/^\/api\/v1\/discussions\/([^/]+)\/me$/))) return json({ muted: false, following: false, ...JSON.parse(String(init?.body ?? '{}')) })
    if ((m = p.match(/^\/api\/v1\/discussions\/([^/]+)$/))) {
        const t = THREADS[m[1]]
        if (!t) return json({ detail: { type: 'not_found', message: 'Not found' } }, 404)
        const since = url.searchParams.get('since')
        if (since) {
            const after = Date.parse(since)
            return json({ ...t, messages: t.messages.filter((x) => [x.createdAt, x.editedAt, x.deletedAt].some((s) => s && Date.parse(s) > after)) })
        }
        return json(t)
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
        if (page === 'ask') open({ subject, compose: true, entity: withEntity ? { id: 'urn:fin:net_revenue', label: 'Net revenue (monthly)' } : null })
        if (page === 'inbox') {
            const t = window.setTimeout(() => document.querySelector<HTMLButtonElement>('button[aria-label^="Inbox"]')?.click(), 400)
            return () => window.clearTimeout(t)
        }
    }, [])

    return (
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[`/views/${VIEW.id}`]}>
                {page === 'rows' ? (
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
