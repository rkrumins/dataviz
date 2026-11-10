/**
 * RevisionBanner — "you are looking at the past", over the canvas, while a past revision of
 * Published is open (`useOpenRevision`). Like checking out a commit: the canvas is the graph as it
 * was then, read-only, and this band says when that was, which revision it is, who made it, and how
 * much has changed since — with the three ways on from here: compare it with now, restore the graph
 * to it (people who can publish), or go back to Published (Esc).
 *
 * Before anything is drawn the view asks what opening the revision takes (`useRevision`): the band
 * says "Opening…" meanwhile, and a long rewind says so ("Rewinding 12,400 changes…"). One too far
 * back to draw never draws (`useRevisionGuard`): it hands over to its comparison with now.
 *
 * NO AnimatePresence/exit here, deliberately, as PublishReceiptBanner: a portaled exit transition
 * strands an invisible click-blocker over the canvas.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeftToLine, GitCompareArrows, History, Info, Lock, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { Kbd } from '@/components/ui/Kbd'
import { Skeleton } from '@/components/ui/Skeleton'
import { DateTime } from '@/components/ui/DateTime'
import { useBranchStore, useOpenRevision } from '@/store/branchStore'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { useCanvasStore } from '@/store/canvas'
import { useReviewStore } from '@/store/reviewStore'
import type { ChangeListStatus } from '@/services/versioningApiService'
import { useChangeSummary, useRevision } from '../hooks/useVersioning'
import { ownerName } from '../model/branchVocab'
import { RestoreDialog } from './RollbackDialogs'
import { AT_REVISION_READS, movedOn } from '../model/revisionCopy'
import { STATUS_META } from './NodeDiffBadge'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat()

/** Whether a key press belongs to something else on the page: a field being typed in, or a dialog. */
function escapeIsTaken(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true
  const el = e.target as HTMLElement | null
  if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return true
  return !!document.querySelector('[aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"]')
}

export function RevisionBanner({
  workspaceId,
  graphId,
  canRestore = false,
  onCompare,
}: {
  workspaceId: string
  graphId: string
  /** People who can publish may restore the graph to the revision. */
  canRestore?: boolean
  /** Compare two revisions in the drawer; `toSeq` null is Published as it is now. */
  onCompare: (fromSeq: number, toSeq: number | null) => void
}) {
  const revision = useOpenRevision()
  const closeRevision = useBranchStore((s) => s.closeRevision)
  const repinRevision = useBranchStore((s) => s.repinRevision)
  const seq = revision?.seq ?? null
  // The canvas reads the revision once it is known to open; until then it is being opened.
  const readAt = useViewExecutionContext()?.asOfSeq ?? null
  const opening = seq != null && readAt !== seq
  const plan = useRevision(workspaceId, graphId, seq)
  const head = plan.data?.headSeq ?? null
  const openable = plan.data?.openable ?? false
  // "Since then" counts up to the head the revision was opened at, not the head now: a publish while
  // it is open would otherwise rebuild it each time. The band says how far Published has moved on
  // instead, and Update counts up to the head now.
  const pinned = revision?.headAtOpen ?? null
  const since = useMemo(
    () => (seq != null && openable && pinned != null && seq < pinned ? { fromSeq: seq, toSeq: pinned } : null),
    [seq, openable, pinned],
  )
  const newer = head != null && pinned != null ? Math.max(0, head - pinned) : 0
  const sinceQ = useChangeSummary(workspaceId, graphId, since)
  // On the Context View, each count reviews what changed since, by its operation.
  const reviewable = useReviewStore((s) => s.available)
  const startReview = useReviewStore((s) => s.startReview)
  const phase = useCanvasStore((s) => s.hydrationPhase)
  const [restoring, setRestoring] = useState(false)

  // Esc goes back to Published, unless something else on the page has it.
  useEffect(() => {
    if (seq == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || escapeIsTaken(e)) return
      closeRevision()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [seq, closeRevision])

  if (seq == null) return null

  const commit = plan.data?.commit
  const createdAt = (commit?.created_at as string | undefined) ?? revision?.createdAt ?? null
  const message = (commit?.message as string | undefined) ?? revision?.message ?? null
  const actor = (commit?.actor as string | undefined) ?? revision?.actor ?? null
  const changed = plan.data?.changedSince ?? 0
  const rewinding = !opening && openable && changed > 0 && phase !== 'complete' && phase !== 'idle'
  const counts = sinceQ.data?.counts
  const revisionsSince = sinceQ.data?.window?.commitCount ?? (pinned != null ? Math.max(0, pinned - seq) : null)

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'relative flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-b border-indigo-500/20 shrink-0 animate-fade-in',
        'bg-gradient-to-r from-indigo-500/[0.10] via-violet-500/[0.06] to-transparent',
      )}
    >
      <div className="w-8 h-8 rounded-xl bg-indigo-500/15 border border-indigo-500/25 flex items-center justify-center shrink-0 shadow-sm shadow-indigo-500/10">
        <History className="w-4 h-4 text-indigo-600 dark:text-indigo-300" />
      </div>

      <div className="min-w-0 flex-1 basis-[22rem]">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink tracking-tight min-w-0">
          <span className="truncate">
            {opening ? 'Opening Published as it was' : 'Viewing Published as it was'}
            {createdAt && (
              <>
                <span className="text-ink-muted/50 font-normal"> · </span>
                <DateTime at={createdAt} variant="calendar" className="font-semibold" />
              </>
            )}
          </span>
          <HoverTip
            className="inline-flex shrink-0"
            label="Read-only"
            detail="A past revision can't be edited. Go back to Published to make changes."
          >
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
              <Lock className="w-2.5 h-2.5" /> Read-only
            </span>
          </HoverTip>
        </p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted min-w-0 flex-wrap">
          <span className="font-semibold text-ink/80 tabular-nums">Revision #{seq}</span>
          {message && (
            <>
              <span className="text-ink-muted/50">·</span>
              <span className="truncate max-w-[16rem]">{message}</span>
            </>
          )}
          {actor && (
            <>
              <span className="text-ink-muted/50">·</span>
              <span>{ownerName(actor, plan.data?.userNames)}</span>
            </>
          )}
          <span className="text-ink-muted/50">·</span>
          {plan.isLoading || opening ? (
            <Skeleton className="h-3 w-40" />
          ) : rewinding ? (
            <span className="text-indigo-700 dark:text-indigo-300 font-medium">
              Rewinding {whole.format(changed)} {changed === 1 ? 'change' : 'changes'}…
            </span>
          ) : since ? (
            <SinceThen revisions={revisionsSince} counts={counts} loading={sinceQ.isLoading}
              onReview={reviewable && seq != null
                ? (operation) => startReview({ scope: { kind: 'since', seq }, operation })
                : undefined} />
          ) : (
            <span>Nothing has changed since.</span>
          )}
          {!plan.isLoading && !opening && !rewinding && newer > 0 && head != null && (
            <>
              <span className="text-ink-muted/50">·</span>
              <span>{movedOn(newer)}</span>
              <span className="text-ink-muted/50">·</span>
              <button onClick={() => repinRevision(head)}
                className="font-semibold text-indigo-700 dark:text-indigo-300 hover:underline">Update</button>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        <HoverTip
          className="inline-flex"
          label="Drawn with today's layout"
          detail={`Layers and the ontology are today's. ${AT_REVISION_READS}`}
        >
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-ink-muted hover:bg-canvas-overlay cursor-default">
            <Info className="w-3.5 h-3.5" /> Today's layout
          </span>
        </HoverTip>
        <button
          onClick={() => onCompare(seq, null)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors"
        >
          <GitCompareArrows className="w-3.5 h-3.5" /> Compare with now
        </button>
        {canRestore && commit && (
          <HoverTip className="inline-flex" label="Restore graph to here…" detail="Rolls back everything published after this revision, as a new revision.">
            <button
              onClick={() => setRestoring(true)}
              aria-label="Restore graph to here"
              className="p-1.5 rounded-lg text-ink-muted hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </HoverTip>
        )}
        <button
          onClick={closeRevision}
          className="inline-flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm shadow-indigo-500/20 transition-all active:scale-[0.98]"
        >
          <ArrowLeftToLine className="w-3.5 h-3.5" /> Back to Published
          <Kbd shortcut="esc" tone="onAccent" />
        </button>
      </div>

      {(opening || rewinding) && (
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-indigo-500 to-transparent animate-indeterminate motion-reduce:animate-none" />
        </div>
      )}

      {canRestore && commit && (
        <RestoreDialog
          open={restoring}
          commit={commit}
          wsId={workspaceId}
          graphId={graphId}
          userNames={plan.data?.userNames}
          onClose={() => setRestoring(false)}
        />
      )}
    </div>
  )
}

/** "Since then: 32 revisions · +1.2k ~340 −12" — how far the graph has moved on. */
function SinceThen({ revisions, counts, loading, onReview }: {
  revisions: number | null
  counts?: { added: number; modified: number; removed: number }
  loading: boolean
  /** Review what changed since, by operation; without it the counts only say. */
  onReview?: (operation: ChangeListStatus) => void
}) {
  const count = (op: ChangeListStatus, sign: string, className: string) => {
    const n = counts?.[op] ?? 0
    return onReview ? (
      <button type="button" onClick={() => onReview(op)} className={cn(className, 'hover:underline')}
        aria-label={`Review ${whole.format(n)} ${STATUS_META[op].label.toLowerCase()} since this revision`}>
        {sign}{compact.format(n)}
      </button>
    ) : (
      <span className={className}>{sign}{compact.format(n)}</span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>Since then:</span>
      {revisions != null && (
        <span className="tabular-nums">
          {whole.format(revisions)} {revisions === 1 ? 'revision' : 'revisions'}
        </span>
      )}
      {loading ? (
        <Skeleton className="h-3 w-20" />
      ) : counts ? (
        <HoverTip
          className="inline-flex"
          label="Changed since this revision"
          detail={`${whole.format(counts.added)} added · ${whole.format(counts.modified)} modified · ${whole.format(counts.removed)} removed`}
        >
          <span className="inline-flex items-center gap-1 tabular-nums font-semibold">
            <span className="text-ink-muted/50 font-normal">·</span>
            {count('added', '+', 'text-emerald-600 dark:text-emerald-400')}
            {count('modified', '~', 'text-amber-600 dark:text-amber-400')}
            {count('removed', '−', 'text-rose-600 dark:text-rose-400')}
          </span>
        </HoverTip>
      ) : null}
    </span>
  )
}
