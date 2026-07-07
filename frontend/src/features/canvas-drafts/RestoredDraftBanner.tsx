/**
 * RestoredDraftBanner — non-blocking notice that unsaved work from a previous
 * session was restored onto the canvas. Offers a one-click Discard (clears the
 * restored staged work) and a Dismiss (keep the work, hide the banner).
 */
import { RotateCcw, Trash2, X } from 'lucide-react'

interface RestoredDraftBannerProps {
  count: number
  onDiscard: () => void
  onDismiss: () => void
  className?: string
}

export function RestoredDraftBanner({ count, onDiscard, onDismiss, className }: RestoredDraftBannerProps) {
  if (count <= 0) return null
  return (
    <div
      className={
        'flex items-center gap-3 rounded-xl border border-accent-lineage/25 bg-accent-lineage/[0.07] px-4 py-2.5 ' +
        (className ?? '')
      }
      role="status"
    >
      <RotateCcw className="w-4 h-4 shrink-0 text-accent-lineage" />
      <p className="flex-1 text-sm text-ink">
        Restored <span className="font-semibold">{count}</span> unsaved change{count !== 1 ? 's' : ''} from your last session.
      </p>
      <button
        onClick={onDiscard}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-500/10 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
        Discard all
      </button>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
