/**
 * useWorkspaceSummary — the estate's numbers, from the one server-side
 * definition the dashboard, the workspaces page and the admin overview share.
 *
 * Each page used to add these up itself from a different snapshot (the
 * dashboard from a workspace list loaded once at sign-in), so the three quoted
 * different totals. Reading one query key means they also refresh together:
 * anything that changes workspaces or data sources invalidates this key.
 */
import { useQuery } from '@tanstack/react-query'
import { workspaceService, type WorkspaceSummary, type WorkspaceSummaryTrend } from '@/services/workspaceService'

export const WORKSPACE_SUMMARY_KEY = ['workspaces', 'summary'] as const

export function useWorkspaceSummary() {
  const query = useQuery({
    queryKey: WORKSPACE_SUMMARY_KEY,
    queryFn: () => workspaceService.summary(),
    staleTime: 30_000,
    // These pages are where people go to check the numbers; showing a cached
    // answer without asking again is how the dashboard went stale before.
    refetchOnMount: 'always',
    // A source still being measured fills in on its own instead of leaving a
    // total that looks complete and is not.
    refetchInterval: (q) => ((q.state.data?.totals.pendingDataSources ?? 0) > 0 ? 10_000 : false),
  })
  return {
    summary: query.data as WorkspaceSummary | undefined,
    isLoading: query.isLoading,
    error: query.error,
  }
}

/**
 * The same numbers over the last 30 days, for the Dashboard's sparklines. Under
 * the summary's key, so whatever refreshes the summary refreshes this too.
 */
export function useWorkspaceSummaryTrend() {
  const query = useQuery({
    queryKey: [...WORKSPACE_SUMMARY_KEY, 'trend'],
    queryFn: () => workspaceService.summaryTrend(),
    staleTime: 5 * 60_000,
  })
  return { trend: query.data as WorkspaceSummaryTrend | undefined }
}
