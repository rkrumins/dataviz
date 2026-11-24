/**
 * useWorkspaceViewCounts — aggregated view counts per workspace and per data source.
 *
 * Shared by the Semantic Layer deployment dashboard so the "N views" pills
 * everywhere agree. The server counts (``GET /views/counts``): counting a page
 * of the list stopped at its size. Backed by React Query with a short
 * staleTime so rapid page transitions reuse the cache without going stale on
 * assignment changes.
 */
import { useQuery } from '@tanstack/react-query'
import { getViewCounts, type ViewScopeCounts } from '@/services/viewApiService'

const EMPTY: ViewScopeCounts = { byWorkspace: {}, byDataSource: {}, total: 0 }

export function useWorkspaceViewCounts() {
  const query = useQuery({
    queryKey: ['views', 'counts'] as const,
    queryFn: () => getViewCounts(),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (prev) => prev,
  })

  return {
    counts: query.data ?? EMPTY,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
  }
}
