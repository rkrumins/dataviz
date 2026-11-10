/**
 * ReviewSummaryCard — a change list at a glance, where the Context View can review it: how much
 * changed by operation, the types it touched most, and **Review changes**, which lists them beside
 * the canvas. Each operation's count starts the review on that operation.
 */
import { useMemo } from 'react'
import { ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SkeletonText } from '@/components/ui/Skeleton'
import type { ChangeListStatus } from '@/services/versioningApiService'
import { useChangeSummary } from '../hooks/useVersioning'
import type { ScopeOption } from '../hooks/useChangesScope'
import { NodeDiffBadge, STATUS_META } from './NodeDiffBadge'

const OPERATIONS: ChangeListStatus[] = ['added', 'modified', 'removed']
/** Types named before the rest go unsaid. */
const TYPES_SHOWN = 4

export function ReviewSummaryCard({ wsId, graphId, option, title, emptyHint = 'Nothing changed here.', onReview, className }: {
  wsId: string
  graphId: string
  option: ScopeOption
  /** Said above it in place of the scope's own name. */
  title?: string
  emptyHint?: string
  /** Start the review, on one operation or on all of them. */
  onReview: (operation: ChangeListStatus | null) => void
  className?: string
}) {
  const q = useChangeSummary(wsId, graphId, option.origin)
  const s = q.data
  const types = useMemo(
    () => (s?.byType ?? []).filter((t) => t.kind === 'node')
      .map((t) => ({ type: t.type || 'Untyped', n: t.added + t.modified + t.removed }))
      .sort((a, b) => b.n - a.n)
      .slice(0, TYPES_SHOWN),
    [s],
  )

  return (
    <section aria-label={title ?? option.label}
      className={cn('rounded-xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] p-4', className)}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70">{title ?? option.label}</p>
      {q.isLoading ? (
        <SkeletonText lines={2} className="mt-2" />
      ) : !s ? (
        <p className="mt-1.5 text-xs text-ink-muted">Couldn't load these changes. Try again in a moment.</p>
      ) : s.total === 0 ? (
        <p className="mt-1.5 text-sm text-ink-muted">{emptyHint}</p>
      ) : (
        <>
          <p className="mt-1 text-[15px] font-semibold text-ink tabular-nums">
            {s.approximate ? 'About ' : ''}{s.total.toLocaleString()} {s.total === 1 ? 'change' : 'changes'}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {OPERATIONS.map((op) => s.counts[op] > 0 && (
              <button key={op} type="button" onClick={() => onReview(op)}
                aria-label={`Review ${s.counts[op].toLocaleString()} ${STATUS_META[op].label.toLowerCase()}`}
                className="rounded-md transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                <NodeDiffBadge status={op} count={s.counts[op]} withLabel />
              </button>
            ))}
          </div>
          {types.length > 0 && (
            <p className="mt-2 text-[11.5px] text-ink-muted truncate tabular-nums">
              {types.map((t) => `${t.type} ${t.n.toLocaleString()}`).join(' · ')}
            </p>
          )}
          <button type="button" onClick={() => onReview(null)}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm shadow-indigo-500/20 active:scale-[0.98]">
            <ListChecks className="w-3.5 h-3.5" /> Review changes
          </button>
        </>
      )}
    </section>
  )
}
