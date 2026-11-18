/**
 * ReviewPrimaryAction — the one thing to do next on a review, where its header offers it: Approve,
 * Merge (or Merge N accepted), Pull the latest, Resolve conflicts, Update from parent — and, for
 * whoever decides a draft's review, Send back beside it, asking why. Off, it says why.
 */
import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  ArrowDownToLine, CheckCircle2, CheckCheck, CornerUpLeft, GitMerge, Loader2, Trash2, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/platform'
import { HoverTip } from '@/components/ui/HoverTip'
import { UpdateFromParentButton } from '@/features/versioning/components/UpdateFromParentButton'
import { ownerName } from '@/features/versioning/model/branchVocab'
import type { ReviewActions } from '../hooks/useReviewActions'
import type { PrimaryAction, ReviewActionKind } from './readiness'

const LOOK: Record<ReviewActionKind, { Icon: LucideIcon; cls: string; tip: string }> = {
  approve: { Icon: CheckCircle2, cls: 'bg-emerald-600 hover:bg-emerald-700', tip: 'Sign off on these changes so they can be merged' },
  merge: { Icon: GitMerge, cls: 'bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700', tip: 'Apply these changes to main' },
  merge_accepted: { Icon: GitMerge, cls: 'bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700', tip: 'Apply the accepted changes to main; the rest stay on the draft' },
  resolve_conflicts: { Icon: GitMerge, cls: 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700', tip: 'Merge, choosing what each conflicting field keeps' },
  pull: { Icon: ArrowDownToLine, cls: 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700', tip: 'Take in what changed on main, resolving any conflicts, so it can merge' },
  update_from_parent: { Icon: ArrowDownToLine, cls: '', tip: '' },
  discard_rejected: { Icon: Trash2, cls: 'bg-rose-500 hover:bg-rose-600', tip: 'Take the review’s answer: what was rejected leaves the draft' },
  accept_missing: { Icon: CheckCheck, cls: 'bg-emerald-600 hover:bg-emerald-700', tip: 'Accept the changes the accepted ones need, so they can merge' },
}

export function ReviewPrimaryAction({ wsId, actions, primary, onAct }: {
  wsId: string
  actions: ReviewActions
  primary: PrimaryAction | null
  onAct: (kind: ReviewActionKind) => void
}) {
  const { pr } = actions
  if (!pr || (!primary && !actions.canSendBack)) return null
  const pending = actions.pending.merge || actions.pending.pull || actions.pending.discard || actions.pending.acceptMissing
  return (
    <div className="flex items-center gap-2 shrink-0">
      {actions.canSendBack && <SendBack actions={actions} />}
      {primary && (primary.kind === 'update_from_parent' ? (
        <UpdateFromParentButton wsId={wsId} forkGraphId={pr.graphId} onUpdated={actions.clearForkBehind} />
      ) : (() => {
        const look = LOOK[primary.kind]
        const off = !!primary.disabled || actions.busy || (primary.kind === 'approve' && actions.changesFetching)
        return (
          <HoverTip label={primary.why ?? look.tip} shortcut={off ? undefined : formatShortcut('mod+enter')} className="inline-flex">
            <button type="button" disabled={off} onClick={() => onAct(primary.kind)}
              className={cn('inline-flex items-center gap-1.5 px-3.5 h-9 rounded-xl text-sm font-semibold text-white shadow-sm disabled:opacity-60', look.cls)}>
              {pending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <look.Icon className="w-4 h-4" aria-hidden />}
              {primary.label}
            </button>
          </HoverTip>
        )
      })())}
    </div>
  )
}

/** Send back: why, in the author's words to read — they are told, with a link here. */
function SendBack({ actions }: { actions: ReviewActions }) {
  const [open, setOpen] = useState(false)
  const [why, setWhy] = useState('')
  const { pr, rejected } = actions
  if (!pr) return null
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" disabled={actions.busy}
          className="inline-flex items-center gap-1.5 px-3 h-9 rounded-xl text-sm font-semibold text-rose-600 dark:text-rose-300 border border-rose-500/30 bg-rose-500/[0.05] hover:bg-rose-500/10 disabled:opacity-60">
          <CornerUpLeft className="w-4 h-4" aria-hidden /> Send back
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} aria-label="Send this back for changes"
          className="z-50 w-[22rem] rounded-xl border border-glass-border bg-canvas-elevated shadow-lg p-4 animate-in fade-in zoom-in-95">
          <p className="text-[13px] font-semibold text-ink">Send this back for changes?</p>
          <p className="text-[12px] text-ink-muted mt-1 leading-relaxed">
            {ownerName(pr.actor, pr.userNames)} is told, with what you say here. It can’t merge until the draft changes
            {rejected > 0 ? <> — they see the <span className="font-medium text-rose-500">{rejected.toLocaleString()} rejected</span> change{rejected === 1 ? '' : 's'}, each with your reason, and can discard them in one step</> : ''}.
          </p>
          <label className="block mt-2.5">
            <span className="sr-only">What should change</span>
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={3} maxLength={2000} autoFocus
              placeholder="What should change, and why?"
              className="w-full rounded-xl border border-glass-border bg-canvas px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-rose-500/30" />
          </label>
          <div className="flex items-center justify-end gap-2 mt-2.5">
            <button type="button" onClick={() => setOpen(false)}
              className="px-3 h-8 rounded-lg text-[12.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              Keep reviewing
            </button>
            <button type="button" disabled={actions.busy}
              onClick={() => actions.sendBack(why, () => { setOpen(false); setWhy('') })}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[12.5px] font-semibold text-white bg-rose-500 hover:bg-rose-600 disabled:opacity-60">
              {actions.pending.sendBack ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <CornerUpLeft className="w-3.5 h-3.5" aria-hidden />}
              Send it back
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
