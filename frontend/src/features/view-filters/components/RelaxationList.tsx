/**
 * One way out per active filter — "Updated: Past 7 days  +23 views" — best first,
 * for an empty list. A filter whose removal alone still leaves nothing is shown
 * dimmed rather than hidden: knowing it isn't the culprit is useful too.
 */
import { ArrowRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewFilterState } from '../model'
import type { Relaxation } from '../useRelaxations'

export function RelaxationList({ relaxations, onRelax, className }: {
  relaxations: Relaxation[]
  onRelax: (next: ViewFilterState) => void
  className?: string
}) {
  return (
    <div className={cn('text-left', className)}>
      <p className="mb-2 text-xs font-semibold text-ink-secondary">Remove one filter to see more:</p>
      <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.08] overflow-hidden rounded-xl border border-black/[0.08] dark:border-white/[0.1] bg-canvas-elevated">
        {relaxations.map(r => {
          const dead = r.count === 0
          return (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => onRelax(r.next)}
                className={cn(
                  'group flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                  'hover:bg-black/[0.03] dark:hover:bg-white/[0.04] focus-visible:outline-none focus-visible:bg-black/[0.04]',
                  dead && 'opacity-60',
                )}
              >
                <X className="h-3.5 w-3.5 shrink-0 text-ink-muted group-hover:text-ink" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{r.summary}</span>
                {r.count === undefined ? (
                  <span className="h-3 w-14 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.08]" aria-label="Counting" />
                ) : dead ? (
                  <span className="text-[11px] text-ink-muted">not enough on its own</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums text-accent-lineage">
                    +{r.count.toLocaleString()} view{r.count === 1 ? '' : 's'}
                    <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
