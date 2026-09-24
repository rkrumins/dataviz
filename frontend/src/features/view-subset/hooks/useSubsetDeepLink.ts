/**
 * useSubsetDeepLink — `/views/:id?subset=1` opens the view with the Subset
 * Studio started (the Explorer's "Make a subset…").
 *
 * It waits for the canvas to say subsets are OFFERED here — the server's own
 * answer for this reader, which arrives after the view does — and only then
 * acts and drops the parameter, so a link opened a moment early is not lost,
 * and a reader who may not make subsets simply sees the view.
 */
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useSubsetStudioStore } from '../model/studioStore'

export const SUBSET_DEEP_LINK_PARAM = 'subset'

export function useSubsetDeepLink(viewId: string | undefined, offered: boolean, maxHops?: number): void {
  const [params, setParams] = useSearchParams()
  const asked = params.get(SUBSET_DEEP_LINK_PARAM) === '1'

  useEffect(() => {
    if (!asked || !viewId || !offered) return
    const store = useSubsetStudioStore.getState()
    if (store.sourceViewId !== viewId) store.open(viewId, { maxHops })
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete(SUBSET_DEEP_LINK_PARAM)
      return next
    }, { replace: true })
  }, [asked, viewId, offered, maxHops, setParams])
}
