/**
 * ReviewNavigator — a review's changes, to go through one at a time: how far the reader has got
 * (viewed, decided, open threads), then the change list — picking a change opens it beside the
 * list. A fork's review small enough to lay out as a tree is read as one, each change opening in
 * place.
 */
import type { ChangeListOrigin, ChangeListRow } from '@/services/versioningApiService'
import { getMergeRequestDiffChildren } from '@/services/versioningApiService'
import { ChangeList } from '@/features/versioning/components/ChangeList'
import { ChangeTreePanel } from '@/features/versioning/components/ChangeTreePanel'
import type { ReviewActions } from '../hooks/useReviewActions'

export function ReviewNavigator({ wsId, prId, actions, source, selected, onPick, viewed, total, openThreads }: {
  wsId: string
  prId: string
  actions: ReviewActions
  /** Where its changes are listed; none: a fork's review, laid out as a tree. */
  source: { graphId: string; origin: ChangeListOrigin } | null
  selected: string | null
  onPick: (row: ChangeListRow) => void
  viewed: number
  total: number
  openThreads: number
}) {
  const { pr, draftReview, draftSummaryQ, forkSummaryQ, discussion, deciding, decisions, viewerCan } = actions
  if (!pr) return null
  const gone = [draftSummaryQ.error, forkSummaryQ.error].some((e) => (e as { status?: number } | null)?.status === 410)

  return (
    <div className="flex flex-col gap-3 min-h-0">
      <p className="text-[11.5px] text-ink-muted tabular-nums">
        <span className="font-semibold text-ink">{viewed.toLocaleString()}</span> of {total.toLocaleString()} viewed
        {deciding && decisions && <> · <span className="font-semibold text-ink">{(decisions.accepted + decisions.rejected).toLocaleString()}</span> decided</>}
        {' · '}<span className={openThreads ? 'font-semibold text-accent-lineage' : undefined}>{openThreads.toLocaleString()}</span> open thread{openThreads === 1 ? '' : 's'}
      </p>
      {gone ? (
        <p className="text-xs text-ink-muted py-3">
          This review was closed, and its draft’s changes were removed after the retention period, so what
          it proposed can no longer be shown.
        </p>
      ) : source ? (
        <ChangeList wsId={wsId} graphId={source.graphId} origin={source.origin}
          summary={draftReview ? draftSummaryQ.data : undefined} emptyHint="No changes in this review." maxHeight="70vh"
          review={{
            prId, ...discussion,
            decisions: deciding ? {
              canDecide: !!viewerCan?.decide, headCommitId: pr.headCommitId, summary: decisions, names: pr.userNames ?? undefined,
            } : undefined,
          }}
          pick={{ selected, onPick }} />
      ) : (
        <ChangeTreePanel
          summary={forkSummaryQ.data}
          isLoading={forkSummaryQ.isLoading}
          error={forkSummaryQ.error}
          onRetry={() => void forkSummaryQ.refetch()}
          fetchChildren={(key, offset) => getMergeRequestDiffChildren(wsId, prId, key, { offset, limit: 50 })}
          origin={{ source: 'pr', prId }}
          emptyHint="No changes in this review."
        />
      )}
    </div>
  )
}
