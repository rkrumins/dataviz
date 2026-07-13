/**
 * The views the user has explicitly pinned (favourited).
 *
 * Recents answer "what did I touch?"; pins answer "what do I CARE about" — the
 * user's own deliberate signal, which is the one a landing page should honour
 * first. No new endpoint: `favouritedOnly` already existed on the views list and
 * nothing on the dashboard had ever used it.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { listViews, type View } from '@/services/viewApiService'

export const PINNED_VIEWS_QUERY_KEY = 'pinned-views'
export const PINNED_VIEWS_LIMIT = 8

export function usePinnedViews(
    limit: number = PINNED_VIEWS_LIMIT,
): UseQueryResult<View[], Error> {
    return useQuery<View[], Error>({
        queryKey: [PINNED_VIEWS_QUERY_KEY, limit],
        // Server-side ordering: freshest DATA first, so a pinned view whose source
        // was just republished floats up. Sorting client-side would only order the
        // page we happened to fetch.
        queryFn: () => listViews({ favouritedOnly: true, limit, sort: 'recently-modified' })
            .then(r => r.items ?? []),
        staleTime: 30_000,
        retry: 1,
    })
}
