/**
 * useReviewRail — the Context View's left rail holds search results or a review's list of changes,
 * one at a time: opening one closes the other, and each keeps what it was showing (the search in
 * its session, the review in `reviewStore`).
 *
 * Reviews are the Context View's while it is mounted (`available`); elsewhere, what counts changes
 * keeps its own lists. Unmounting ends the review.
 */
import { useEffect } from 'react'
import { useReviewStore } from '@/store/reviewStore'

/** Whether the review's list is open, given the search panel's state and how to close it. */
export function useReviewRail(searchOpen: boolean, closeSearch: () => void): boolean {
  const listOpen = useReviewStore((s) => s.listOpen)
  // Only the list opening closes the panel: `closeSearch` may change with the panel's own state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (listOpen) closeSearch() }, [listOpen])
  useEffect(() => { if (searchOpen) useReviewStore.getState().setListOpen(false) }, [searchOpen])
  useEffect(() => {
    const review = useReviewStore.getState()
    review.setAvailable(true)
    return () => { review.setAvailable(false); review.endReview() }
  }, [])
  return listOpen
}
