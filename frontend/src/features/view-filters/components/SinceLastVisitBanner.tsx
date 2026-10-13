/**
 * "Since your last visit" — what changed among the views you can see while you
 * were away, counted with your current filters, one click from showing exactly
 * those.
 *
 * Each number is the filter it applies: "4 new" is Created · since your last
 * visit, "11 updated" is Updated · since your last visit — so the list it opens
 * always holds the number that was clicked. The two can overlap (a new view has
 * changed too), which the "updated" hint says rather than the arithmetic hiding.
 * The window stays put while you work (see store/visitWindows) until "Mark as
 * seen".
 */
import { RefreshCw, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VisitWindow } from '@/store/visitWindows'
import { VISIT_RULE } from '../dateFilter'
import { useViewCount } from '../hooks'
import type { ViewFilterState } from '../model'
import { resolveFilters, toQueryParams, type ResolveContext } from '../params'

function whenLabel(iso: string): string {
  const d = new Date(iso)
  const days = (Date.now() - d.getTime()) / 86_400_000
  return d.toLocaleString(undefined, days < 6
    ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function SinceLastVisitBanner({ state, ctx, window, onApply, onMarkSeen, className }: {
  state: ViewFilterState
  /** Must carry `visit: window`, so the counts and the list resolve it alike. */
  ctx: ResolveContext
  window: VisitWindow
  onApply: (next: ViewFilterState) => void
  onMarkSeen: () => void
  className?: string
}) {
  // A date filter of another kind would make these numbers answer a question
  // nobody asked; the banner steps aside until it is cleared.
  const otherDate = [state.created, state.updated].some(r => r && r !== VISIT_RULE)
  const base = { ...state, created: null, updated: null }
  const changedState = { ...base, updated: VISIT_RULE }
  const newState = { ...base, created: VISIT_RULE }
  const changed = useViewCount(toQueryParams(resolveFilters(changedState, ctx)), !otherDate)
  const fresh = useViewCount(toQueryParams(resolveFilters(newState, ctx)), !otherDate)

  if (otherDate || !changed.data || !fresh.data) return null
  const nChanged = changed.data.total
  const nNew = fresh.data.total
  if (nChanged === 0 && nNew === 0) return null

  const changedOn = state.updated === VISIT_RULE && !state.created
  const newOn = state.created === VISIT_RULE && !state.updated
  const pill = (on: boolean) => cn(
    'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold tabular-nums transition-colors duration-150',
    'outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
    on ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]',
  )

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-accent-lineage/15',
        'bg-gradient-to-r from-accent-lineage/10 via-transparent to-transparent px-3 py-2 text-xs text-ink-secondary',
        className,
      )}
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />
      <span>
        Since your last visit <span className="text-ink-muted">· {whenLabel(window.from)}</span>
      </span>
      <span aria-hidden className="text-ink-muted">—</span>
      {nNew > 0 && (
        <button type="button" aria-pressed={newOn} onClick={() => onApply(newOn ? base : newState)} className={pill(newOn)}>
          <Sparkles className="h-3 w-3 text-emerald-500" aria-hidden />
          {nNew.toLocaleString()} new
        </button>
      )}
      {nChanged > 0 && (
        <button
          type="button"
          aria-pressed={changedOn}
          onClick={() => onApply(changedOn ? base : changedState)}
          title="Views whose latest change came since your last visit — new ones included"
          className={pill(changedOn)}
        >
          <RefreshCw className="h-3 w-3 text-sky-500" aria-hidden />
          {nChanged.toLocaleString()} updated
        </button>
      )}
      <button
        type="button"
        onClick={onMarkSeen}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-ink-muted hover:text-ink transition-colors"
      >
        <X className="h-3 w-3" aria-hidden /> Mark as seen
      </button>
    </div>
  )
}
