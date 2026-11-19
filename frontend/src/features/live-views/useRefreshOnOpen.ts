/**
 * Opening an auto-updating view brings it up to date — there is no background
 * worker. The view page asks once, as it opens; the server reads nothing from the
 * graph unless the data or the view's query changed since it was last worked
 * out, lets one opener do it while the others wait on it, and leaves a held
 * removal for an editor. Only when the members moved is the view read again.
 */
import { useEffect } from 'react'

import { useAppNotifications } from '@/components/ui/notifications'
import { SUBSET_FOLLOW_MAX_MS, SUBSET_FOLLOW_MIN_MS } from '@/hooks/useGraphHydration'
import { refreshMembership } from '@/services/liveViewsApi'
import { getView, viewToViewConfig, type View } from '@/services/viewApiService'
import { useCanvasStore } from '@/store/canvas'
import { useFeature } from '@/store/features'
import { useSchemaStore } from '@/store/schema'

import { diffText } from './model'

/** The canvas reads the view from the schema store: hand it the view as it now is. */
export async function showLatest(viewId: string) {
  const fresh = await getView(viewId).catch(() => null)
  if (fresh) useSchemaStore.getState().addOrUpdateView(viewToViewConfig(fresh))
}

export function useRefreshOnOpen(view: View | null | undefined): void {
  const enabled = useFeature('viewMembershipEnabled')
  const { notify } = useAppNotifications()
  const membership = view?.config?.membership as { mode?: string } | undefined
  const live = !!membership && (membership.mode ?? 'live') === 'live' && !view?.draftBranchId
  const viewId = view?.id
  useEffect(() => {
    if (!enabled || !live || !viewId) return
    let cancelled = false
    let timer: number | undefined
    // A large view is worked out a step at a time: while the server says it is
    // still running, ask again — backing off, jittered, so a view opened by
    // hundreds is not asked in a loop — until it lands.
    const ask = (round: number) => {
      refreshMembership(viewId, false, 'open')
        .then(async (out) => {
          if (cancelled) return
          if (out.outcome === 'running') {
            const wait = Math.min(SUBSET_FOLLOW_MAX_MS, SUBSET_FOLLOW_MIN_MS * 2 ** round)
            timer = window.setTimeout(() => ask(round + 1), wait * (0.75 + Math.random() * 0.5))
            return
          }
          if (out.outcome !== 'applied') return
          await showLatest(viewId)
          // Its layers page their members from the server: read them again.
          useCanvasStore.getState().refreshSubsetFeeds()
          notify('info', `Brought up to date · ${diffText(out.diff)}`)
        })
        // How it stands is the chip's to say: opening a view never fails on this.
        .catch(() => {})
    }
    ask(0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [enabled, live, viewId, notify])
}
