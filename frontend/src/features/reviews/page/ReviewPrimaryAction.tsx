/**
 * ReviewPrimaryAction — the one thing to do next on a review, where its header offers it: Finish
 * your review, Merge (or Merge N accepted), Pull the latest, Resolve conflicts, Update from parent.
 * Off, it says why. Beside it, for a reviewer: Approve all [& merge] where it is offered, and Finish
 * your review where that is not the next thing (whoever may send it back).
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDownToLine, CheckCheck, ClipboardCheck, GitMerge, Loader2, Trash2, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/platform'
import { HoverTip } from '@/components/ui/HoverTip'
import { UpdateFromParentButton } from '@/features/versioning/components/UpdateFromParentButton'
import type { ReviewActions } from '../hooks/useReviewActions'
import type { PrimaryAction, ReviewActionKind } from './readiness'
import { FinishReviewPanel } from './FinishReviewPanel'

const LOOK: Record<ReviewActionKind, { Icon: LucideIcon; cls: string; tip: string }> = {
  finish: { Icon: ClipboardCheck, cls: 'bg-accent-lineage hover:opacity-90', tip: 'Comment, approve or ask for changes, with a summary' },
  approve_all: { Icon: CheckCheck, cls: 'bg-emerald-600 hover:bg-emerald-700', tip: 'Accept every change still to decide and approve, in one go' },
  approve_all_merge: { Icon: CheckCheck, cls: 'bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-700 hover:to-indigo-700', tip: 'Accept every change still to decide, approve, and merge into main, in one go' },
  merge: { Icon: GitMerge, cls: 'bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700', tip: 'Apply these changes to main' },
  merge_accepted: { Icon: GitMerge, cls: 'bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700', tip: 'Apply the accepted changes to main; the rest stay on the draft' },
  resolve_conflicts: { Icon: GitMerge, cls: 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700', tip: 'Merge, choosing what each conflicting field keeps' },
  pull: { Icon: ArrowDownToLine, cls: 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700', tip: 'Take in what changed on main, resolving any conflicts, so it can merge' },
  update_from_parent: { Icon: ArrowDownToLine, cls: '', tip: '' },
  discard_rejected: { Icon: Trash2, cls: 'bg-rose-500 hover:bg-rose-600', tip: 'Take the review’s answer: what was rejected leaves the draft' },
  accept_missing: { Icon: CheckCheck, cls: 'bg-emerald-600 hover:bg-emerald-700', tip: 'Accept the changes the accepted ones need, so they can merge' },
}

const SECONDARY = 'inline-flex items-center gap-1.5 px-3 h-9 rounded-xl text-sm font-semibold border disabled:opacity-60'

/** Finish your review, here: its panel, open or not, and what it tallies. */
export interface FinishPanelState { open: boolean; onOpenChange: (open: boolean) => void; viewed: number; total: number; openThreads: number }
/** Finish your review, elsewhere: a link to the page that opens it (the drawer's). */
export interface FinishLink { to: string; onGo?: () => void }

export function ReviewPrimaryAction({ wsId, actions, primary, approveAll, onAct, finish }: {
  wsId: string
  actions: ReviewActions
  primary: PrimaryAction | null
  /** Approve all [& merge], offered beside it. */
  approveAll?: PrimaryAction | null
  onAct: (kind: ReviewActionKind) => void
  finish: FinishPanelState | FinishLink
}) {
  const { pr } = actions
  if (!pr || (!primary && !actions.canFinish)) return null
  const pending = actions.pending.merge || actions.pending.pull || actions.pending.discard || actions.pending.acceptMissing
  const here = !('to' in finish)
  /** Finish your review, as a control of the given look: opening the panel here, or the page. */
  const finishControl = (cls: string, content: ReactNode) => ('to' in finish ? (
    <Link to={finish.to} onClick={finish.onGo} className={cls}>{content}</Link>
  ) : (
    <FinishReviewPanel actions={actions} open={finish.open} onOpenChange={finish.onOpenChange}
      viewed={finish.viewed} total={finish.total} openThreads={finish.openThreads}>
      <button type="button" disabled={actions.busy} className={cls}>{content}</button>
    </FinishReviewPanel>
  ))
  return (
    <div className="flex items-center gap-2 shrink-0">
      {approveAll && (
        <HoverTip label={LOOK[approveAll.kind].tip} className="inline-flex">
          <button type="button" disabled={actions.busy || actions.changesFetching} onClick={() => onAct(approveAll.kind)}
            className={cn(SECONDARY, 'text-emerald-700 dark:text-emerald-300 border-emerald-500/30 bg-emerald-500/[0.06] hover:bg-emerald-500/10')}>
            {actions.pending.approveAll ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <CheckCheck className="w-4 h-4" aria-hidden />}
            {approveAll.label}
          </button>
        </HoverTip>
      )}
      {actions.canFinish && primary?.kind !== 'finish' && finishControl(
        cn(SECONDARY, 'text-ink border-glass-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'),
        <><ClipboardCheck className="w-4 h-4" aria-hidden /> Finish your review</>,
      )}
      {primary && (primary.kind === 'update_from_parent' ? (
        <UpdateFromParentButton wsId={wsId} forkGraphId={pr.graphId} onUpdated={actions.clearForkBehind} />
      ) : (() => {
        const look = LOOK[primary.kind]
        const off = !!primary.disabled || actions.busy
        const cls = cn('inline-flex items-center gap-1.5 px-3.5 h-9 rounded-xl text-sm font-semibold text-white shadow-sm disabled:opacity-60', look.cls)
        const content = (
          <>
            {(primary.kind === 'finish' ? actions.pending.submit : pending)
              ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <look.Icon className="w-4 h-4" aria-hidden />}
            {primary.label}
          </>
        )
        return (
          <HoverTip label={primary.why ?? look.tip} shortcut={off || !here ? undefined : formatShortcut('mod+enter')} className="inline-flex">
            {primary.kind === 'finish' ? finishControl(cls, content) : (
              <button type="button" disabled={off} onClick={() => onAct(primary.kind)} className={cls}>{content}</button>
            )}
          </HoverTip>
        )
      })())}
    </div>
  )
}
