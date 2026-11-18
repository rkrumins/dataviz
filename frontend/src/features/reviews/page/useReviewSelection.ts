/**
 * useReviewSelection — which change of a review is open, kept in the address (`?change=`) so it
 * can be shared and survives a reload, and the thread a link opened (`?thread=`): one on a change
 * opens that change, one on the review as a whole opens the Discussion. Moving between changes
 * replaces the address rather than adding to the history.
 */
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useReviewThreads } from '../comments/useReviewComments'

export function useReviewSelection(wsId: string, prId: string) {
  const [params, setParams] = useSearchParams()
  const change = params.get('change')
  const thread = params.get('thread')
  const linkedQ = useReviewThreads(wsId, prId, { threadId: thread ?? '' }, !!thread)
  const linked = linkedQ.data?.pages[0]?.threads[0] ?? null
  const onReview = !!linked && !linked.entityId

  const select = useCallback((entityId: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (entityId) next.set('change', entityId)
      else next.delete('change')
      // A thread on a change belongs to that change; one on the review stays open beside any.
      if (!onReview) next.delete('thread')
      return next
    }, { replace: true })
  }, [setParams, onReview])

  return {
    /** The change open: the one named, else the one the linked thread is on. */
    selected: change ?? linked?.entityId ?? null,
    select,
    /** The thread a link opened. */
    threadId: thread,
    /** That thread's change, once read (none: it is on the review as a whole, or not read yet). */
    threadChange: linked?.entityId ?? null,
    threadOnReview: onReview,
  }
}
