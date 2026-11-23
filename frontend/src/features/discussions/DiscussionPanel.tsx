/**
 * DiscussionPanel — a subject's questions: who to ask, a box to ask in, and every thread.
 *
 * Leads with the people who look after it, then "Ask a question…", which opens into the full
 * AskComposer. Below, Open · Answered · All · Mine (with counts), a chip when the list is about
 * one node, and a row per thread: who is taking part, the question's opening, the node it is
 * about, its status, a lock when private, how many replies, an unread dot, and when it last
 * moved. ↑/↓ move between rows and Enter opens one.
 *
 * Reusable: the drawer shows it for a view; a data source's Questions tab can show it too.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, Database, LayoutGrid, Lock, MapPin, MessageCircleQuestion, MessageSquare, RefreshCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AvatarStack } from '@/components/ui/AvatarStack'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useAuthStore } from '@/store/auth'
import type { AskResult, DiscussionStatus, PeopleMap, ThreadSummary } from '@/services/discussionsService'
import { useSubjectSummary, useSubjectThreads } from './useDiscussions'
import { AskComposer } from './AskComposer'
import { WhoToAsk } from './WhoToAsk'
import { StatusPill } from './ThreadView'
import type { DrawerEntity, DrawerSubject } from './drawerStore'
import { nameOf, stackPerson, subjectNoun } from './discussionText'

type Filter = 'open' | 'answered' | 'all' | 'mine'

export function ThreadCard({ thread, people, onOpen, showAnchor = true, showSubject = false, selected = false }: {
    thread: ThreadSummary
    people: PeopleMap
    onOpen: () => void
    /** The node chip — off when the list is already about that node. */
    showAnchor?: boolean
    /** Which view or data source it is about — for lists across many (your own conversations). */
    showSubject?: boolean
    /** The one open beside the list. */
    selected?: boolean
}) {
    const SubjectIcon = thread.subject.type === 'view' ? LayoutGrid : Database
    const replies = Math.max(0, thread.messageCount - 1)
    const asker = nameOf(thread.askedBy, people)
    const others = thread.participantIds.filter((id) => id !== thread.askedBy).map((id) => stackPerson(id, people))
    return (
        <button type="button" data-thread-row onClick={onOpen} aria-current={selected || undefined}
            aria-label={`${thread.unread ? 'Unread. ' : ''}${asker} asked${showSubject ? ` about ${thread.subject.name}` : ''}: ${thread.excerpt}`}
            className={cn('group w-full text-left rounded-2xl border px-3.5 py-3 transition-[background-color,border-color,box-shadow] duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                selected ? 'border-accent-lineage/40 bg-accent-lineage/[0.07] shadow-sm' : thread.unread
                    ? 'border-accent-lineage/25 bg-accent-lineage/[0.035] hover:bg-accent-lineage/[0.06]'
                    : 'border-glass-border/70 bg-canvas hover:bg-black/[0.02] dark:hover:bg-white/[0.03] hover:border-ink-muted/25')}>
            <div className="flex items-start gap-3">
                <UserAvatar userId={thread.askedBy} name={asker} avatarId={people[thread.askedBy]?.avatarId} hasImage={people[thread.askedBy]?.hasImage}
                    className={cn('w-8 h-8 text-[10px] font-bold mt-0.5', people[thread.askedBy]?.deleted && 'grayscale opacity-70')} />
                <div className="min-w-0 flex-1">
                    {showSubject && (
                        <p className="mb-0.5 flex items-center gap-1 min-w-0 text-[11px] font-semibold text-accent-lineage">
                            <SubjectIcon className="w-3 h-3 shrink-0" aria-hidden />
                            <span className="truncate">{thread.subject.name}</span>
                            {thread.subject.workspaceName && <span className="truncate font-normal text-ink-muted">· {thread.subject.workspaceName}</span>}
                        </p>
                    )}
                    <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                        <span className="truncate font-semibold text-ink-secondary">{asker}</span>
                        <span aria-hidden className="text-ink-muted/60">·</span>
                        <DateTime at={thread.lastActivityAt} className="shrink-0" />
                        {thread.unread && <span className="ml-auto w-2 h-2 shrink-0 rounded-full bg-accent-lineage" aria-hidden />}
                    </p>
                    <p className={cn('mt-0.5 line-clamp-2 text-[13px] leading-snug', thread.unread ? 'font-semibold text-ink' : 'font-medium text-ink')}>
                        {thread.excerpt}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
                        <StatusPill status={thread.status} />
                        {thread.visibility === 'private' && (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-violet-500/10 px-1.5 py-px text-[10.5px] font-semibold text-violet-700 dark:text-violet-300">
                                <Lock className="w-3 h-3" aria-hidden /><span className="sr-only sm:not-sr-only">Private</span>
                            </span>
                        )}
                        {showAnchor && thread.entityId && (
                            <span className="inline-flex items-center gap-1 min-w-0 max-w-[12rem] rounded-full bg-amber-500/10 px-1.5 py-px text-[10.5px] font-semibold text-amber-800 dark:text-amber-200">
                                <MapPin className="w-3 h-3 shrink-0" aria-hidden /><span className="truncate">{thread.entityLabel || thread.entityId}</span>
                            </span>
                        )}
                        <span className="inline-flex items-center gap-1 tabular-nums">
                            <MessageSquare className="w-3 h-3" aria-hidden />{replies.toLocaleString()}<span className="sr-only"> {replies === 1 ? 'reply' : 'replies'}</span>
                        </span>
                        {others.length > 0 && (
                            <AvatarStack people={others} total={Math.max(others.length, thread.participantCount - 1)} max={3} size="xs" ring="ring-canvas" label="Taking part" className="ml-auto" />
                        )}
                    </div>
                </div>
            </div>
        </button>
    )
}

function RowSkeleton() {
    return (
        <div className="rounded-2xl border border-glass-border/70 px-3.5 py-3">
            <div className="flex items-start gap-3">
                <Skeleton className="w-8 h-8 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                    <Skeleton className="h-2.5 w-28" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-3/5" />
                    <div className="flex gap-1.5 pt-0.5"><Skeleton className="h-4 w-14 rounded-full" /><Skeleton className="h-4 w-10 rounded-full" /></div>
                </div>
            </div>
        </div>
    )
}

export interface DiscussionPanelProps {
    subject: DrawerSubject
    /** Only the questions about this node — and a new one is asked about it. */
    entity?: DrawerEntity | null
    onEntityChange?: (entity: DrawerEntity | null) => void
    onOpenThread: (threadId: string) => void
    /** The ask box open (controlled, with `onComposeChange`; else it starts so). */
    compose?: boolean
    onComposeChange?: (open: boolean) => void
    /** People to ask besides the routes, when the ask box opens. */
    recipients?: string[]
    /** Lead with who to ask (default). */
    showWhoToAsk?: boolean
    className?: string
}

export function DiscussionPanel({
    subject, entity = null, onEntityChange, onOpenThread, compose, onComposeChange, recipients, showWhoToAsk = true, className,
}: DiscussionPanelProps) {
    const me = useAuthStore((s) => s.user)
    const [filter, setFilter] = useState<Filter>('all')
    const [ownCompose, setOwnCompose] = useState(!!compose)
    const composing = onComposeChange ? !!compose : ownCompose
    const setComposing = onComposeChange ?? setOwnCompose
    const [ownEntity, setOwnEntity] = useState<DrawerEntity | null>(entity)
    const about = onEntityChange ? entity : ownEntity
    const setAbout = onEntityChange ?? setOwnEntity

    const summary = useSubjectSummary(subject, { live: true }).data
    const status: DiscussionStatus | 'all' = filter === 'open' || filter === 'answered' ? filter : 'all'
    const q = useSubjectThreads(subject, { status, mine: filter === 'mine', entityId: about?.id ?? null })
    const pages = q.data?.pages ?? []
    const threads = pages.flatMap((p) => p.threads)
    const people: PeopleMap = Object.assign({}, ...pages.map((p) => p.people))
    const list = useRef<HTMLDivElement>(null)
    const noun = subjectNoun(subject)
    const myName = me?.displayName || [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.email || 'You'

    const onListKeys = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-thread-row]') ?? [])]
        if (rows.length === 0) return
        e.preventDefault()
        const at = rows.indexOf(document.activeElement as HTMLButtonElement)
        const next = at < 0 ? 0 : e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)
        rows[next].focus()
    }
    const asked = (res: AskResult) => { setComposing(false); onOpenThread(res.thread.id) }

    const empty = (() => {
        const ask = { label: about ? `Ask about ${about.label}` : 'Ask a question', icon: MessageCircleQuestion, onClick: () => setComposing(true) }
        if (about) return <EmptyState compact icon={MapPin} title={`No questions about ${about.label} yet`}
            description={`Wondering what it is, where it comes from, or whether it’s right? Ask the people who look after ${noun}.`}
            action={ask} secondaryAction={{ label: `All of ${noun}`, onClick: () => setAbout(null) }} />
        if (filter === 'open') return <EmptyState compact icon={MessageSquare} title="No open questions"
            description="Every question here has been answered or closed." secondaryAction={{ label: 'Show all', onClick: () => setFilter('all') }} />
        if (filter === 'answered') return <EmptyState compact icon={MessageSquare} title="No answered questions yet"
            description="When the asker accepts a reply, the question lands here, with the answer marked." />
        if (filter === 'mine') return <EmptyState compact icon={MessageSquare} title="Nothing of yours here"
            description={`Questions you ask about ${noun}, or reply to, are listed here.`} action={ask} />
        return <EmptyState icon={MessageCircleQuestion} title="No questions yet"
            description={`Ask the people who look after ${noun} what it shows, where its data comes from, or whether it’s right. The answer stays here for the next person who wonders.`}
            action={ask} />
    })()

    return (
        <div className={cn('space-y-4', className)}>
            {showWhoToAsk && <WhoToAsk subject={subject} variant="strip" />}

            {composing ? (
                <AskComposer subject={subject} entity={about} onClearEntity={() => setAbout(null)} initialRecipients={recipients}
                    autoFocus onAsked={asked} onCancel={() => setComposing(false)} />
            ) : (
                <button type="button" onClick={() => setComposing(true)} aria-label={about ? `Ask about ${about.label}` : 'Ask a question'}
                    className="group flex w-full items-center gap-2.5 rounded-2xl border border-glass-border/70 bg-canvas px-3 py-2.5 text-left shadow-sm transition-colors hover:border-accent-lineage/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                    <UserAvatar userId={me?.id} name={myName} className="w-7 h-7 text-[10px] font-bold" />
                    <span className="flex-1 text-[13px] text-ink-muted group-hover:text-ink-secondary">
                        {about ? `Ask about ${about.label}…` : 'Ask a question…'}
                    </span>
                    <span className="hidden sm:inline-flex items-center gap-1 rounded-lg bg-accent-lineage/10 px-2 h-6 text-[11px] font-semibold text-accent-lineage">
                        <MessageCircleQuestion className="w-3.5 h-3.5" aria-hidden />Ask
                    </span>
                </button>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <Segmented<Filter> label="Which questions" value={filter} onChange={setFilter} options={[
                    { value: 'open', label: 'Open', count: summary?.open },
                    { value: 'answered', label: 'Answered', count: summary?.answered },
                    { value: 'all', label: 'All', count: summary?.total },
                    { value: 'mine', label: 'Mine' },
                ]} />
                {about && (
                    <span className="inline-flex items-center gap-1 min-w-0 max-w-full rounded-lg border border-amber-500/25 bg-amber-500/[0.07] pl-1.5 pr-1 h-7 text-[11.5px] font-medium text-amber-800 dark:text-amber-200">
                        <MapPin className="w-3 h-3 shrink-0" aria-hidden />
                        <span className="truncate font-semibold">{about.label}</span>
                        <button type="button" onClick={() => setAbout(null)} aria-label={`Show questions about all of ${noun}`}
                            className="ml-0.5 rounded p-0.5 hover:bg-amber-500/15"><X className="w-3 h-3" aria-hidden /></button>
                    </span>
                )}
            </div>

            <div ref={list} onKeyDown={onListKeys} role="list" aria-label="Questions" aria-busy={q.isLoading}
                className="space-y-2">
                {q.isLoading ? (
                    <>{[0, 1, 2].map((i) => <RowSkeleton key={i} />)}</>
                ) : q.isError ? (
                    <EmptyState compact icon={RefreshCw} title="Couldn’t load the questions"
                        description="Check your connection, then try again." action={{ label: 'Try again', icon: RefreshCw, onClick: () => void q.refetch() }} />
                ) : threads.length === 0 ? empty : (
                    threads.map((t) => (
                        <div key={t.id} role="listitem">
                            <ThreadCard thread={t} people={people} onOpen={() => onOpenThread(t.id)} showAnchor={!about} />
                        </div>
                    ))
                )}
                {q.hasNextPage && (
                    <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}
                        className="mx-auto flex items-center gap-1 rounded-full border border-glass-border/70 px-3 h-7 text-[11.5px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-60">
                        <ChevronDown className="w-3.5 h-3.5" aria-hidden />{q.isFetchingNextPage ? 'Loading…' : 'Show more'}
                    </button>
                )}
            </div>
        </div>
    )
}
