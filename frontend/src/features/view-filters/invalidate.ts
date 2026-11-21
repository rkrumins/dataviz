import type { QueryClient } from '@tanstack/react-query'

/**
 * After a change to the catalogue — a delete, a restore, a visibility change — every
 * number describing it is stale: the facet counts, the stats, the "remove this
 * filter" counts and the Date menu's day counts. They live under one key prefix each,
 * so one call marks them all; whatever is on screen refetches.
 */
export function invalidateViewAggregates(queryClient: QueryClient): void {
  for (const key of ['facets', 'stats', 'count', 'histogram']) {
    void queryClient.invalidateQueries({ queryKey: ['views', key] })
  }
  invalidateOtherViewLists(queryClient)
}

/**
 * Every Explorer list the reader has visited is stale too — All, Favorites, Deleted —
 * so each refetches the next time it is shown. Marked, not refetched: the list on
 * screen already carries the change (an optimistic patch), and refetching it would
 * flash it for nothing.
 */
export function invalidateOtherViewLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['explorer-views'], refetchType: 'none' })
}
