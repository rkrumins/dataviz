/**
 * Usage for the content on screen.
 *
 * Best-effort throughout: a failed usage call must never take a view page with
 * it. The strip simply does not render, which is the same thing that happens
 * on a platform where nobody has opened anything yet.
 */
import { useQuery } from '@tanstack/react-query'

import {
    getViewUsage, getWorkspaceUsage,
    type ViewUsage, type WorkspaceUsage,
} from '@/services/contentInsightsService'

/** Window for in-product usage. Deliberately fixed rather than a control: this
 *  is a glance, not a dashboard, and a range picker on a view page would be a
 *  second source of truth for "how much is this used". */
export const USAGE_WINDOW_DAYS = 30

export function useViewUsage(viewIds: string[], enabled = true) {
    // Sorted so ["a","b"] and ["b","a"] share one cache entry.
    const key = [...viewIds].sort()
    return useQuery<Record<string, ViewUsage>>({
        queryKey: ['view-usage', USAGE_WINDOW_DAYS, key.join(',')],
        queryFn: () => getViewUsage(key, USAGE_WINDOW_DAYS),
        enabled: enabled && key.length > 0,
        // Usage is precomputed on the server and moves slowly; refetching it
        // as someone pans a canvas would be pure noise.
        staleTime: 5 * 60_000,
        // Never retry: this is decoration on someone else's page.
        retry: false,
    })
}

export function useWorkspaceUsage(workspaceIds: string[], enabled = true) {
    const key = [...workspaceIds].sort()
    return useQuery<Record<string, WorkspaceUsage>>({
        queryKey: ['workspace-usage', USAGE_WINDOW_DAYS, key.join(',')],
        queryFn: () => getWorkspaceUsage(key, USAGE_WINDOW_DAYS),
        enabled: enabled && key.length > 0,
        staleTime: 5 * 60_000,
        retry: false,
    })
}
