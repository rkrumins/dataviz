/**
 * ReviewChangePane — the change open on the review page: what it is and where it sits, Viewed, its
 * decision (Accept / Reject, asking why), the changes before and after it, then what changed on it
 * — every field, with Comment on any one, and its threads. With none open, what the review is for
 * and where to start.
 */
import { forwardRef } from 'react'
import { CheckSquare, ChevronDown, ChevronUp, FileDiff, MousePointerClick, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'
import { HoverTip } from '@/components/ui/HoverTip'
import type { ChangeListOrigin, ChangeListRow, ReviewChangeRow } from '@/services/versioningApiService'
import { RowDetail, rowLabel } from '@/features/versioning/components/ChangeList'
import { ChangeSummary } from '@/features/versioning/components/ChangeSummary'
import { NodeDiffBadge } from '@/features/versioning/components/NodeDiffBadge'
import { DecisionBanner, RejectReason, RowDecision, type useDecisionFlow } from '../decisions/DecisionControls'
import type { useViewedChanges } from '../viewed/useViewedChanges'
import type { ReviewActions } from '../hooks/useReviewActions'

export interface ReviewChangePaneProps {
  actions: ReviewActions
  wsId: string
  prId: string
  source: { graphId: string; origin: ChangeListOrigin } | null
  /** The change open, as listed — or, opened by a link before its page of the list was read, as
   *  little as its entity says (`listed` false: no Viewed or decision for it yet). */
  row: ChangeListRow | null
  listed: boolean
  onStep: (dir: 1 | -1) => void
  viewed: ReturnType<typeof useViewedChanges>
  flow: ReturnType<typeof useDecisionFlow>
  /** Rejecting asks why, here. */
  asking: boolean
  onAsk: (asking: boolean) => void
  /** Decisions are made here, change by change (a draft's review, open). */
  deciding: boolean
  focusThreadId?: string | null
}

export const ReviewChangePane = forwardRef<HTMLDivElement, ReviewChangePaneProps>(function ReviewChangePane({
  actions, wsId, prId, source, row, listed, onStep, viewed, flow, asking, onAsk, deciding, focusThreadId,
}, ref) {
  const { pr, discussion, viewerCan } = actions
  if (!pr) return null

  if (!row || !source) {
    const description = pr.description?.trim()
    return (
      <div ref={ref} className="p-4 sm:p-6 space-y-5">
        {description && (
          <section>
            <h2 className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
              <FileDiff className="w-3.5 h-3.5" aria-hidden /> Description
            </h2>
            <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{description}</p>
          </section>
        )}
        <EmptyState icon={MousePointerClick} title="Pick a change to review it"
          description={source
            ? 'What it changed, field by field, opens here — with its threads, and where to comment. Or press j to start with the first.'
            : 'Open any change in the list to see what it changed.'} />
      </div>
    )
  }

  const label = rowLabel(row)
  const decision = (row as ReviewChangeRow).decision ?? null
  const rejected = decision && !decision.stale && decision.verdict === 'rejected' ? decision : null
  const isViewed = viewed.isViewed(row)
  const where = row.path?.length ? row.path.join(' › ') : row.qualifiedName && row.qualifiedName !== label ? row.qualifiedName : row.type
  return (
    <div ref={ref} className="p-4 sm:p-6 space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {where && <p className="text-[11px] text-ink-muted truncate">{where}</p>}
          <div className="flex items-center gap-2 min-w-0 mt-0.5">
            <h2 className="text-base font-semibold text-ink truncate">{label}</h2>
            <NodeDiffBadge status={row.status} withLabel className="shrink-0" />
          </div>
          {row.fields && <ChangeSummary summary={row.fields} status={row.status} kind={row.kind} className="mt-1" />}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {listed && viewed.enabled && (
            <HoverTip label={isViewed ? 'Viewed' : viewed.changedSince(row) ? 'Changed since you viewed it' : 'Mark it viewed'}
              detail="Only you see this" shortcut="v" className="inline-flex">
              <button type="button" onClick={() => viewed.toggle(row)} aria-pressed={isViewed}
                aria-label={isViewed ? `${label} viewed` : `Mark ${label} viewed`}
                className={cn('inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold transition-colors',
                  isViewed ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10' : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]')}>
                {isViewed ? <CheckSquare className="w-3.5 h-3.5" aria-hidden /> : <Square className="w-3.5 h-3.5" aria-hidden />}
                Viewed
              </button>
            </HoverTip>
          )}
          {listed && deciding && (
            <RowDecision decision={decision} canDecide={!!viewerCan?.decide} busy={flow.busy} label={label}
              names={pr.userNames ?? undefined} asking={asking} onAsk={onAsk}
              onDecide={(v, why) => { onAsk(false); void flow.run(v, { entityIds: [row.entityId] }, why) }} />
          )}
          <HoverTip label="Previous change" shortcut="k" className="inline-flex">
            <button type="button" onClick={() => onStep(-1)} aria-label="Previous change"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <ChevronUp className="w-4 h-4" aria-hidden />
            </button>
          </HoverTip>
          <HoverTip label="Next change" shortcut="j" className="inline-flex">
            <button type="button" onClick={() => onStep(1)} aria-label="Next change"
              className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <ChevronDown className="w-4 h-4" aria-hidden />
            </button>
          </HoverTip>
        </div>
      </div>
      {asking && deciding && (
        <RejectReason label={label} onCancel={() => onAsk(false)}
          onReject={(why) => { onAsk(false); void flow.run('rejected', { entityIds: [row.entityId] }, why) }} />
      )}
      {rejected?.reason && (
        <p className="text-[12px] text-rose-700/90 dark:text-rose-300/90">
          “{rejected.reason}”{pr.userNames?.[rejected.actor] ? <span className="text-ink-muted"> — {pr.userNames[rejected.actor]}</span> : null}
        </p>
      )}
      {deciding && <DecisionBanner flow={flow} />}
      <RowDetail key={row.entityId} wsId={wsId} graphId={source.graphId} origin={source.origin} row={row}
        review={{ prId, ...discussion }} focusThreadId={focusThreadId} />
    </div>
  )
})
