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

/** A column key — the columns that support clickable sorting. */
export type SortableColumn = 'name' | 'type' | 'owner' | 'likes' | 'updated'

/** Default sort the list returns to when cycling off a column. */
const DEFAULT_SORT: SortOption = 'newest'

/**
 * Mapping from each column's ascending / descending sort to the
 * canonical ``SortOption`` string the hook understands.
 */
const COLUMN_SORTS: Record<SortableColumn, { asc: SortOption; desc: SortOption }> = {
  name: { asc: 'az', desc: 'za' },
  type: { asc: 'type-az', desc: 'type-za' },
  owner: { asc: 'owner-az', desc: 'owner-za' },
  // "Popular" is already likes-desc; pairing it with likes-asc keeps
  // the URL stable for users who bookmark their popular feed.
  likes: { asc: 'likes-asc', desc: 'popular' },
  updated: { asc: 'updated-asc', desc: 'updated' },
}

/** Resolve the column's current direction from the active sort value. */
function directionFor(sort: SortOption, col: SortableColumn): 'asc' | 'desc' | null {
  const m = COLUMN_SORTS[col]
  if (sort === m.asc) return 'asc'
  if (sort === m.desc) return 'desc'
  return null
}

/** Click handler: cycle none → asc → desc → none for the given column. */
function cycle(sort: SortOption, col: SortableColumn): SortOption {
  const state = directionFor(sort, col)
  if (state === null) return COLUMN_SORTS[col].asc
  if (state === 'asc') return COLUMN_SORTS[col].desc
  return DEFAULT_SORT
}

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
        'sticky top-0 z-10 bg-canvas-elevated/95 backdrop-blur-sm',
        'grid items-center gap-3 px-4 py-2.5',
        'border-b border-glass-border/50',
        'text-[10px] uppercase tracking-wider text-ink-muted font-bold',
        withCheckbox
          ? 'grid-cols-[28px_minmax(0,2fr)_160px_90px_36px_110px_70px_80px_140px]'
          : 'grid-cols-[minmax(0,2fr)_160px_90px_36px_110px_70px_80px_140px]',
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
      onClick={() => onSortChange(cycle(sort, col))}
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
