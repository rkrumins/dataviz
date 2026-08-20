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
    type AnalyticsSummary,
    type WorkspaceAnalyticsDetail,
    type WorkspaceAnalyticsRow,
} from '@/services/analyticsService'

/** Aggregates move slowly; a minute of staleness keeps range-flipping cheap. */
const STALE_MS = 60_000

export function useAnalyticsSummary(days: number) {
    const query = useQuery({
        queryKey: ['analytics', 'summary', days] as const,
        queryFn: () => analyticsService.getSummary(days),
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
export function useWorkspaceAnalytics(days: number, enabled = true) {
    const query = useQuery({
        queryKey: ['analytics', 'workspaces', days] as const,
        queryFn: () => analyticsService.listWorkspaces(days),
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

export function useWorkspaceAnalyticsDetail(workspaceId: string | null, days: number) {
    const query = useQuery({
        queryKey: ['analytics', 'workspace', workspaceId, days] as const,
        queryFn: () => analyticsService.getWorkspace(workspaceId as string, days),
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
