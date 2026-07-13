/**
 * WorkspaceFilterToolbar — Single-row filter/sort/layout toolbar for the
 * workspace browser page. Follows patterns from ExplorerFilterBar and
 * ExplorerSortControl.
 *
 * Layout: [Search...] [Health ▾] [Sort ▾] [Grid|List]
 *         Results: N of M workspaces
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Search,
  X,
  LayoutGrid,
  List,
  SortAsc,
  ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type WorkspaceSortKey =
  | 'newest'
  | 'oldest'
  | 'az'
  | 'za'
  | 'most-sources'
  | 'most-entities'

export type HealthFilter = 'all' | 'healthy' | 'warning' | 'critical' | 'idle' | 'empty'

interface WorkspaceFilterToolbarProps {
  search: string
  onSearchChange: (q: string) => void
  sort: WorkspaceSortKey
  onSortChange: (s: WorkspaceSortKey) => void
  layout: 'grid' | 'list'
  onLayoutChange: (l: 'grid' | 'list') => void
  healthFilter: HealthFilter
  onHealthFilterChange: (h: HealthFilter) => void
  /** How many workspaces sit in each state — an option that matches nothing is
   *  shown as empty and can't be selected, instead of silently blanking the page. */
  healthCounts?: Partial<Record<HealthFilter, number>>
  totalCount: number
  filteredCount: number
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const SORT_OPTIONS: { key: WorkspaceSortKey; label: string }[] = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'az', label: 'A \u2192 Z' },
  { key: 'za', label: 'Z \u2192 A' },
  { key: 'most-sources', label: 'Most Sources' },
  { key: 'most-entities', label: 'Most Entities' },
]

/**
 * The old list offered Healthy / Warning / Critical only — three states that this
 * instance's data never produces, because a source that has never been aggregated
 * ('none') and a workspace with no sources both fell through to "unknown". Picking
 * any of them returned an empty page, which is why the filter looked dead.
 *
 * These are the states that actually occur, and each option carries its live count
 * so a filter that would return nothing is visibly, unclickably empty.
 */
const HEALTH_OPTIONS: { key: HealthFilter; label: string; dot: string | null }[] = [
  { key: 'all', label: 'All', dot: null },
  { key: 'healthy', label: 'Ready', dot: 'bg-emerald-500' },
  { key: 'warning', label: 'Syncing', dot: 'bg-amber-500' },
  { key: 'critical', label: 'Needs attention', dot: 'bg-red-500' },
  { key: 'idle', label: 'Not aggregated', dot: 'bg-slate-400' },
  { key: 'empty', label: 'No data', dot: 'bg-slate-300' },
]

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onClose])
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function WorkspaceFilterToolbar({
  search,
  onSearchChange,
  sort,
  onSortChange,
  layout,
  onLayoutChange,
  healthFilter,
  onHealthFilterChange,
  healthCounts,
  totalCount,
  filteredCount,
}: WorkspaceFilterToolbarProps) {
  const [healthOpen, setHealthOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)

  const healthRef = useRef<HTMLDivElement>(null)
  const sortRef = useRef<HTMLDivElement>(null)

  useClickOutside(healthRef, useCallback(() => setHealthOpen(false), []))
  useClickOutside(sortRef, useCallback(() => setSortOpen(false), []))

  const currentSort = SORT_OPTIONS.find(o => o.key === sort) ?? SORT_OPTIONS[0]
  const currentHealth = HEALTH_OPTIONS.find(o => o.key === healthFilter) ?? HEALTH_OPTIONS[0]

  return (
    <div className="space-y-2">
      {/* ── Single toolbar row ── */}
      <div className="flex items-center gap-3">
        {/* Search input */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search workspaces..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          />
          {search && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Health filter dropdown */}
        <div ref={healthRef} className="relative">
          <button
            onClick={() => { setHealthOpen(p => !p); setSortOpen(false) }}
            className={cn(
              'flex items-center gap-2 rounded-lg border border-glass-border px-3 py-2.5 text-xs font-medium',
              'text-ink-muted hover:text-ink transition-colors',
              healthOpen && 'text-ink ring-1 ring-indigo-500/30',
            )}
          >
            {currentHealth.dot && (
              <span className={cn('h-2 w-2 rounded-full', currentHealth.dot)} />
            )}
            Health: {currentHealth.label}
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform duration-150',
                healthOpen && 'rotate-180',
              )}
            />
          </button>

          {healthOpen && (
            <div className="absolute right-0 mt-1 w-56 rounded-xl bg-canvas-elevated border border-glass-border shadow-lg z-10 py-1">
              {HEALTH_OPTIONS.map(opt => {
                const count = opt.key === 'all'
                  ? (healthCounts?.all ?? undefined)
                  : healthCounts?.[opt.key]
                const isEmpty = count === 0 && opt.key !== 'all'
                return (
                  <button
                    key={opt.key}
                    disabled={isEmpty}
                    onClick={() => { onHealthFilterChange(opt.key); setHealthOpen(false) }}
                    className={cn(
                      'w-full px-3 py-2 text-sm flex items-center gap-2 transition-colors',
                      isEmpty
                        ? 'opacity-40 cursor-not-allowed'
                        : 'hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer',
                      healthFilter === opt.key && 'font-semibold text-indigo-600 dark:text-indigo-400',
                    )}
                  >
                    {opt.dot ? (
                      <span className={cn('h-2 w-2 rounded-full shrink-0', opt.dot)} />
                    ) : (
                      <span className="h-2 w-2 shrink-0" />
                    )}
                    <span className="flex-1 text-left truncate">{opt.label}</span>
                    {count !== undefined && (
                      <span className="text-[10px] tabular-nums text-ink-muted">{count}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Sort dropdown */}
        <div ref={sortRef} className="relative">
          <button
            onClick={() => { setSortOpen(p => !p); setHealthOpen(false) }}
            className={cn(
              'flex items-center gap-2 rounded-lg border border-glass-border px-3 py-2.5 text-xs font-medium',
              'text-ink-muted hover:text-ink transition-colors',
              sortOpen && 'text-ink ring-1 ring-indigo-500/30',
            )}
          >
            <SortAsc className="h-3.5 w-3.5" />
            {currentSort.label}
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform duration-150',
                sortOpen && 'rotate-180',
              )}
            />
          </button>

          {sortOpen && (
            <div className="absolute right-0 mt-1 w-48 rounded-xl bg-canvas-elevated border border-glass-border shadow-lg z-10 py-1">
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  onClick={() => { onSortChange(opt.key); setSortOpen(false) }}
                  className={cn(
                    'w-full px-3 py-2 text-sm flex items-center gap-2 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors',
                    sort === opt.key && 'font-semibold text-indigo-600 dark:text-indigo-400',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Layout toggle */}
        <div className="inline-flex items-center rounded-lg border border-glass-border p-0.5">
          <button
            onClick={() => onLayoutChange('grid')}
            className={cn(
              'rounded-md p-2 transition-colors',
              layout === 'grid'
                ? 'bg-indigo-500/10 text-indigo-500'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => onLayoutChange('list')}
            className={cn(
              'rounded-md p-2 transition-colors',
              layout === 'list'
                ? 'bg-indigo-500/10 text-indigo-500'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Results count ── */}
      <p className="text-xs text-ink-muted">
        {filteredCount === totalCount
          ? `${totalCount} workspaces`
          : `${filteredCount} of ${totalCount} workspaces`}
      </p>
    </div>
  )
}
