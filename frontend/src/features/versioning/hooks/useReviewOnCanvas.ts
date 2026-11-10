/**
 * useReviewOnCanvas — what a review does to the Context View canvas, mounted once by it: it draws
 * the review's scope wherever a highlight can (`useDrawScope`), and finds each change the review
 * visits (Locate), saying how that went (`found`).
 *
 * Visits are found one at a time, in order. One overtaken by the next stops at its next step, so
 * going quickly through the list never lands on a change already left.
 */
import { useEffect, useRef } from 'react'
import type { ChangeListRow } from '@/services/versioningApiService'
import { useReviewStore } from '@/store/reviewStore'
import type { LocateOutcome } from '../canvas/useLocateChange'
import { useChangesScope, useDrawScope } from './useChangesScope'

export type Locate = (row: ChangeListRow, stillWanted: () => boolean) => Promise<LocateOutcome>

export function useReviewOnCanvas(viewId: string | null, locate: Locate) {
  const { current } = useChangesScope(viewId)
  const reviewing = useReviewStore((s) => s.navigatorOpen || s.listOpen)
  useDrawScope(current, reviewing)

  const visits = useReviewStore((s) => s.visits)
  const locateRef = useRef(locate)
  useEffect(() => { locateRef.current = locate })
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    const target = useReviewStore.getState().current
    if (!target) return
    let wanted = true
    const stillWanted = () => wanted
    useReviewStore.getState().setFound('looking')
    queue.current = queue.current.then(async () => {
      if (!wanted) return
      const outcome = await locateRef.current(target, stillWanted).catch((): LocateOutcome => 'missing')
      if (wanted) useReviewStore.getState().setFound(outcome)
    })
    return () => { wanted = false }
  }, [visits])
}
