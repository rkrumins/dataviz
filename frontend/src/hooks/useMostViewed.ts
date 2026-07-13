/**
 * What the team opens most — access-scoped server-side, so it can never surface a
 * view the caller couldn't open anyway.
 *
 * Ranked by DISTINCT viewers first, then total opens: "eight people opened this"
 * is a stronger recommendation than "one person opened it eighty times".
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { getMostViewed, type MostViewedEntry } from '@/services/viewApiService'

export const MOST_VIEWED_QUERY_KEY = 'most-viewed'
export const MOST_VIEWED_LIMIT = 12

export function useMostViewed(
    limit: number = MOST_VIEWED_LIMIT,
): UseQueryResult<MostViewedEntry[], Error> {
    return useQuery<MostViewedEntry[], Error>({
        queryKey: [MOST_VIEWED_QUERY_KEY, limit],
        queryFn: () => getMostViewed(limit),
        staleTime: 60_000,
        retry: 1,
    })
}
