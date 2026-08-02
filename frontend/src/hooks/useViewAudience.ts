/**
 * How many people each visibility tier would reach.
 *
 * The single-view read already carries this (`view.audience`), so the
 * Share dialog and the Details panel should pass what they already
 * have. This hook is for the one place that cannot: the View wizard
 * asks the question before any view exists.
 *
 * It is deliberately a server call rather than arithmetic over the
 * workspace store — the workspace list a browser holds is scoped to the
 * caller's own memberships and carries no member counts at all, so
 * anything computed client-side would be confidently wrong.
 */
import { useQuery } from '@tanstack/react-query'

import type { AudienceCounts } from '@/components/views/VisibilityImpact'
import { getWorkspaceAudience } from '@/services/viewApiService'

export const AUDIENCE_QUERY_KEY = ['view-audience'] as const

export function useViewAudience(workspaceId?: string | null): AudienceCounts {
    const { data } = useQuery({
        queryKey: [...AUDIENCE_QUERY_KEY, workspaceId],
        queryFn: () => getWorkspaceAudience(workspaceId!),
        enabled: Boolean(workspaceId),
        // Membership changes are rare and this only feeds a "roughly how
        // many people" line — refetching it on every focus would spend a
        // request to move a number that is rendered as an estimate.
        staleTime: 5 * 60_000,
    })
    return data ?? {}
}
