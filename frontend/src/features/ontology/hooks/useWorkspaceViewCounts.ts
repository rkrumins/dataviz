/**
 * useWorkspaceViewCounts — aggregated view counts per workspace and per data source.
 *
 * Shared between WorkspacesPage and the Semantic Layer deployment dashboard
 * so the "N views" pills everywhere agree. Backed by React Query with a
 * short staleTime so rapid page transitions reuse the cache without
 * going stale on assignment changes.
 */
import { useQuery } from '@tanstack/react-query'
import { listViews } from '@/services/viewApiService'

interface WorkspaceViewCounts {
  byWorkspace: Record<string, number>
  byDataSource: Record<string, number>
  total: number
}

const EMPTY: WorkspaceViewCounts = { byWorkspace: {}, byDataSource: {}, total: 0 }

export function useWorkspaceViewCounts() {
  const query = useQuery({
    queryKey: ['views', 'counts-by-scope'] as const,
    queryFn: async (): Promise<WorkspaceViewCounts> => {
      const { items, total } = await listViews({ limit: 200 })
      const byWorkspace: Record<string, number> = {}
      const byDataSource: Record<string, number> = {}
      for (const v of items) {
        if (v.workspaceId) {
          byWorkspace[v.workspaceId] = (byWorkspace[v.workspaceId] ?? 0) + 1
        }
        if (v.dataSourceId) {
          byDataSource[v.dataSourceId] = (byDataSource[v.dataSourceId] ?? 0) + 1
        }
      }
      return { byWorkspace, byDataSource, total }
    },
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
