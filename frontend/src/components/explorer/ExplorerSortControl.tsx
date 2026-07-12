import { useState, useRef, useCallback, useEffect } from 'react'
import { ChevronDown, Check, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SortOption } from '@/hooks/useExplorerViews'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/**
 * The dropdown only surfaces the global user-facing sorts, not every
 * valid ``SortOption``. Column-clicks in the list view may produce
 * column-sort values (``type-az``, ``owner-az``, ``likes-asc`` etc.)
 * that aren't in this picker — the prop type stays broad so both
 * worlds round-trip through the URL without type casts.
 */
interface ExplorerSortControlProps {
  sort: SortOption
  onSortChange: (sort: SortOption) => void
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

// Ordered by intent: data-modification sorts first (the enterprise default),
// then settings-edit, then creation, then name. Labels spell out WHAT each
// timestamp means \u2014 "Newest first" used to ambiguously mean creation time.
const SORT_OPTIONS: { key: SortOption; label: string; group?: string }[] = [
  { key: 'recently-modified', label: 'Recently modified', group: 'By change' },
  { key: 'data-newest', label: 'Recently updated data' },
  { key: 'data-oldest', label: 'Oldest updated data' },
  { key: 'updated', label: 'Recently edited (settings)' },
  { key: 'newest', label: 'Newest created', group: 'By creation' },
  { key: 'oldest', label: 'Oldest created' },
  { key: 'popular', label: 'Most popular', group: 'Other' },
  { key: 'az', label: 'A \u2192 Z' },
  { key: 'za', label: 'Z \u2192 A' },
]

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ExplorerSortControl({ sort, onSortChange }: ExplorerSortControlProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])

  /* Close on click outside */
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        close()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [close])

  /* Close on Escape */
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    if (open) {
      document.addEventListener('keydown', handler)
      return () => document.removeEventListener('keydown', handler)
    }
  }, [open, close])

  const current = SORT_OPTIONS.find((o) => o.key === sort) ?? SORT_OPTIONS[0]

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger ── */}
      <button
        onClick={() => setOpen((p) => !p)}
        className={cn(
          'flex items-center gap-2 rounded-lg border border-glass-border px-3 py-1.5 text-xs font-medium',
          'text-ink-muted hover:text-ink transition-colors duration-150',
          open && 'text-ink ring-1 ring-accent-lineage/30',
        )}
      >
        <ArrowUpDown className="h-3.5 w-3.5" />
        {current.label}
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* ── Dropdown ── */}
      {open && (
        <div
          className={cn(
            'absolute right-0 top-full z-50 mt-1.5 w-60 p-1',
            'bg-canvas border border-glass-border rounded-xl shadow-xl',
          )}
        >
          {SORT_OPTIONS.map((opt) => {
            const active = sort === opt.key
            return (
              <div key={opt.key}>
                {opt.group && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted/60">
                    {opt.group}
                  </div>
                )}
                <button
                  onClick={() => {
                    onSortChange(opt.key)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs transition-colors duration-150',
                    active
                      ? 'text-accent-lineage font-semibold bg-accent-lineage/5'
                      : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                >
                  <span>{opt.label}</span>
                  {active && (
                    <Check className="h-3.5 w-3.5 text-accent-lineage shrink-0" />
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
