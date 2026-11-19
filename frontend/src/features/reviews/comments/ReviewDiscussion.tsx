/**
 * ReviewDiscussion — a review's conversation in its drawer: the thread a notification linked to
 * first, then every thread (open ones by default) — on the review as a whole and on its changes,
 * each saying which change it is on with what changed a click away — and where to comment on
 * the review itself.
 */
import { useState } from 'react'
import { ChevronRight, FileDiff, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Segmented } from '@/components/ui/Segmented'
import type { ChangeListOrigin, ReviewThread } from '@/services/versioningApiService'
import { useChangeEntry } from '@/features/versioning/hooks/useVersioning'
import { EntityDiff } from '@/features/versioning/components/EntityDiff'
import { ReviewThreads, type DiscussionAccess } from './ReviewThreads'
import { useReviewCommentCounts } from './useReviewComments'

/** Which change a thread is on, by name, with what changed on it a click away. */
function ThreadTarget({ wsId, graphId, origin, thread }: {
  wsId: string; graphId: string; origin: ChangeListOrigin | null; thread: ReviewThread
}) {
  const [open, setOpen] = useState(false)
  const q = useChangeEntry(wsId, graphId, origin, thread.entityId!)
  const d = q.data
  const side = (d?.after ?? d?.before ?? {}) as Record<string, unknown>
  const name = (side.displayName as string | undefined) || (d?.kind === 'edge' ? 'A relationship' : thread.entityId!)
  return (
    <>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!origin}
        className="inline-flex items-center gap-1 min-w-0 max-w-[18rem] px-1.5 py-px rounded-md bg-accent-lineage/10 font-semibold text-accent-lineage hover:bg-accent-lineage/15 disabled:pointer-events-none">
        <FileDiff className="w-3 h-3 shrink-0" aria-hidden />
        <span className="truncate">{q.isLoading ? '…' : name}</span>
        {origin && <ChevronRight className={cn('w-3 h-3 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />}
      </button>
      {open && d && origin && (
        <div className="basis-full pt-1.5">
          <EntityDiff change={{
            entityId: d.entityId, kind: d.kind, status: d.status === 'unchanged' ? 'modified' : d.status, label: name,
            before: d.before ?? undefined, after: d.after ?? undefined,
            origin: 'branchId' in origin ? { source: 'branch', branchId: origin.branchId }
              : { source: 'compare', fromSeq: origin.fromSeq, toSeq: origin.toSeq },
          }} />
        </div>
      )}
    </>
  )
}

export function ReviewDiscussion({ wsId, prId, graphId, origin, access, focusThreadId }: {
  wsId: string
  prId: string
  graphId: string
  /** Where the review's changes are read (a draft's review); none for a fork's. */
  origin: ChangeListOrigin | null
  access: DiscussionAccess
  focusThreadId?: string | null
}) {
  const counts = useReviewCommentCounts(wsId, prId).data
  const all = counts ? Object.values(counts.entities).reduce((n, c) => n + c.total, 0) + counts.general.total : 0
  const [state, setState] = useState<'open' | 'all'>('open')
  const targetOf = (t: ReviewThread) => (t.entityId
    ? <ThreadTarget wsId={wsId} graphId={graphId} origin={origin} thread={t} />
    : <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-md bg-black/[0.05] dark:bg-white/[0.08] font-medium text-ink-secondary"><MessageSquare className="w-3 h-3" aria-hidden />On the review</span>)

  return (
    <div className="space-y-3">
      {focusThreadId && (
        <ReviewThreads wsId={wsId} prId={prId} filter={{ threadId: focusThreadId }} access={access}
          targetOf={targetOf} focusThreadId={focusThreadId} />
      )}
      {all > 0 && (
        <Segmented label="Which threads" value={state} onChange={setState} options={[
          { value: 'open', label: 'Open', count: counts?.open ?? 0 },
          { value: 'all', label: 'All', count: all },
        ]} />
      )}
      <ReviewThreads
        wsId={wsId} prId={prId} filter={{ state }} access={access} targetOf={targetOf} exclude={focusThreadId}
        emptyText={all > 0 && state === 'open' ? 'Every thread is resolved.' : 'No comments yet. Start the conversation below, or on any change above.'}
        compose={{ placeholder: 'Comment on this review…' }}
      />
    </div>
  )
}
