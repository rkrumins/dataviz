import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TablePaginationProps {
  /** 0-indexed current page. */
  page: number
  pageSize: number
  /** Total item count across all pages (the unpaginated length). */
  total: number
  onPageChange: (page: number) => void
  className?: string
}

/**
 * Compact prev/next page controls for admin tables. Renders nothing when
 * everything fits on one page, so short lists look exactly as before.
 *
 * It is JUST the control cluster (no count) — drop it into the caller's
 * existing table footer, which keeps showing the "Showing N of M" total.
 * Pair with `list.slice(page*pageSize, (page+1)*pageSize)`: that keeps the DOM
 * to a single page of rows instead of mounting hundreds at once, and caps any
 * index-scaled entry stagger (only ~pageSize rows animate).
 */
export function TablePagination({ page, pageSize, total, onPageChange, className }: TablePaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (pageCount <= 1) return null

  const btn =
    'p-1 rounded-md text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40 disabled:pointer-events-none transition-colors'

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <button
        type="button"
        disabled={page <= 0}
        onClick={() => onPageChange(page - 1)}
        aria-label="Previous page"
        className={btn}
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-xs text-ink-muted tabular-nums">
        Page {page + 1} / {pageCount}
      </span>
      <button
        type="button"
        disabled={page >= pageCount - 1}
        onClick={() => onPageChange(page + 1)}
        aria-label="Next page"
        className={btn}
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  )
}
