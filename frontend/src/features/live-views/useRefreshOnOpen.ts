/**
 * Opening a view made from a query brings it up to date — there is no background
 * worker. The view page asks as it opens; the server reads nothing from the graph
 * unless the data or the view's query changed since it was last worked out, lets
 * one opener do it while the others wait on it, and leaves a held removal for an
 * editor. Only when the members moved is the view read again.
 *
 * A large view is worked out a turn at a time, so this keeps asking — backing off,
 * jittered — while the server says it is still working (its own run or someone
 * else's), and never gives up on a server that was slow, busy or briefly away: it
 * waits as long as the server said, or a growing pause, and asks again. It stops on
 * a refusal, when the page closes, and waits while the tab is hidden.
 *
 * While it waits on someone else's run, the canvas still reads the view's status
 * every few seconds: a new revision seen there shows the new members at once,
 * rather than at this page's next ask.
 */
import { useEffect } from 'react'

import { useAppNotifications } from '@/components/ui/notifications'
import { SUBSET_FOLLOW_MAX_MS, SUBSET_FOLLOW_MIN_MS } from '@/hooks/useGraphHydration'
import { queryClient } from '@/lib/queryClient'
import { isTransientFailure, patientDelayMs } from '@/services/graphRequestFailure'
import { MEMBERSHIP_QUERY_KEY, refreshMembership } from '@/services/liveViewsApi'
import { getView, viewToViewConfig, type View } from '@/services/viewApiService'
import { useCanvasStore } from '@/store/canvas'
import { useFeature } from '@/store/features'
import { useSchemaStore } from '@/store/schema'
import type { MembershipStatus } from '@/types/membership'

import { diffText } from './model'

/** The canvas reads the view from the schema store, the header from its query: hand both
 *  the view as it now is, in one read. */
export async function showLatest(viewId: string) {
  const fresh = await getView(viewId).catch(() => null)
  if (!fresh) return
  queryClient.setQueryData(['view', viewId], fresh)
  useSchemaStore.getState().addOrUpdateView(viewToViewConfig(fresh))
}

/** Its members moved: the view as it is, and its layers' pages read again — in place. */
async function showMoved(viewId: string) {
  await showLatest(viewId)
  useCanvasStore.getState().refreshSubsetFeeds()
}

export function useRefreshOnOpen(view: View | null | undefined): void {
  const enabled = useFeature('viewMembershipEnabled')
  const { notify } = useAppNotifications()
  // A snapshot is asked too: the server answers at once unless its first answer is still
  // being worked out, which then carries on.
  const madeFromQuery = !!view?.config?.membership && !view?.draftBranchId
  const viewId = view?.id
  useEffect(() => {
    if (!enabled || !madeFromQuery || !viewId) return
    let cancelled = false
    let timer: number | undefined
    let seenRevision: number | undefined
    let onVisible: (() => void) | null = null
    // The members moved: shown once, however it is learnt — this page's answer, or the
    // status the canvas reads while this page waits.
    let landed = false
    const moved = async () => {
      if (landed || cancelled) return
      landed = true
      window.clearTimeout(timer)
      await showMoved(viewId)
    }
    const unwatch = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryKey[0] !== MEMBERSHIP_QUERY_KEY || event.query.queryKey[1] !== viewId) return
      const status = event.query.state.data as MembershipStatus | undefined
      if (seenRevision !== undefined && status && status.status !== 'updating' && status.revision > seenRevision) void moved()
    })
    const later = (ms: number, next: () => void) => {
      timer = window.setTimeout(() => {
        // A hidden tab waits: asked again as soon as it is looked at.
        if (document.visibilityState === 'hidden') {
          onVisible = () => {
            if (document.visibilityState !== 'visible') return
            document.removeEventListener('visibilitychange', onVisible!)
            onVisible = null
            if (!cancelled) next()
          }
          document.addEventListener('visibilitychange', onVisible)
          return
        }
        next()
      }, ms)
    }
    const ask = (round: number, failures: number) => {
      refreshMembership(viewId, false, 'open')
        .then(async (out) => {
          if (cancelled) return
          const revision = out.membership?.revision
          if (out.outcome === 'running' || out.outcome === 'busy') {
            if (landed) return
            const wait = Math.min(SUBSET_FOLLOW_MAX_MS, SUBSET_FOLLOW_MIN_MS * 2 ** round)
            if (seenRevision === undefined) seenRevision = revision
            later(wait * (0.75 + Math.random() * 0.5), () => ask(round + 1, 0))
            return
          }
          if (out.outcome === 'applied') {
            await moved()
            notify('info', `Brought up to date · ${diffText(out.diff)}`)
            return
          }
          // Someone else's run landed while this page waited on it: show what it found.
          if (seenRevision !== undefined && revision !== undefined && revision > seenRevision) await moved()
        })
        .catch((err: unknown) => {
          if (cancelled || landed || !isTransientFailure(err)) return
          later(patientDelayMs(err, failures), () => ask(round, failures + 1))
        })
    }
    ask(0, 0)
    return () => {
      cancelled = true
      unwatch()
      window.clearTimeout(timer)
      if (onVisible) document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, madeFromQuery, viewId, notify])
}
