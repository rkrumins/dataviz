/**
 * PublishReceiptBanner — "your changes are now live".
 *
 * The confirmation for the one action in this whole surface that is irreversible-in-spirit: work
 * leaving your draft and becoming what everyone else sees. It replaces a 3-second notification, which gave
 * shipping the same weight as copying a link — and which was invisible if the merge happened on the
 * Reviews route and the user navigated back to the canvas afterwards.
 *
 * It states what landed (in the same emerald/amber/rose language the canvas diff overlay speaks —
 * see `useDiffDecoration`), and offers the one useful next step: look at the commit. It persists
 * until dismissed; shipping is worth an explicit acknowledgement.
 *
 * NO AnimatePresence/exit here, deliberately: a portaled exit transition strands an invisible
 * click-blocker over the canvas — a freeze class that has shipped in this repo three times.
 */
import { CheckCircle2, X, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { usePublishReceiptStore } from '@/store/publishReceiptStore'

export function PublishReceiptBanner({
  graphId,
  onViewCommit,
}: {
  graphId: string | null
  onViewCommit: () => void
}) {
  const receipt = usePublishReceiptStore((s) => s.receipt)
  const clear = usePublishReceiptStore((s) => s.clearReceipt)

  // Scoped to its own graph: a receipt from one data source must not greet you on another.
  if (!receipt || !graphId || receipt.graphId !== graphId) return null

  const { added, modified, removed } = receipt.counts
  const total = added + modified + removed
  const parts: Array<{ n: number; label: string; cls: string }> = [
    { n: added, label: 'added', cls: 'text-emerald-600 dark:text-emerald-400' },
    { n: modified, label: 'updated', cls: 'text-amber-600 dark:text-amber-400' },
    { n: removed, label: 'removed', cls: 'text-rose-600 dark:text-rose-400' },
  ].filter((p) => p.n > 0)

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 border-b border-emerald-500/20 animate-fade-in',
        'bg-gradient-to-r from-emerald-500/[0.09] via-emerald-500/[0.05] to-transparent',
      )}
      role="status"
    >
      <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center shrink-0">
        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink tracking-tight">
          {receipt.via === 'review' ? 'Merged — your changes are now live' : 'Published — your changes are now live'}
        </p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          {total > 0 ? (
            <>
              {parts.map((p, i) => (
                <span key={p.label}>
                  {i > 0 && <span className="text-ink-muted/50"> · </span>}
                  <span className={cn('font-semibold tabular-nums', p.cls)}>{p.n}</span>{' '}
                  <span>{p.label}</span>
                </span>
              ))}
              <span className="text-ink-muted/50"> · </span>
              <span>everyone sees this now</span>
            </>
          ) : (
            'Everyone sees this now.'
          )}
        </p>
      </div>

      <button
        onClick={onViewCommit}
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold
                   text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
      >
        <History className="w-3.5 h-3.5" />
        View in history
      </button>
      <HoverTip className="inline-flex shrink-0" label="Hide this notice">
        <button
          onClick={clear}
          aria-label="Dismiss"
          className="shrink-0 p-1.5 rounded-lg text-ink-muted hover:bg-canvas-overlay transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </HoverTip>
    </div>
  )
}
