/**
 * A review's threads — on one change, on the review, one followed from a notification, or all —
 * and where a new one is started. Each thread reads as a conversation: who wrote what and when,
 * people mentioned highlighted, replies in order, the field it is on, *Outdated* once the change
 * was edited since, and Resolve / Reopen. A resolved thread folds to one line.
 *
 * Read a page at a time (newest first) and refreshed while on screen (`useReviewThreads`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, CornerDownRight, History, Loader2, MessageSquare, MoreHorizontal, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useAuthStore } from '@/store/auth'
import type { ReviewComment, ReviewThread, ReviewThreadFilter } from '@/services/versioningApiService'
import { CommentComposer } from './CommentComposer'
import { useReviewCommentActions, useReviewThreads } from './useReviewComments'
import { splitMentions } from './mentions'

export interface DiscussionAccess {
  /** May write (a person may; a key may not). */
  canComment: boolean
  /** Why not, when not. */
  commentReason?: string | null
  /** May delete what others wrote. */
  canModerate: boolean
}

const nameOf = (id: string, names: Record<string, string>) => names[id] ?? id

function CommentBody({ comment, names }: { comment: ReviewComment; names: Record<string, string> }) {
  if (comment.deleted) return <p className="text-[12.5px] italic text-ink-muted">This comment was deleted.</p>
  return (
    <p className="text-[12.5px] leading-relaxed text-ink whitespace-pre-wrap break-words">
      {splitMentions(comment.body, comment.mentions, names).map((part, i) => part.mention ? (
        <span key={i} className="px-0.5 rounded font-semibold text-accent-lineage bg-accent-lineage/10">{part.text}</span>
      ) : <span key={i}>{part.text}</span>)}
    </p>
  )
}

/** One comment: who, when, what — and, for its author, Edit; for its author or a manager, Delete. */
function CommentItem({ wsId, prId, comment, names, access, reply }: {
  wsId: string; prId: string; comment: ReviewComment; names: Record<string, string>; access: DiscussionAccess; reply?: boolean
}) {
  const me = useAuthStore((s) => s.user?.id)
  const { edit, remove } = useReviewCommentActions(wsId, prId)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const mine = !!me && comment.author === me
  const mayDelete = !comment.deleted && (mine || access.canModerate)
  const mayEdit = !comment.deleted && mine && access.canComment
  const who = nameOf(comment.author, names)
  return (
    <div className={cn('group/comment flex items-start gap-2', reply && 'pl-1')}>
      <UserAvatar userId={comment.author} name={who} className={cn('shrink-0 text-[10px]', reply ? 'w-5 h-5' : 'w-6 h-6')} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 flex-wrap text-[11px] text-ink-muted">
          <span className="text-[12px] font-semibold text-ink">{who}</span>
          <span>{timeAgo(comment.createdAt)}</span>
          {comment.editedAt && !comment.deleted && <span>· edited</span>}
        </p>
        {editing ? (
          <CommentComposer
            wsId={wsId} prId={prId} autoFocus className="mt-1"
            initial={{ body: comment.body, mentions: Object.fromEntries(comment.mentions.map((id) => [id, nameOf(id, names)])) }}
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => { await edit.mutateAsync({ id: comment.id, body }); setEditing(false) }}
          />
        ) : <CommentBody comment={comment} names={names} />}
        {confirming && (
          <p className="mt-1 flex items-center gap-2 text-[11px] text-ink-secondary" role="alert">
            Delete this comment?
            <button type="button" disabled={remove.isPending} onClick={() => void remove.mutateAsync(comment.id).finally(() => setConfirming(false))}
              className="font-semibold text-rose-600 dark:text-rose-300 hover:underline disabled:opacity-50">
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="font-semibold hover:underline">Keep</button>
          </p>
        )}
      </div>
      {(mayEdit || mayDelete) && !editing && (
        <div className="relative shrink-0">
          <button type="button" aria-label="Comment actions" aria-expanded={menu} onClick={() => setMenu((v) => !v)}
            onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setMenu(false) }}
            className="w-6 h-6 rounded-md flex items-center justify-center text-ink-muted opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 top-full mt-1 z-20 w-32 rounded-lg border border-glass-border bg-canvas-elevated shadow-glass-lg py-1">
              {mayEdit && (
                <button type="button" role="menuitem" onClick={() => { setMenu(false); setEditing(true) }}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">Edit</button>
              )}
              {mayDelete && (
                <button type="button" role="menuitem" onClick={() => { setMenu(false); setConfirming(true) }}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-rose-600 dark:text-rose-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">Delete</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A thread: what it is on, its comments, Reply, Resolve / Reopen. */
export function ThreadView({ wsId, prId, thread, names, access, target, focused }: {
  wsId: string; prId: string; thread: ReviewThread; names: Record<string, string>; access: DiscussionAccess
  /** What it is on, when the list shows threads of more than one change. */
  target?: ReactNode
  /** The thread a link opened: drawn out and scrolled to. */
  focused?: boolean
}) {
  const { post, resolve } = useReviewCommentActions(wsId, prId)
  const resolved = !!thread.resolvedAt
  const [open, setOpen] = useState(!resolved || !!focused)
  const [replying, setReplying] = useState(false)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focused])
  const replies = thread.replies.length

  return (
    <article ref={ref} aria-label={`Thread by ${nameOf(thread.author, names)}`}
      className={cn('rounded-xl border bg-canvas-elevated/40 transition-shadow',
        focused ? 'border-accent-lineage/50 ring-2 ring-accent-lineage/20' : 'border-glass-border',
        resolved && !open && 'bg-transparent')}>
      {(target || thread.path || thread.outdated || resolved) && (
        <header className="flex items-center gap-1.5 flex-wrap px-3 pt-2 text-[10.5px]">
          {target}
          {thread.path && (
            <span className="px-1.5 py-px rounded-md bg-black/[0.05] dark:bg-white/[0.08] font-medium text-ink-secondary truncate max-w-[16rem]">
              on {thread.path.replace(/\//g, ' › ')}
            </span>
          )}
          {thread.outdated && (
            <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-md bg-amber-500/10 font-semibold text-amber-700 dark:text-amber-300">
              <History className="w-3 h-3" aria-hidden />Outdated · changed since
            </span>
          )}
          {resolved && (
            <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-md bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-3 h-3" aria-hidden />Resolved{thread.resolvedBy ? ` by ${nameOf(thread.resolvedBy, names)}` : ''}
            </span>
          )}
          {resolved && (
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
              className="ml-auto font-semibold text-ink-muted hover:text-ink">
              {open ? 'Hide' : `Show${replies ? ` · ${replies + 1} comments` : ''}`}
            </button>
          )}
        </header>
      )}
      {open && (
        <div className="px-3 py-2.5 space-y-2.5">
          <CommentItem wsId={wsId} prId={prId} comment={thread} names={names} access={access} />
          {replies > 0 && (
            <div className="ml-3 pl-3 border-l border-glass-border space-y-2.5">
              {thread.replies.map((r) => <CommentItem key={r.id} wsId={wsId} prId={prId} comment={r} names={names} access={access} reply />)}
            </div>
          )}
          {replying ? (
            <CommentComposer wsId={wsId} prId={prId} autoFocus placeholder="Reply…" submitLabel="Reply" className="ml-3"
              onCancel={() => setReplying(false)}
              onSubmit={(body, mentions) => post.mutateAsync({ body, mentions, threadId: thread.id })} />
          ) : (
            <div className="flex items-center gap-1 pt-0.5">
              {access.canComment && (
                <button type="button" onClick={() => setReplying(true)}
                  className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                  <CornerDownRight className="w-3.5 h-3.5" aria-hidden />Reply
                </button>
              )}
              {access.canComment && (
                <button type="button" disabled={resolve.isPending}
                  onClick={() => resolve.mutate({ threadId: thread.id, resolved: !resolved }, { onSuccess: () => setOpen(resolved) })}
                  className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] disabled:opacity-50">
                  {resolve.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                    : resolved ? <RotateCcw className="w-3.5 h-3.5" aria-hidden /> : <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />}
                  {resolved ? 'Reopen' : 'Resolve'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

export interface ReviewThreadsProps {
  wsId: string
  prId: string
  filter: ReviewThreadFilter
  access: DiscussionAccess
  /** Where a new thread goes (a change, a field of it, the review); none: no composer. */
  compose?: { entityId?: string; path?: string | null; placeholder: string } | null
  /** Clears what a new thread would be on (a field), back to the change. */
  onClearPath?: () => void
  /** What each thread is on, for a list of threads across changes. */
  targetOf?: (thread: ReviewThread) => ReactNode
  focusThreadId?: string | null
  /** A thread drawn elsewhere already (the one a link opened). */
  exclude?: string | null
  emptyText?: string
  className?: string
}

export function ReviewThreads({
  wsId, prId, filter, access, compose, onClearPath, targetOf, focusThreadId, exclude, emptyText, className,
}: ReviewThreadsProps) {
  const q = useReviewThreads(wsId, prId, filter)
  const { post } = useReviewCommentActions(wsId, prId)
  const pages = q.data?.pages ?? []
  const loaded = pages.flatMap((p) => p.threads)
  const threads = exclude ? loaded.filter((t) => t.id !== exclude) : loaded
  const names = Object.assign({}, ...pages.map((p) => p.userNames)) as Record<string, string>
  const total = pages[0]?.total ?? 0

  return (
    <div className={cn('space-y-2', className)}>
      {q.isLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-ink-muted py-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />Loading comments…</div>
      ) : q.isError ? (
        <p className="text-[12px] text-ink-muted py-1">Couldn’t load the comments. <button type="button" onClick={() => void q.refetch()} className="font-semibold text-accent-lineage hover:underline">Try again</button></p>
      ) : threads.length === 0 ? (
        emptyText ? <p className="flex items-center gap-1.5 text-[12px] text-ink-muted py-1"><MessageSquare className="w-3.5 h-3.5" aria-hidden />{emptyText}</p> : null
      ) : (
        threads.map((t) => (
          <ThreadView key={t.id} wsId={wsId} prId={prId} thread={t} names={names} access={access}
            target={targetOf?.(t)} focused={t.id === focusThreadId} />
        ))
      )}
      {q.hasNextPage && (
        <button type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}
          className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-accent-lineage hover:underline disabled:opacity-60">
          {q.isFetchingNextPage && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
          Show {Math.min(total - loaded.length, 20).toLocaleString()} more of {(total - loaded.length).toLocaleString()}
        </button>
      )}
      {compose && (access.canComment ? (
        <div className="space-y-1.5">
          {compose.path && (
            <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              Commenting on <span className="px-1.5 py-px rounded-md bg-accent-lineage/10 font-semibold text-accent-lineage">{compose.path.replace(/\//g, ' › ')}</span>
              {onClearPath && <button type="button" onClick={onClearPath} className="font-semibold hover:text-ink">the whole change instead</button>}
            </p>
          )}
          <CommentComposer
            key={compose.path ?? ''}
            wsId={wsId} prId={prId} placeholder={compose.placeholder} autoFocus={!!compose.path}
            onSubmit={async (body, mentions) => {
              await post.mutateAsync({ body, mentions, entityId: compose.entityId ?? null, path: compose.path ?? null })
              onClearPath?.()
            }}
          />
        </div>
      ) : access.commentReason ? (
        <p className="text-[11.5px] text-ink-muted">{access.commentReason}</p>
      ) : null)}
    </div>
  )
}
