/**
 * Your own conversations, on your profile: the questions asked of you, the ones you asked, the
 * ones you were mentioned in and new ones where you watch — a list with the open thread beside
 * it (one pane with Back on a phone), kept in the URL (`?box=&thread=`) so a link or Back lands
 * on the same place. Also what you watch, and a "Waiting on you" card for the Overview.
 */
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
    ArrowRight, AtSign, Database, Eye, EyeOff, Inbox, LayoutGrid, Loader2, MessageCircleQuestion, MessagesSquare, Send,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import { DateTime } from '@/components/ui/DateTime'
import { useAppNotifications } from '@/components/ui/notifications'
import {
    unwatchSubject, type DiscussionStatus, type MyBox, type PeopleMap, type SubjectRef, type ThreadSummary,
} from '@/services/discussionsService'
import { DISCUSSION_KEYS, useMyConversations, useMySummary, useMyWatches } from './useDiscussions'
import { ThreadCard } from './DiscussionPanel'
import { ThreadView } from './ThreadView'
import { messageLink } from './discussionText'

const BOXES: readonly MyBox[] = ['to-me', 'mine', 'mentions', 'watching']
type StatusFilter = DiscussionStatus | 'all'
const STATUSES: readonly StatusFilter[] = ['all', 'open', 'answered', 'closed']

const EMPTY: Record<MyBox, { icon: typeof Inbox; title: string; description: string }> = {
    'to-me': { icon: Inbox, title: 'Nothing asked of you', description: 'When someone asks about a view you made or data you look after, it lands here.' },
    mine: { icon: Send, title: 'You haven’t asked anything yet', description: 'Ask from a view’s Questions button, from a node on the canvas, or from a data source.' },
    mentions: { icon: AtSign, title: 'No mentions', description: 'When someone @mentions you in a conversation, it shows up here.' },
    watching: { icon: Eye, title: 'Nothing new where you watch', description: 'Watch a view or a data source to hear about each new question on it.' },
}

/** An in-app path to a thread (and a message of it), from its subject's link. */
function threadPath(subject: Pick<SubjectRef, 'link'>, threadId: string, messageId?: string | null): string {
    const url = new URL(messageLink(subject.link, threadId, messageId))
    return url.pathname + url.search
}

export function ConversationsTab() {
    const [params, setParams] = useSearchParams()
    const rawBox = params.get('box') as MyBox | null
    const box: MyBox = rawBox && BOXES.includes(rawBox) ? rawBox : 'to-me'
    const rawStatus = params.get('status') as StatusFilter | null
    const status: StatusFilter = rawStatus && STATUSES.includes(rawStatus) ? rawStatus : 'all'
    const threadId = params.get('thread')
    const messageId = params.get('message')

    const set = (changes: Record<string, string | null>) => setParams(prev => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) { if (v == null) next.delete(k); else next.set(k, v) }
        return next
    }, { replace: true })

    const summary = useMySummary().data
    const list = useMyConversations(box, status)
    const threads = useMemo(() => list.data?.pages.flatMap(p => p.threads) ?? [], [list.data])
    const people = useMemo<PeopleMap>(() => Object.assign({}, ...(list.data?.pages.map(p => p.people) ?? [])), [list.data])
    const open = threads.find(t => t.id === threadId) ?? null

    return (
        <div className="space-y-4">
            <div className={cn('flex flex-wrap items-center gap-2', threadId && 'hidden lg:flex')}>
                <div className="max-w-full overflow-x-auto overflow-y-hidden custom-scrollbar">
                    <Segmented<MyBox> label="Which conversations" size="md" value={box} className="w-max"
                        onChange={b => set({ box: b === 'to-me' ? null : b, thread: null, message: null })}
                        options={[
                            { value: 'to-me', label: 'To me', icon: Inbox, count: summary?.toMe.unread || undefined },
                            { value: 'mine', label: 'Mine', icon: Send, count: summary?.mine.unread || undefined },
                            { value: 'mentions', label: 'Mentions', icon: AtSign, count: summary?.mentions.unread || undefined },
                            { value: 'watching', label: 'Watching', icon: Eye, count: summary?.watching.unread || undefined },
                        ]} />
                </div>
                <label className="ml-auto inline-flex items-center gap-2 text-xs text-ink-muted">
                    Status
                    <select value={status} onChange={e => set({ status: e.target.value === 'all' ? null : e.target.value, thread: null, message: null })}
                        className="h-8 rounded-lg border border-black/[0.08] dark:border-white/[0.10] bg-canvas px-2 text-xs text-ink outline-none focus:border-indigo-500">
                        <option value="all">Any</option>
                        <option value="open">Open</option>
                        <option value="answered">Answered</option>
                        <option value="closed">Closed</option>
                    </select>
                </label>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
                <div className={cn('space-y-2', threadId && 'hidden lg:block')}>
                    {list.isLoading ? (
                        [0, 1, 2].map(i => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)
                    ) : list.isError ? (
                        <EmptyState compact icon={MessagesSquare} title="Couldn’t load your conversations" description="Check your connection and try again."
                            action={{ label: 'Try again', onClick: () => void list.refetch() }} />
                    ) : threads.length === 0 ? (
                        <EmptyState compact icon={EMPTY[box].icon} title={EMPTY[box].title} description={EMPTY[box].description} />
                    ) : (
                        <>
                            <ul aria-label="Conversations" className="space-y-2">
                                {threads.map(t => (
                                    <li key={t.id}>
                                        <ThreadCard thread={t} people={people} showSubject selected={t.id === threadId}
                                            onOpen={() => set({ thread: t.id, message: null })} />
                                    </li>
                                ))}
                            </ul>
                            {list.hasNextPage && (
                                <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}
                                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-glass-border py-2 text-xs font-semibold text-ink-secondary hover:text-ink disabled:opacity-50">
                                    {list.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Show more
                                </button>
                            )}
                        </>
                    )}
                </div>

                <div className={cn(!threadId && 'hidden lg:block')}>
                    {threadId ? (
                        <div className="overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated">
                            {open && <SubjectBar thread={open} />}
                            <div className="max-h-[calc(100vh-13rem)] min-h-[24rem] overflow-y-auto">
                                <ThreadView key={threadId} threadId={threadId} focusMessageId={messageId}
                                    onBack={() => set({ thread: null, message: null })}
                                    onDeleted={() => set({ thread: null, message: null })} />
                            </div>
                        </div>
                    ) : (
                        <div className="grid h-full min-h-[18rem] place-items-center rounded-2xl border border-dashed border-glass-border p-6 text-center">
                            <div>
                                <MessageCircleQuestion className="mx-auto h-8 w-8 text-ink-muted/60" aria-hidden />
                                <p className="mt-2 text-sm font-semibold text-ink">Pick a conversation</p>
                                <p className="mt-0.5 text-xs text-ink-muted">It opens here, with everything said so far.</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

/** What the open thread is about, with the way to it. */
function SubjectBar({ thread }: { thread: ThreadSummary }) {
    const Icon = thread.subject.type === 'view' ? LayoutGrid : Database
    return (
        <div className="flex items-center gap-2 border-b border-glass-border px-4 py-2.5 text-xs">
            <Icon className="h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
                <span className="text-ink-muted">About </span>
                <span className="font-semibold text-ink">{thread.subject.name}</span>
                {thread.subject.workspaceName && <span className="text-ink-muted"> · {thread.subject.workspaceName}</span>}
            </span>
            <Link to={threadPath(thread.subject, thread.id)}
                className="inline-flex shrink-0 items-center gap-1 font-semibold text-accent-lineage hover:underline">
                Open {thread.subject.type === 'view' ? 'the view' : 'the data source'} <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
        </div>
    )
}

export function WatchingTab() {
    const watches = useMyWatches()
    const qc = useQueryClient()
    const { notify } = useAppNotifications()
    const unwatch = useMutation({
        mutationFn: (s: SubjectRef) => unwatchSubject(s),
        onSuccess: (_r, s) => {
            notify('success', `You’ll no longer hear about new questions on ${s.name}.`)
            void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.watches })
            void qc.invalidateQueries({ queryKey: DISCUSSION_KEYS.summary(s) })
        },
        onError: (e: unknown) => notify('error', (e as Error)?.message || 'Couldn’t stop watching it.'),
    })
    const items = watches.data?.pages.flatMap(p => p.items) ?? []

    if (watches.isLoading) return <div className="grid gap-2 md:grid-cols-2">{[0, 1].map(i => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
    if (items.length === 0) {
        return <EmptyState icon={Eye} title="You aren’t watching anything"
            description="Watch a view or a data source from its Questions panel to hear about every new question on it." />
    }
    return (
        <div className="space-y-3">
            <ul className="grid gap-2 md:grid-cols-2">
                {items.map(w => {
                    const Icon = w.subject.type === 'view' ? LayoutGrid : Database
                    return (
                        <li key={`${w.subject.type}:${w.subject.id}`} className="flex items-center gap-3 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                                <Icon className="h-4 w-4" aria-hidden />
                            </span>
                            <Link to={w.subject.link} className="min-w-0 flex-1 hover:underline">
                                <span className="block truncate text-sm font-semibold text-ink">{w.subject.name}</span>
                                <span className="block truncate text-[11px] text-ink-muted">
                                    {w.subject.workspaceName ? `${w.subject.workspaceName} · ` : ''}watching since <DateTime at={w.createdAt} />
                                </span>
                            </Link>
                            {w.open > 0 && (
                                <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
                                    {w.open} open
                                </span>
                            )}
                            <button type="button" aria-label={`Stop watching ${w.subject.name}`} disabled={unwatch.isPending}
                                onClick={() => unwatch.mutate(w.subject)}
                                className="shrink-0 rounded-lg p-1.5 text-ink-muted hover:bg-black/[0.04] hover:text-ink dark:hover:bg-white/[0.06] disabled:opacity-50">
                                <EyeOff className="h-4 w-4" aria-hidden />
                            </button>
                        </li>
                    )
                })}
            </ul>
            {watches.hasNextPage && (
                <button type="button" disabled={watches.isFetchingNextPage} onClick={() => void watches.fetchNextPage()}
                    className="rounded-xl border border-glass-border px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink disabled:opacity-50">
                    Show more
                </button>
            )}
        </div>
    )
}

/** The questions asked of you that nobody has answered — on your profile's Overview. */
export function WaitingOnYouCard({ onOpen }: { onOpen: (threadId?: string) => void }) {
    const summary = useMySummary().data
    const list = useMyConversations('to-me', 'open')
    const threads = list.data?.pages[0]?.threads.slice(0, 3) ?? []
    const people = list.data?.pages[0]?.people ?? {}
    const waiting = summary?.toMe.waiting ?? 0
    return (
        <section aria-labelledby="waiting-on-you" className="rounded-2xl border border-amber-500/25 bg-canvas-elevated p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 id="waiting-on-you" className="flex items-center gap-2 text-sm font-bold text-ink">
                    <MessageCircleQuestion className="h-4 w-4 text-amber-500" aria-hidden /> Waiting on you
                    {waiting > 0 && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{waiting}</span>}
                </h2>
                <button type="button" onClick={() => onOpen()} className="text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300">
                    All conversations
                </button>
            </div>
            {list.isLoading ? (
                <Skeleton className="h-16 w-full rounded-xl" />
            ) : threads.length === 0 ? (
                <p className="text-sm text-ink-muted">Nobody is waiting on an answer from you.</p>
            ) : (
                <ul className="space-y-2">
                    {threads.map(t => (
                        <li key={t.id}><ThreadCard thread={t} people={people} showSubject onOpen={() => onOpen(t.id)} /></li>
                    ))}
                </ul>
            )}
        </section>
    )
}
