/**
 * The Explorer's sorts by name: what the sort menu and a list-header click call
 * each one, the default, and reading one from the address. Every sort runs on the
 * server (``view_repo._view_order_by``). Kept apart from the data hook so a test
 * that stubs the hook still has the real labels.
 */
import type { SortOption } from '@/hooks/useExplorerViews'

/** Every sort, as a reader would name it — the dropdown's options and the label
 *  for a sort a list-header click chose. */
export const SORT_LABELS: Record<SortOption, string> = {
  'recently-modified': 'Recently modified',
  'data-newest': 'Recently updated data',
  'data-oldest': 'Oldest updated data',
  newest: 'Newest created',
  oldest: 'Oldest created',
  updated: 'Recently edited (settings)',
  popular: 'Most liked',
  'most-opened': 'Most opened',
  az: 'A \u2192 Z',
  za: 'Z \u2192 A',
  'modified-asc': 'Least recently modified',
  'updated-asc': 'Least recently edited (settings)',
  'likes-asc': 'Least liked',
  'type-az': 'Type A \u2192 Z',
  'type-za': 'Type Z \u2192 A',
  'owner-az': 'Owner A \u2192 Z',
  'owner-za': 'Owner Z \u2192 A',
}

export const DEFAULT_SORT: SortOption = 'recently-modified'

/** A sort from the address, or the default when it names none we know. */
export function parseSort(value: string | null): SortOption {
  return value && value in SORT_LABELS ? (value as SortOption) : DEFAULT_SORT
}

/** A list-view column whose header sorts. */
export type SortableColumn = 'name' | 'type' | 'owner' | 'likes' | 'updated'

/** Each column's ascending and descending sort. */
const COLUMN_SORTS: Record<SortableColumn, { asc: SortOption; desc: SortOption }> = {
  name: { asc: 'az', desc: 'za' },
  type: { asc: 'type-az', desc: 'type-za' },
  owner: { asc: 'owner-az', desc: 'owner-za' },
  // "Popular" is already likes-desc; pairing it with likes-asc keeps
  // the URL stable for users who bookmark their popular feed.
  likes: { asc: 'likes-asc', desc: 'popular' },
  // The column shows the later of a settings edit and a data publish — the
  // page's default order — so it sorts by that same time.
  updated: { asc: 'modified-asc', desc: 'recently-modified' },
}

/** The column's direction under the active sort, if it is that column's. */
export function directionFor(sort: SortOption, col: SortableColumn): 'asc' | 'desc' | null {
  const m = COLUMN_SORTS[col]
  if (sort === m.asc) return 'asc'
  if (sort === m.desc) return 'desc'
  return null
}

/** A header click: none → asc → desc → the page's default order. Updated's
 *  descending IS the default, so that column toggles asc ↔ desc. */
export function cycleColumnSort(sort: SortOption, col: SortableColumn): SortOption {
  const state = directionFor(sort, col)
  if (state === null) return COLUMN_SORTS[col].asc
  if (state === 'asc') return COLUMN_SORTS[col].desc
  return COLUMN_SORTS[col].desc === DEFAULT_SORT ? COLUMN_SORTS[col].asc : DEFAULT_SORT
}
