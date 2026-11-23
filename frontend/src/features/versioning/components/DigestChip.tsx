/**
 * DigestChip — the quiet note in the canvas versioning bar that something was published since you
 * last looked: "3 new versions since your last visit" (or, before you ever marked the graph seen,
 * "12 versions in the last 7 days"; or "1 review waiting on you"). It opens the DigestSheet.
 *
 * Read once when the graph opens (`useGraphDigest`): no polling. Says nothing while it loads or
 * when nothing is new, so the bar keeps collapsing when there is nothing to show; says so when the
 * digest can't be read, and the sheet offers to try again.
 */
import { AlertTriangle, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount } from '@/lib/units'
import { HoverTip } from '@/components/ui/HoverTip'
import type { GraphDigest } from '@/services/versioningApiService'
import { useGraphDigest } from '../hooks/useDigest'

/** "3 new versions since your last visit", "12 versions in the last 7 days", "50+ …" when the
 *  7-day window is cut short. */
function versionsPhrase(d: GraphDigest): string {
  const exact = d.total
  const n = exact ?? d.versions.length
  const figure = exact == null ? `${formatCount(n)}+` : formatCount(n)
  const many = exact == null || n !== 1
  return d.since
    ? `${figure} new ${many ? 'versions' : 'version'} since your last visit`
    : `${figure} ${many ? 'versions' : 'version'} in the last 7 days`
}

const CHIP = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

export function DigestChip({ workspaceId, graphId, onOpen }: {
  workspaceId: string
  graphId: string | null
  onOpen: () => void
}) {
  const q = useGraphDigest(workspaceId, graphId)
  if (!graphId || q.isLoading) return null
  if (q.isError || !q.data) {
    return (
      <HoverTip className="inline-flex" label="What changed since your last visit couldn’t be read"
        detail="Open it to try again.">
        <button type="button" onClick={onOpen} aria-haspopup="dialog"
          className={cn(CHIP, 'text-ink-muted bg-black/[0.04] dark:bg-white/[0.06] border-glass-border hover:text-ink')}>
          <AlertTriangle className="w-3 h-3 text-amber-600 dark:text-amber-400" aria-hidden />
          Couldn’t check what changed
        </button>
      </HoverTip>
    )
  }
  const d = q.data
  const reviews = d.reviewsWaiting.length
  if (d.versions.length === 0 && reviews === 0) return null
  const reviewsPhrase = `${formatCount(reviews)}${d.reviewsMore ? '+' : ''} ${reviews === 1 && !d.reviewsMore ? 'review' : 'reviews'} waiting on you`
  const label = d.versions.length > 0 ? versionsPhrase(d) : reviewsPhrase
  const short = d.versions.length > 0
    ? `${d.total == null ? `${formatCount(d.versions.length)}+` : formatCount(d.total)} new`
    : `${formatCount(reviews)} to review`
  return (
    <HoverTip
      className="inline-flex"
      label={label}
      detail={d.versions.length > 0 && reviews > 0
        ? `And ${reviewsPhrase}. Opens who changed what, with each change.`
        : 'Opens who changed what, with each change.'}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-label={`${label}. Open what changed`}
        className={cn(CHIP, 'text-ink bg-accent-lineage/[0.06] border-accent-lineage/25 hover:bg-accent-lineage/[0.12]')}
      >
        <Sparkles className="w-3 h-3 text-accent-lineage" aria-hidden />
        <span className="sm:hidden">{short}</span>
        <span className="hidden sm:inline">{label}</span>
      </button>
    </HoverTip>
  )
}
