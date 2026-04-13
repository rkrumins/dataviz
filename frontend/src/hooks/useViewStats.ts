/**
 * useViewStats — filter-aware catalog stats for the Explorer stats bar.
 *
 * Backed by React Query so repeated calls with the same filter shape
 * share a single in-flight request and cache entry. The ``params`` are
 * serialised into the query key so every distinct filter combination
 * gets its own cache slot, with a short staleTime to keep the numbers
 * fresh as users mutate the catalog.
 */
import { useQuery } from '@tanstack/react-query'
import {
  getViewStats,
  type ViewCatalogStats,
  type ViewStatsParams,
} from '@/services/viewApiService'

const EMPTY_STATS: ViewCatalogStats = {
  total: 0,
  recentlyAdded: 0,
  needsAttention: 0,
  lastActivityAt: null,
}

export function useViewStats(params: ViewStatsParams) {
  // Stable key — JSON.stringify covers arrays and undefined cleanly.
  // Any identical filter shape hits the same cache entry; changing a
  // filter invalidates to a fresh slot.
  const key = ['views', 'stats', JSON.stringify(params)] as const

  const query = useQuery({
    queryKey: key,
    queryFn: () => getViewStats(params),
    staleTime: 15_000,
    // Show the previous value while a new one is fetching so the bar
    // doesn't flicker to zeros while the user is rapidly tweaking
    // filters.
    placeholderData: (prev) => prev,
    // Don't auto-retry on failure — stats are a nice-to-have and a bad
    // filter combo shouldn't cascade into repeated fetches.
    retry: 1,
    // Window-focus refetches would amplify any latent stability bug
    // into a visible storm; the 15s staleTime already covers freshness.
    refetchOnWindowFocus: false,
  })

  return {
    stats: query.data ?? EMPTY_STATS,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
  }
}
