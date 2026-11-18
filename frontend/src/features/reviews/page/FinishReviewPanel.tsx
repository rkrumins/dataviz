/**
 * FinishReviewPanel — your review, given once. Comments and decisions are live as you make them;
 * this records the outcome: your tally (what you viewed, what is accepted and rejected, the open
 * threads), a verdict — Comment, Approve or Request changes, each off with why where the review says
 * so — and a summary, which a comment needs, and asking for changes with nothing rejected. ⌘↵ sends
 * it. The draft moved on while you reviewed: nothing is recorded, and it says so.
 */
import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { AlertTriangle, Loader2, Send } from 'lucide-react'
import { hasPrimaryModifier } from '@/lib/platform'
import { Kbd } from '@/components/ui/Kbd'
import { Segmented } from '@/components/ui/Segmented'
import type { ReviewVerdict } from '@/services/versioningApiService'
import type { ReviewActions } from '../hooks/useReviewActions'

/** Why a verdict is off, by the server's reason code (`viewerCan`). */
const VERDICT_REFUSALS: Record<string, string> = {
  merged: 'It is merged.',
  closed: 'It is closed.',
  person_required: 'A key can’t review — sign in as a person.',
  manage_required: 'It needs edit access to this data source.',
  self_review: 'This data source has someone other than whoever opened a review approve it.',
  fork_review: 'A fork’s review is sent back by closing it.',
}

const LABEL: Record<ReviewVerdict, string> = { comment: 'Comment', approve: 'Approve', request_changes: 'Request changes' }

const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`

export function FinishReviewPanel({ actions, open, onOpenChange, viewed, total, openThreads, children }: {
  actions: ReviewActions
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Changes the reader ticked viewed, of how many; the review's open threads. */
  viewed: number
  total: number
  openThreads: number
  /** What opens it: one button. */
  children: ReactNode
}) {
  const { viewerCan, decisions, deciding, rejected } = actions
  const verdicts: Array<{ value: ReviewVerdict; allowed: boolean; reason: string | null | undefined }> = [
    { value: 'comment', allowed: viewerCan?.comment ?? true, reason: viewerCan?.commentReason },
    { value: 'approve', allowed: viewerCan?.approve ?? actions.showApprove, reason: viewerCan?.approveReason },
    { value: 'request_changes', allowed: viewerCan?.requestChanges ?? viewerCan?.decide ?? false,
      reason: viewerCan?.requestChangesReason ?? viewerCan?.decideReason },
  ]
  const allowed = (v: ReviewVerdict) => verdicts.find((x) => x.value === v)!.allowed
  // Rejected something: most likely asking for changes. Else approving, where they may.
  const [verdict, setVerdict] = useState<ReviewVerdict>(() => (
    (['request_changes', 'approve', 'comment'] as const).filter((v) => v !== 'request_changes' || rejected > 0).find(allowed) ?? 'comment'))
  const [summary, setSummary] = useState('')
  const [moved, setMoved] = useState(false)

  const needsSummary = verdict === 'comment' || (verdict === 'request_changes' && rejected === 0)
  const missing = needsSummary && !summary.trim()
  const off = !allowed(verdict) || missing || actions.busy || actions.changesFetching

  const submit = () => {
    if (off) return
    setMoved(false)
    actions.submitReview(verdict, summary, {
      onDone: () => { setSummary(''); onOpenChange(false) },
      onMoved: () => setMoved(true),
    })
  }

  const tally = [
    total > 0 ? `You viewed ${viewed.toLocaleString()} of ${total.toLocaleString()}` : null,
    deciding && decisions ? `accepted ${decisions.accepted.toLocaleString()}` : null,
    deciding && decisions ? `rejected ${decisions.rejected.toLocaleString()}` : null,
    plural(openThreads, 'open thread'),
  ].filter(Boolean).join(' · ')

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} aria-label="Finish your review"
          onKeyDown={(e) => { if (e.key === 'Enter' && hasPrimaryModifier(e)) { e.preventDefault(); submit() } }}
          className="z-50 w-[24rem] max-w-[calc(100vw-2rem)] rounded-xl border border-glass-border bg-canvas-elevated shadow-lg p-4 animate-in fade-in zoom-in-95">
          <p className="text-[13px] font-semibold text-ink">Finish your review</p>
          <p className="text-[12px] text-ink-muted mt-0.5 tabular-nums">{tally}</p>

          <Segmented label="Your verdict" size="md" className="mt-3" value={verdict} onChange={setVerdict}
            options={verdicts.map((v) => ({ value: v.value, label: LABEL[v.value], disabled: !v.allowed }))} />
          {verdicts.some((v) => !v.allowed) && (
            <ul className="mt-1.5 space-y-0.5">
              {verdicts.filter((v) => !v.allowed).map((v) => (
                <li key={v.value} className="text-[11.5px] text-ink-muted leading-snug">
                  <span className="font-medium text-ink-secondary">{LABEL[v.value]}:</span>{' '}
                  {VERDICT_REFUSALS[v.reason ?? ''] ?? 'You can’t give this verdict on this review.'}
                </li>
              ))}
            </ul>
          )}

          <label className="block mt-3">
            <span className="sr-only">Summary</span>
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} maxLength={10_000} autoFocus
              required={needsSummary} aria-invalid={missing || undefined}
              placeholder={verdict === 'approve' ? 'Anything to add? (optional)'
                : verdict === 'request_changes' ? 'What should change, and why?' : 'What do you think?'}
              className="w-full rounded-xl border border-glass-border bg-canvas px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40" />
          </label>
          {needsSummary && (
            <p className="text-[11.5px] text-ink-muted">
              {verdict === 'comment' ? 'A comment needs a summary.' : 'You rejected nothing: say what should change.'}
            </p>
          )}

          {moved && (
            <div role="alert" className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
              <span>
                The draft changed while you reviewed —{' '}
                <button type="button" onClick={() => onOpenChange(false)} className="font-semibold underline underline-offset-2">
                  see what’s new
                </button>
              </span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mt-3">
            <span className="mr-auto text-[11px] text-ink-muted"><Kbd shortcut="mod+enter" /> to send</span>
            <button type="button" onClick={() => onOpenChange(false)}
              className="px-3 h-8 rounded-lg text-[12.5px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              Keep reviewing
            </button>
            <button type="button" disabled={off} onClick={submit}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[12.5px] font-semibold text-white bg-accent-lineage hover:opacity-90 disabled:opacity-60">
              {actions.pending.submit ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Send className="w-3.5 h-3.5" aria-hidden />}
              Submit review
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
