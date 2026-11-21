/**
 * A review's discussion, read and written through react-query: threads a page at a time, counts
 * per change, who can be mentioned — each refreshed while on screen (focus, and every 30 s), so
 * a reply someone else wrote shows up without a reload. Every write refreshes them all.
 */
import { useMemo } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteReviewComment, editReviewComment, getReviewCommentCounts, listReviewCommentPeople, listReviewThreads,
  postReviewComment, setReviewThreadResolved, type ReviewThreadFilter,
} from '@/services/versioningApiService'
import type { MentionSource } from './CommentComposer'
import { matchMentionCandidates } from './mentions'

/** How often a discussion on screen is read again. */
const POLL_MS = 30_000
export const THREAD_PAGE = 20

export const COMMENT_KEYS = {
  all: (wsId: string, prId: string) => ['reviewComments', wsId, prId] as const,
  threads: (wsId: string, prId: string, filter: ReviewThreadFilter) => ['reviewComments', wsId, prId, 'threads', filter] as const,
  counts: (wsId: string, prId: string) => ['reviewComments', wsId, prId, 'counts'] as const,
  people: (wsId: string, prId: string) => ['reviewComments', wsId, prId, 'people'] as const,
}

export function useReviewThreads(wsId: string, prId: string, filter: ReviewThreadFilter, enabled = true) {
  return useInfiniteQuery({
    queryKey: COMMENT_KEYS.threads(wsId, prId, filter),
    queryFn: ({ pageParam }) => listReviewThreads(wsId, prId, filter, pageParam, THREAD_PAGE),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.threads.length : undefined),
    enabled,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })
}

export function useReviewCommentCounts(wsId: string, prId: string | null | undefined) {
  return useQuery({
    queryKey: COMMENT_KEYS.counts(wsId, prId ?? ''),
    queryFn: () => getReviewCommentCounts(wsId, prId!),
    enabled: !!prId,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })
}

/** Who can be mentioned, for the composer — the review's people, asked for once someone starts
 *  to mention and then matched here as the name is typed. */
export function useReviewMentionSource(wsId: string, prId: string): MentionSource {
  const qc = useQueryClient()
  return useMemo(() => ({
    queryKey: [...COMMENT_KEYS.people(wsId, prId), 'matching'],
    load: async (q: string) => {
      const people = await qc.fetchQuery({
        queryKey: COMMENT_KEYS.people(wsId, prId),
        queryFn: () => listReviewCommentPeople(wsId, prId),
        staleTime: 5 * 60_000,
      })
      return matchMentionCandidates(people.map((p) => ({
        id: p.userId, name: p.displayName || p.email || p.userId, email: p.email,
      })), q)
    },
  }), [qc, wsId, prId])
}

/** Post, edit, delete, resolve — each refreshes every read of this discussion. */
export function useReviewCommentActions(wsId: string, prId: string) {
  const qc = useQueryClient()
  const settle = () => qc.invalidateQueries({ queryKey: COMMENT_KEYS.all(wsId, prId) })
  const post = useMutation({
    mutationFn: (data: Parameters<typeof postReviewComment>[2]) => postReviewComment(wsId, prId, data),
    onSettled: settle,
  })
  const edit = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => editReviewComment(wsId, prId, id, body),
    onSettled: settle,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteReviewComment(wsId, prId, id),
    onSettled: settle,
  })
  const resolve = useMutation({
    mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) =>
      setReviewThreadResolved(wsId, prId, threadId, resolved),
    onSettled: settle,
  })
  return { post, edit, remove, resolve }
}
