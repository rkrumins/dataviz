/**
 * ExplorerListHeader — sticky, clickable column headers for the list view.
 *
 * Visual design:
 * - Sticky at the top of the scroll container so headers stay visible
 *   while the user scrolls long lists.
 * - Sortable columns (Name / Type / Owner / Likes / Updated) are
 *   buttons; clicking cycles sort direction:
 *     unsorted → asc → desc → unsorted
 * - Direction arrow is emphasised for the active column, dim for others.
 *
 * The grid template matches ``ExplorerListRow`` so rows and the header
 * share the same column widths — single source of truth.
 */
import { cn } from '@/lib/utils'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import type { SortOption } from '@/hooks/useExplorerViews'
import { cycleColumnSort, directionFor, type SortableColumn } from './sortOptions'

interface ExplorerListHeaderProps {
  sort: SortOption
  onSortChange: (sort: SortOption) => void
  /** Whether the checkbox column should be reserved. */
  withCheckbox?: boolean
}

export function ExplorerListHeader({
  sort,
  onSortChange,
  withCheckbox = true,
}: ExplorerListHeaderProps) {
  return (
    <div
      className={cn(
        'sticky top-0 z-10 bg-canvas-elevated',
        'grid items-center gap-3 px-4 py-2.5',
        'border-b border-glass-border/50',
        'text-[10px] uppercase tracking-wider text-ink-muted font-bold',
        withCheckbox
          ? 'grid-cols-[28px_minmax(0,1.5fr)_minmax(0,1.1fr)_90px_36px_110px_70px_80px_140px]'
          : 'grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_90px_36px_110px_70px_80px_140px]',
      )}
    >
      {withCheckbox && <span />}
      <SortableHeaderCell
        label="Name"
        col="name"
        sort={sort}
        onSortChange={onSortChange}
      />
      {/* Scope is compound (workspace + data source) — not sortable. */}
      <span>Scope</span>
      <SortableHeaderCell
        label="Type"
        col="type"
        sort={sort}
        onSortChange={onSortChange}
      />
      <span>Vis</span>
      <SortableHeaderCell
        label="Owner"
        col="owner"
        sort={sort}
        onSortChange={onSortChange}
      />
      <SortableHeaderCell
        label="Likes"
        col="likes"
        sort={sort}
        onSortChange={onSortChange}
      />
      <SortableHeaderCell
        label="Updated"
        col="updated"
        sort={sort}
        onSortChange={onSortChange}
      />
      <span className="text-right">Actions</span>
    </div>
  )
}

interface SortableHeaderCellProps {
  label: string
  col: SortableColumn
  sort: SortOption
  onSortChange: (sort: SortOption) => void
}

function SortableHeaderCell({ label, col, sort, onSortChange }: SortableHeaderCellProps) {
  const dir = directionFor(sort, col)
  const active = dir !== null
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown
  return (
    <button
      type="button"
      onClick={() => onSortChange(cycleColumnSort(sort, col))}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 -ml-1',
        'uppercase tracking-wider text-[10px] font-bold',
        'transition-colors duration-150',
        active
          ? 'text-accent-lineage'
          : 'text-ink-muted hover:text-ink',
      )}
      aria-label={`Sort by ${label}${dir ? ` (${dir})` : ''}`}
    >
      {label}
      <Icon
        className={cn(
          'h-3 w-3 shrink-0',
          active ? 'opacity-100' : 'opacity-40',
        )}
      />
    </button>
  )
}
