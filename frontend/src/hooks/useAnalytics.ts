/**
 * Analytics data hooks.
 *
 * The window is folded into every query key so each range caches independently
 * and flipping back to one already seen is instant.
 *
 * `placeholderData: (prev) => prev` is the important line. Without it a range
 * change unmounts every chart into a skeleton and the page jumps; with it the
 * previous render is held (the pages fade it to 50% via `isFetching`) and the
 * new numbers swap in underneath the same layout.
 */
import { useQuery } from '@tanstack/react-query'

import {
    analyticsService,
    rangeKey,
    type AnalyticsRangeSelection,
    type AnalyticsSummary,
    type WorkspaceAnalyticsDetail,
    type WorkspaceAnalyticsRow,
} from '@/services/analyticsService'

/** Aggregates move slowly; a minute of staleness keeps range-flipping cheap. */
const STALE_MS = 60_000

export function useAnalyticsSummary(range: AnalyticsRangeSelection) {
    const query = useQuery({
        // Keyed by the RESOLVED range, not the object: a fresh `{days: 30}`
        // each render would otherwise miss its own cache entry every time.
        queryKey: ['analytics', 'summary', rangeKey(range)] as const,
        queryFn: () => analyticsService.getSummary(range),
        staleTime: STALE_MS,
        placeholderData: (prev) => prev,
        retry: 1,
        refetchOnWindowFocus: false,
    })
    return {
        data: query.data as AnalyticsSummary | undefined,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        error: query.error as Error | null,
        refetch: query.refetch,
    }
}

/** `enabled` is false on the tabs that don't show the table, so four of the
 *  five tabs cost one request rather than two. */
export function useWorkspaceAnalytics(range: AnalyticsRangeSelection, enabled = true) {
    const query = useQuery({
        queryKey: ['analytics', 'workspaces', rangeKey(range)] as const,
        queryFn: () => analyticsService.listWorkspaces(range),
        enabled,
        staleTime: STALE_MS,
        placeholderData: (prev) => prev,
        retry: 1,
        refetchOnWindowFocus: false,
    })
    return {
        data: query.data as WorkspaceAnalyticsRow[] | undefined,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        error: query.error as Error | null,
    }
}

export function useWorkspaceAnalyticsDetail(
    workspaceId: string | null, range: AnalyticsRangeSelection,
) {
    const query = useQuery({
        queryKey: ['analytics', 'workspace', workspaceId, rangeKey(range)] as const,
        queryFn: () => analyticsService.getWorkspace(workspaceId as string, range),
        enabled: !!workspaceId,
        staleTime: STALE_MS,
        placeholderData: (prev) => prev,
        retry: 1,
        refetchOnWindowFocus: false,
    })
    return {
        data: query.data as WorkspaceAnalyticsDetail | undefined,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        error: query.error as Error | null,
    }
}
