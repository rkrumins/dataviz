/**
 * useViewActivity — React Query wrapper for a view's activity timeline.
 * Short staleTime so the timeline reflects recent changes without hammering
 * the endpoint; disabled until a viewId is present (e.g. drawer closed).
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { getViewActivity, getWorkspaceViewActivity, type ViewActivityEntry } from '@/services/viewApiService'

export const VIEW_ACTIVITY_QUERY_KEY = 'view-activity' as const
export const WORKSPACE_ACTIVITY_QUERY_KEY = 'workspace-view-activity' as const

export function useViewActivity(
    viewId: string | null,
    enabled = true,
): UseQueryResult<ViewActivityEntry[], Error> {
    return useQuery<ViewActivityEntry[], Error>({
        queryKey: [VIEW_ACTIVITY_QUERY_KEY, viewId],
        queryFn: () => getViewActivity(viewId!, { limit: 100 }),
        enabled: enabled && !!viewId,
        staleTime: 30_000,
        retry: 1,
    })
}

export function useWorkspaceViewActivity(
    workspaceId: string | null,
    enabled = true,
): UseQueryResult<ViewActivityEntry[], Error> {
    return useQuery<ViewActivityEntry[], Error>({
        queryKey: [WORKSPACE_ACTIVITY_QUERY_KEY, workspaceId],
        queryFn: () => getWorkspaceViewActivity(workspaceId!, { limit: 25 }),
        enabled: enabled && !!workspaceId,
        staleTime: 30_000,
        retry: 1,
    })
}
