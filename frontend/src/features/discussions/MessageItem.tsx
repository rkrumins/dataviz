/**
 * MessageItem — one message of a thread: who wrote it (their card on hover), what they are here
 * (Asker, View owner, Data steward, Admin), when, and what. The question reads larger than the
 * replies; the accepted answer is framed. Edited and deleted messages say so. Its "…" holds Copy
 * link, and — as the reader may — Edit, Delete and Mark as answer.
 */
import { useState } from 'react'
import { Check, CheckCircle2, Link2, Pencil, Trash2, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { DateTime } from '@/components/ui/DateTime'
import { HoverTip } from '@/components/ui/HoverTip'
import { PersonHoverCard } from '@/components/explorer/PersonHoverCard'
import { useAppNotifications } from '@/components/ui/notifications'
import { CommentComposer } from '@/features/reviews/comments/CommentComposer'
import { useAuthStore } from '@/store/auth'
import type { Message, ThreadDetail } from '@/services/discussionsService'
import { useDiscussionActions, useMentionSource } from './useDiscussions'
import { MessageBody } from './MessageBody'
import { OverflowMenu } from './OverflowMenu'
import { ROLE_CLASS, ROLE_LABEL, messageLink, nameOf } from './discussionText'

export interface MessageItemProps {
    thread: ThreadDetail
    message: Message
    /** The message a link pointed at: lit up for a moment. */
    highlighted?: boolean
    /** A write was refused because the thread changed first. */
    onStale?: (err: unknown) => boolean
    /** A write failed for another reason. */
    onError?: (err: unknown) => void
}

export function MessageItem({ thread, message, highlighted, onStale, onError }: MessageItemProps) {
    const me = useAuthStore((s) => s.user?.id)
    const { notify } = useAppNotifications()
    const { edit, remove, answer } = useDiscussionActions()
    const mentionSource = useMentionSource(thread.subject)
    const [editing, setEditing] = useState(false)
    const [confirming, setConfirming] = useState(false)

    const people = thread.people
    const author = people[message.authorId]
    const who = nameOf(message.authorId, people)
    const question = message.kind === 'question'
    const deleted = !!message.deletedAt
    const accepted = !deleted && thread.answerMessageId === message.id
    const mine = !!me && message.authorId === me
    const mayEdit = mine && !deleted && thread.access.canReply
    const mayDelete = !deleted && !question && (mine || thread.access.canModerate)
    const mayAnswer = !deleted && !question && thread.access.canAnswer && thread.status !== 'closed'
    const roles = message.roles.map((r) => ROLE_LABEL[r])

    const fail = (e: unknown) => { if (!onStale?.(e)) onError?.(e) }
    const copyLink = () => {
        void navigator.clipboard?.writeText(messageLink(thread.subject.link, thread.id, message.id))
            .then(() => notify('success', 'Link to this message copied'))
            .catch(() => notify('error', 'Couldn’t copy the link'))
    }
    const setAnswer = (messageId: string | null) =>
        answer.mutate({ threadId: thread.id, messageId, expectedVersion: thread.version }, { onError: fail })

    return (
        <article tabIndex={-1} id={`message-${message.id}`} data-message-id={message.id}
            aria-label={`${question ? 'Question' : accepted ? 'Accepted answer' : 'Reply'} from ${who}`}
            className={cn('group/message relative rounded-2xl outline-none transition-[background-color,box-shadow] duration-700',
                accepted ? 'border border-emerald-500/40 bg-emerald-500/[0.05] dark:bg-emerald-400/[0.06] shadow-sm shadow-emerald-500/10' : 'border border-transparent',
                question ? 'p-4' : 'px-3 py-2.5',
                highlighted && 'ring-2 ring-accent-lineage/50 bg-accent-lineage/[0.06]',
                'focus-visible:ring-2 focus-visible:ring-accent-lineage/50')}>
            {accepted && (
                <p className="mb-2 -mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
                    {thread.resolvedBy ? `Accepted by ${nameOf(thread.resolvedBy, people)}` : 'Accepted answer'}
                </p>
            )}
            <div className="flex items-start gap-3">
                <PersonHoverCard userId={message.authorId} displayName={who} email={author?.email} avatarId={author?.avatarId}
                    roles={roles.length ? roles : ['Taking part']}>
                    <span className="shrink-0 rounded-full">
                        <UserAvatar userId={author?.deleted ? null : message.authorId} name={who} avatarId={author?.avatarId} hasImage={author?.hasImage}
                            className={cn('font-bold', question ? 'w-9 h-9 text-xs' : 'w-7 h-7 text-[10px]', (author?.deleted || deleted) && 'grayscale opacity-70')} />
                    </span>
                </PersonHoverCard>
                <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-ink-muted">
                        <span className={cn('font-semibold', question ? 'text-[13px]' : 'text-[12.5px]', author?.deleted ? 'text-ink-muted' : 'text-ink')}>{who}</span>
                        {message.roles.map((r) => (
                            <span key={r} className={cn('rounded-full px-1.5 py-px text-[9.5px] font-semibold leading-4', ROLE_CLASS[r])}>{ROLE_LABEL[r]}</span>
                        ))}
                        <span aria-hidden className="text-ink-muted/60">·</span>
                        <DateTime at={message.createdAt} />
                        {message.editedAt && !deleted && (
                            <HoverTip label={<span>Edited <DateTime at={message.editedAt} variant="calendar" /></span>}>
                                <span className="italic">edited</span>
                            </HoverTip>
                        )}
                        {/* The one-click way to accept, where nothing is accepted yet: on hover or focus. */}
                        {mayAnswer && !accepted && !thread.answerMessageId && !editing && (
                            <button type="button" onClick={() => setAnswer(message.id)} disabled={answer.isPending}
                                className="ml-auto -my-1 hidden items-center gap-1 rounded-lg px-1.5 h-6 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 group-hover/message:inline-flex group-focus-within/message:inline-flex">
                                <Check className="w-3.5 h-3.5" aria-hidden />Mark as answer
                            </button>
                        )}
                    </p>
                    {deleted ? (
                        <p className="mt-1 text-[12.5px] italic text-ink-muted">This message was deleted.</p>
                    ) : editing ? (
                        <CommentComposer
                            mentionSource={mentionSource} autoFocus className="mt-1.5"
                            initial={{ body: message.body, mentions: Object.fromEntries(message.mentions.map((id) => [id, people[id]?.displayName || id])) }}
                            onCancel={() => setEditing(false)}
                            onSubmit={async (body, mentions) => {
                                try {
                                    await edit.mutateAsync({ threadId: thread.id, messageId: message.id, body, mentions, expectedVersion: message.version })
                                    setEditing(false)
                                } catch (e) {
                                    onStale?.(e)
                                    throw e
                                }
                            }}
                        />
                    ) : (
                        <MessageBody body={message.body} mentions={message.mentions} people={people}
                            className={cn('mt-1', question ? 'text-[14.5px] leading-relaxed font-medium' : 'text-[13px] leading-relaxed')} />
                    )}
                    {confirming && (
                        <p className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-secondary" role="alert">
                            Delete this message? Everyone will see that it was deleted.
                            <button type="button" disabled={remove.isPending}
                                onClick={() => remove.mutate({ threadId: thread.id, messageId: message.id }, { onError: fail, onSettled: () => setConfirming(false) })}
                                className="font-semibold text-rose-600 dark:text-rose-300 hover:underline disabled:opacity-50">
                                {remove.isPending ? 'Deleting…' : 'Delete'}
                            </button>
                            <button type="button" onClick={() => setConfirming(false)} className="font-semibold hover:underline">Keep</button>
                        </p>
                    )}
                </div>
                {!editing && (
                    <OverflowMenu label="Message actions"
                        triggerClassName="opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                        items={[
                            { label: 'Copy link', icon: Link2, onSelect: copyLink, hidden: deleted },
                            { label: 'Edit', icon: Pencil, onSelect: () => setEditing(true), hidden: !mayEdit },
                            { label: 'Mark as answer', icon: CheckCircle2, onSelect: () => setAnswer(message.id), hidden: !mayAnswer || accepted },
                            { label: 'Unmark as answer', icon: Undo2, onSelect: () => setAnswer(null), hidden: !accepted || !thread.access.canAnswer },
                            { label: 'Delete', icon: Trash2, onSelect: () => setConfirming(true), danger: true, hidden: !mayDelete },
                        ]} />
                )}
            </div>
        </article>
    )
}
