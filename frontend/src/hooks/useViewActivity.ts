/**
 * useViewActivity — React Query wrapper for a view's activity timeline.
 * Short staleTime so the timeline reflects recent changes without hammering
 * the endpoint; disabled until a viewId is present (e.g. drawer closed).
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
    getViewActivity,
    getWorkspaceViewActivity,
    getMyActivityFeed,
    type ViewActivityEntry,
} from '@/services/viewApiService'

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

export const MY_ACTIVITY_FEED_QUERY_KEY = 'my-activity-feed' as const

/** The dashboard's "What changed" feed — activity across everything the user
 *  can see. Access-scoped server-side. */
/**
 * How many events the "activity in your workspaces" feed loads. Shared by the
 * feed and the hero's "what's new" line so they hit the SAME query key — two
 * different limits would mean two cache entries and two requests for the same
 * data. It is also the window the digest and the "24+" cap describe.
 */
export const MY_FEED_LIMIT = 24

export function useMyActivityFeed(
    limit: number = MY_FEED_LIMIT,
    enabled = true,
): UseQueryResult<ViewActivityEntry[], Error> {
    return useQuery<ViewActivityEntry[], Error>({
        queryKey: [MY_ACTIVITY_FEED_QUERY_KEY, limit],
        queryFn: () => getMyActivityFeed(limit),
        enabled,
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
