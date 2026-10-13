import type { QueryClient } from '@tanstack/react-query'

/**
 * After a change to the catalogue — a delete, a restore, a visibility change — every
 * number describing it is stale: the facet counts, the stats, the "remove this
 * filter" counts and the activity timeline. They live under one key prefix each,
 * so one call marks them all; whatever is on screen refetches.
 */
export function invalidateViewAggregates(queryClient: QueryClient): void {
  for (const key of ['facets', 'stats', 'count', 'histogram']) {
    void queryClient.invalidateQueries({ queryKey: ['views', key] })
  }
}
