/**
 * The caller's unpublished drafts.
 *
 * Until this existed, unfinished work was invisible the moment you navigated away
 * from the view you were editing: every branch endpoint is scoped to a single
 * graph, so nothing could answer "what have I left open?". Drafts then rot
 * quietly and resurface as somebody else's merge conflict.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { getMyDrafts, type MyDraftEntry } from '@/services/viewApiService'

export const MY_DRAFTS_QUERY_KEY = 'my-drafts'

/** Matches the endpoint's default. */
export const MY_DRAFTS_LIMIT = 6

export function useMyDrafts(
    limit: number = MY_DRAFTS_LIMIT,
): UseQueryResult<MyDraftEntry[], Error> {
    return useQuery<MyDraftEntry[], Error>({
        queryKey: [MY_DRAFTS_QUERY_KEY, limit],
        queryFn: () => getMyDrafts(limit),
        staleTime: 30_000,
        retry: 1,
    })
}
