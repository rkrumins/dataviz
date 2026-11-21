/**
 * ThreadView — one question and its conversation.
 *
 * Its state up top (Open, Answered, Closed; Private, naming who can see it), the node it is
 * about with Show on canvas, who is taking part, and the thread's "…" (Copy link, Mute, Follow,
 * Close or Reopen, Delete question). Then the question, larger; the replies, the accepted one
 * framed; a "New since you last looked" line before the first reply the reader has not seen; and
 * the reply box, held to the foot of the pane.
 *
 * Polled while open, asking only for what changed. A reply someone else posts is spoken (an
 * aria-live line), and reading the thread marks it read. A link to a message scrolls to it and
 * lights it up. A write refused because the thread changed first says so, with Reload.
 *
 * Reusable: the drawer shows it, and so can a profile's Conversations or a data source's
 * Questions tab — it needs only the thread's id.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
    ArrowLeft, Bell, BellOff, CheckCircle2, Circle, Crosshair, Eye, EyeOff, Link2, Lock, Loader2,
    MapPin, MessageSquare, RefreshCw, RotateCcw, Trash2, XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { HoverTip } from '@/components/ui/HoverTip'
import { EmptyState } from '@/components/ui/EmptyState'
import { AvatarStack } from '@/components/ui/AvatarStack'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { DateTime } from '@/components/ui/DateTime'
import { useAppNotifications } from '@/components/ui/notifications'
import { CommentComposer } from '@/features/reviews/comments/CommentComposer'
import { useAuthStore } from '@/store/auth'
import { isStale, type DiscussionStatus, type ThreadDetail } from '@/services/discussionsService'
import { useDiscussionActions, useMentionSource, useThread } from './useDiscussions'
import { MessageItem } from './MessageItem'
import { OverflowMenu } from './OverflowMenu'
import {
    STATUS_CLASS, STATUS_LABEL, listNames, messageLink, nameOf, stackPerson, subjectNoun,
} from './discussionText'

const STATUS_ICON: Record<DiscussionStatus, typeof Circle> = { open: Circle, answered: CheckCircle2, closed: XCircle }

export function StatusPill({ status, className }: { status: DiscussionStatus; className?: string }) {
    const Icon = STATUS_ICON[status]
    return (
        <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-px text-[10.5px] font-semibold leading-4', STATUS_CLASS[status], className)}>
            <Icon className="w-3 h-3" aria-hidden />{STATUS_LABEL[status]}
        </span>
    )
}

export function PrivateBadge({ thread }: { thread: Pick<ThreadDetail, 'privateAudience' | 'people' | 'subject'> }) {
    const audience = thread.privateAudience ?? []
    const names = audience.map((id) => nameOf(id, thread.people))
    return (
        <HoverTip
            label="Only the people involved can see this"
            detail={names.length
                ? `${listNames(names, 6)} — the people asked, mentioned or replying, ${subjectNoun(thread.subject)}’s owners and the workspace’s admins.`
                : `The people asked, mentioned or replying, ${subjectNoun(thread.subject)}’s owners and the workspace’s admins.`}
        >
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-px text-[10.5px] font-semibold leading-4 text-violet-700 dark:text-violet-300">
                <Lock className="w-3 h-3" aria-hidden />Private
            </span>
        </HoverTip>
    )
}

export interface ThreadViewProps {
    threadId: string
    /** Scroll to this message and light it up (a link to it). */
    focusMessageId?: string | null
    /** Back to the list it was opened from; none, no Back. */
    onBack?: () => void
    /** Show the node it is about on the canvas; none, no such button. */
    onShowOnCanvas?: (entityId: string) => void
    /** After the question was deleted. */
    onDeleted?: () => void
    className?: string
}

function ThreadSkeleton() {
    return (
        <div className="space-y-5 p-5" aria-busy="true" aria-label="Loading the conversation">
            <div className="flex items-center gap-2"><Skeleton className="h-5 w-16 rounded-full" /><Skeleton className="h-5 w-20 rounded-full" /></div>
            <div className="flex items-start gap-3">
                <Skeleton className="w-9 h-9 rounded-full shrink-0" />
                <div className="flex-1 space-y-2"><Skeleton className="h-3 w-32" /><SkeletonText lines={3} /></div>
            </div>
            {[0, 1].map((i) => (
                <div key={i} className="flex items-start gap-3 pl-1">
                    <Skeleton className="w-7 h-7 rounded-full shrink-0" />
                    <div className="flex-1 space-y-2"><Skeleton className="h-3 w-24" /><SkeletonText lines={2} /></div>
                </div>
            ))}
        </div>
    )
}

export function ThreadView({ threadId, focusMessageId, onBack, onShowOnCanvas, onDeleted, className }: ThreadViewProps) {
    const me = useAuthStore((s) => s.user?.id)
    const { notify } = useAppNotifications()
    const q = useThread(threadId)
    const thread = q.data
    const actions = useDiscussionActions()
    const [stale, setStale] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [live, setLive] = useState('')
    const [lit, setLit] = useState<string | null>(null)

    // Where the reader had read to when they opened it: kept for the visit, so the line does
    // not jump to the bottom the moment the thread is marked read.
    const [readMark, setReadMark] = useState<{ id: string; at: string | null } | null>(null)
    if (thread && readMark?.id !== thread.id) setReadMark({ id: thread.id, at: thread.lastReadAt })

    const onStale = useCallback((e: unknown) => {
        if (!isStale(e)) return false
        setStale(true)
        return true
    }, [])
    const onError = useCallback((e: unknown) => notify('error', (e as Error)?.message || 'That didn’t work. Try again.'), [notify])
    const fail = (e: unknown) => { if (!onStale(e)) onError(e) }

    // Reading it marks it read — on open, and as replies arrive while it is on screen.
    const { markRead } = actions
    const unread = !!thread?.unread
    useEffect(() => {
        if (!unread || markRead.isPending || document.visibilityState !== 'visible') return
        markRead.mutate(threadId)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per arrival, not per mutation state
    }, [threadId, unread, thread?.lastActivityAt])

    // Speak a reply someone else posted while the thread is open.
    const seen = useRef<Set<string> | null>(null)
    useEffect(() => {
        if (!thread) return
        const ids = thread.messages.map((m) => m.id)
        if (seen.current) {
            const fresh = thread.messages.filter((m) => !seen.current!.has(m.id) && m.authorId !== me && !m.deletedAt)
            if (fresh.length === 1) setLive(`New reply from ${nameOf(fresh[0].authorId, thread.people)}`)
            else if (fresh.length > 1) setLive(`${fresh.length} new replies`)
        }
        seen.current = new Set(ids)
    }, [thread, me])

    // A link to a message: older pages read until it is found, then scrolled to and lit up.
    const messages = useRef<HTMLDivElement>(null)
    const landed = useRef<string | null>(null)
    const { loadOlder } = q
    useEffect(() => {
        if (!thread || !focusMessageId || landed.current === focusMessageId) return
        if (!thread.messages.some((m) => m.id === focusMessageId)) {
            if (thread.olderCursor) void loadOlder()
            else landed.current = focusMessageId
            return
        }
        landed.current = focusMessageId
        requestAnimationFrame(() => {
            const el = [...(messages.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])]
                .find((n) => n.dataset.messageId === focusMessageId)
            el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
            el?.focus({ preventScroll: true })
            setLit(focusMessageId)
        })
    }, [thread, focusMessageId, loadOlder])
    useEffect(() => {
        if (!lit) return
        const t = window.setTimeout(() => setLit(null), 2600)
        return () => window.clearTimeout(t)
    }, [lit])

    // After the reader's own reply lands, the end of the thread is where they look.
    const end = useRef<HTMLDivElement>(null)
    const [sentAt, setSentAt] = useState(0)
    useLayoutEffect(() => { if (sentAt) end.current?.scrollIntoView?.({ block: 'end' }) }, [sentAt])

    const mentionSource = useMentionSource(thread?.subject ?? { type: 'view', id: '' })

    const ordered = useMemo(() => {
        if (!thread) return { question: null, replies: [] as ThreadDetail['messages'] }
        return {
            question: thread.messages.find((m) => m.kind === 'question') ?? null,
            replies: thread.messages.filter((m) => m.kind !== 'question'),
        }
    }, [thread])

    if (q.isLoading) return <div className={className}><ThreadSkeleton /></div>
    if (q.isError || !thread) {
        const gone = (q.error as { status?: number } | null)?.status === 404
        return (
            <div className={cn('p-5', className)}>
                {onBack && <BackButton onBack={onBack} />}
                <EmptyState icon={MessageSquare}
                    title={gone ? 'This conversation isn’t here' : 'Couldn’t load this conversation'}
                    description={gone
                        ? 'It was deleted, or you can no longer open what it is about.'
                        : 'Check your connection, then try again.'}
                    action={gone ? undefined : { label: 'Try again', icon: RefreshCw, onClick: () => void q.refetch() }} />
            </div>
        )
    }

    const people = thread.people
    const replyCount = ordered.replies.filter((m) => !m.deletedAt).length
    const firstNew = readMark?.id === thread.id && readMark.at
        ? ordered.replies.find((m) => Date.parse(m.createdAt) > Date.parse(readMark.at!) && m.authorId !== me)?.id ?? null
        : null
    const isAsker = !!me && thread.askedBy === me
    const mayDelete = thread.access.canModerate || isAsker
    const participants = thread.participantIds.map((id) => stackPerson(id, people))

    const copyLink = () => {
        void navigator.clipboard?.writeText(messageLink(thread.subject.link, thread.id))
            .then(() => notify('success', 'Link to this conversation copied'))
            .catch(() => notify('error', 'Couldn’t copy the link'))
    }
    const setStatus = (close: boolean) =>
        actions.setStatus.mutate({ threadId: thread.id, close, expectedVersion: thread.version }, { onError: fail })

    return (
        <section aria-label={`Question from ${nameOf(thread.askedBy, people)}`} className={cn('flex flex-col min-h-full', className)}>
            <p className="sr-only" role="status" aria-live="polite">{live}</p>

            <header className="px-5 pt-4 pb-3 space-y-3">
                <div className="flex items-center gap-2">
                    {onBack && <BackButton onBack={onBack} />}
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                        <StatusPill status={thread.status} />
                        {thread.visibility === 'private' && <PrivateBadge thread={thread} />}
                        {thread.muted && (
                            <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-muted"><BellOff className="w-3 h-3" aria-hidden />Muted</span>
                        )}
                    </div>
                    <OverflowMenu label="Conversation actions" items={[
                        { label: 'Copy link', icon: Link2, onSelect: copyLink },
                        { label: thread.muted ? 'Unmute' : 'Mute notifications', icon: thread.muted ? Bell : BellOff,
                            onSelect: () => actions.setMine.mutate({ threadId: thread.id, muted: !thread.muted }, { onError }) },
                        { label: thread.following ? 'Stop following' : 'Follow', icon: thread.following ? EyeOff : Eye,
                            onSelect: () => actions.setMine.mutate({ threadId: thread.id, following: !thread.following }, { onError }) },
                        { label: 'Close question', icon: XCircle, onSelect: () => setStatus(true), hidden: !thread.access.canClose || thread.status === 'closed' },
                        { label: 'Reopen', icon: RotateCcw, onSelect: () => setStatus(false), hidden: !thread.access.canClose || thread.status !== 'closed' },
                        { label: 'Delete question', icon: Trash2, onSelect: () => setConfirmDelete(true), danger: true, hidden: !mayDelete },
                    ]} />
                </div>

                {thread.entityId && (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2 py-1 text-[11.5px] font-medium text-amber-800 dark:text-amber-200">
                            <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden />
                            <span className="text-amber-700/80 dark:text-amber-300/80">About</span>
                            <span className="truncate font-semibold">{thread.entityLabel || thread.entityId}</span>
                        </span>
                        {onShowOnCanvas && (
                            <button type="button" onClick={() => onShowOnCanvas(thread.entityId!)}
                                className="inline-flex items-center gap-1 rounded-lg px-2 h-7 text-[11.5px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                <Crosshair className="w-3.5 h-3.5" aria-hidden />Show on canvas
                            </button>
                        )}
                    </div>
                )}

                <div className="flex items-center gap-2.5 text-[11.5px] text-ink-muted">
                    <AvatarStack people={participants} total={thread.participantCount} max={5} size="sm" label="Taking part" />
                    <span>
                        {thread.participantCount.toLocaleString()} {thread.participantCount === 1 ? 'person' : 'people'}
                        <span aria-hidden className="mx-1 text-ink-muted/60">·</span>
                        {replyCount.toLocaleString()} {replyCount === 1 ? 'reply' : 'replies'}
                    </span>
                </div>

                {stale && (
                    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
                        <RefreshCw className="w-3.5 h-3.5 shrink-0" aria-hidden />
                        <span className="flex-1 min-w-0">This changed — someone else updated it while you were looking.</span>
                        <button type="button" onClick={() => { void q.reload().then(() => setStale(false), onError) }}
                            className="font-semibold underline-offset-2 hover:underline">Reload</button>
                    </div>
                )}
                {confirmDelete && (
                    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2 text-[12px] text-ink-secondary">
                        <span className="flex-1 min-w-0">Delete this question and its {replyCount.toLocaleString()} {replyCount === 1 ? 'reply' : 'replies'}? This can’t be undone.</span>
                        <button type="button" disabled={actions.removeThread.isPending}
                            onClick={() => actions.removeThread.mutate({ threadId: thread.id }, {
                                onSuccess: () => { notify('success', 'Question deleted'); onDeleted?.() },
                                onError: fail,
                                onSettled: () => setConfirmDelete(false),
                            })}
                            className="inline-flex items-center gap-1 font-semibold text-rose-600 dark:text-rose-300 hover:underline disabled:opacity-50">
                            {actions.removeThread.isPending && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}Delete
                        </button>
                        <button type="button" onClick={() => setConfirmDelete(false)} className="font-semibold hover:underline">Keep</button>
                    </div>
                )}
            </header>

            <div ref={messages} className="flex-1 px-3 pb-4 space-y-1">
                {ordered.question ? (
                    <div className="mx-2 rounded-2xl border border-glass-border/70 bg-canvas shadow-sm">
                        <MessageItem thread={thread} message={ordered.question}
                            highlighted={lit === ordered.question.id} onStale={onStale} onError={onError} />
                    </div>
                ) : (
                    // The question is further back than the page shown: its opening, for context.
                    <div className="mx-2 rounded-2xl border border-glass-border/70 bg-canvas p-4 shadow-sm">
                        <p className="flex items-center gap-2 text-[11px] text-ink-muted">
                            <UserAvatar userId={thread.askedBy} name={nameOf(thread.askedBy, people)} avatarId={people[thread.askedBy]?.avatarId}
                                hasImage={people[thread.askedBy]?.hasImage} className="w-6 h-6 text-[9px] font-bold" />
                            <span className="font-semibold text-ink">{nameOf(thread.askedBy, people)}</span> asked <DateTime at={thread.createdAt} />
                        </p>
                        <p className="mt-2 text-[14px] font-medium leading-relaxed text-ink">{thread.excerpt}</p>
                    </div>
                )}

                {thread.olderCursor && (
                    <div className="flex justify-center py-1">
                        <button type="button" onClick={() => void loadOlder().catch(onError)}
                            className="rounded-full border border-glass-border/70 px-3 h-7 text-[11.5px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.05]">
                            Show earlier replies
                        </button>
                    </div>
                )}

                {ordered.replies.length > 0 && (
                    <div className="relative ml-[2.15rem] mr-2 pl-3 pt-2 space-y-1 border-l border-glass-border/80">
                        {ordered.replies.map((m) => (
                            <div key={m.id}>
                                {m.id === firstNew && (
                                    <div role="separator" aria-label="New since you last looked"
                                        className="-ml-3 my-2 flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.12em] text-accent-lineage">
                                        <span className="h-px flex-1 bg-accent-lineage/40" />New since you last looked<span className="h-px w-3 bg-accent-lineage/40" />
                                    </div>
                                )}
                                <MessageItem thread={thread} message={m} highlighted={lit === m.id} onStale={onStale} onError={onError} />
                            </div>
                        ))}
                    </div>
                )}
                {ordered.replies.length === 0 && thread.status === 'open' && (
                    <p className="px-5 pt-3 text-[12px] text-ink-muted">
                        No replies yet. The people asked have been told; you’ll hear in your Inbox when someone answers.
                    </p>
                )}
                <div ref={end} />
            </div>

            <footer className="sticky bottom-0 z-10 border-t border-glass-border/70 bg-canvas-elevated px-5 py-3">
                {thread.status === 'closed' ? (
                    <p className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                        <XCircle className="w-3.5 h-3.5" aria-hidden />This question is closed.
                        {thread.access.canClose && (
                            <button type="button" onClick={() => setStatus(false)} className="font-semibold text-accent-lineage hover:underline">Reopen it to reply</button>
                        )}
                    </p>
                ) : thread.access.canReply ? (
                    <CommentComposer
                        key={thread.id}
                        mentionSource={mentionSource}
                        placeholder={isAsker ? 'Add to your question…' : 'Write a reply…'}
                        submitLabel="Reply"
                        onSubmit={async (body, mentions, clientKey) => {
                            try {
                                await actions.reply.mutateAsync({ threadId: thread.id, body, mentions, clientKey })
                                setSentAt(Date.now())
                            } catch (e) {
                                onStale(e)
                                throw e
                            }
                        }}
                    />
                ) : (
                    <p className="text-[12px] text-ink-muted">You can read this conversation, but not reply to it.</p>
                )}
            </footer>
        </section>
    )
}

function BackButton({ onBack }: { onBack: () => void }) {
    return (
        <button type="button" onClick={onBack} aria-label="Back to all questions"
            className="inline-flex items-center gap-1 rounded-lg px-1.5 h-7 text-[12px] font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
            <ArrowLeft className="w-4 h-4" aria-hidden /><span className="hidden sm:inline">All questions</span>
        </button>
    )
}
