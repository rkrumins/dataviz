/**
 * viewDuplicateApi — a copy of a view, made by the server (`POST /api/v1/views/{id}/duplicate`),
 * so every kind of view is copied whole: an ordinary view copies its layout; a view made from a
 * query is made again from the same definition and layout, its members worked out afresh (its
 * copy can come back still `updating`); a subset keeps its search.
 *
 * One `Idempotency-Key` for the whole copy: a view made from a query whose sources reach a lot
 * is worked out a step at a time — the server answers 202 and makes nothing until it is
 * complete — so the same ask goes again, with the same key, and carries on.
 */
import { queryClient } from '@/lib/queryClient'
import { isResolving, type MembershipResolving, type MembershipStatus } from '@/types/membership'

import { authFetch } from './apiClient'
import { httpStatusOf, isTransientFailure, patientDelayMs } from './graphRequestFailure'
import { pause, RESOLVE_MAX_ASKS } from './liveViewsApi'
import type { View } from './viewApiService'

export interface DuplicateViewRequest {
  /** Unset: the server names it. */
  name?: string
  /** Unset: only its maker can see it. */
  visibility?: 'private' | 'workspace'
  /** Unset: the view's own workspace. */
  workspaceId?: string
}

export interface DuplicatedView {
  view: View
  /** A view made from a query: how working out the copy's members is going. */
  membership?: MembershipStatus | null
}

export async function duplicateView(viewId: string, body: DuplicateViewRequest): Promise<DuplicatedView> {
  const key = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  let failures = 0
  let resolving = false
  for (let n = 0; n < RESOLVE_MAX_ASKS; n++) {
    let out: DuplicatedView | MembershipResolving
    try {
      out = await authFetch<DuplicatedView | MembershipResolving>(`/api/v1/views/${encodeURIComponent(viewId)}/duplicate`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Idempotency-Key': key },
      })
    } catch (err) {
      // Asked again through a slow or busy server only once it is working the copy out under
      // this key: an ordinary view's copy isn't kept by its key, so asking again could make two.
      if (!resolving || !isTransientFailure(err)) throw err
      await pause(patientDelayMs(err, failures++))
      continue
    }
    failures = 0
    if (isResolving(out)) { resolving = true; continue }
    // A new view: the lists, their counts and their facets.
    void queryClient.invalidateQueries({ queryKey: ['views'] })
    void queryClient.invalidateQueries({ queryKey: ['explorer-views'] })
    return out
  }
  throw new Error('Still working out what it reaches — try again later.')
}

/** Why a copy wasn't made, in plain words: the server's own for a copy it can't make as asked. */
export function duplicateRefusal(err: unknown): string {
  const message = err instanceof Error ? err.message : ''
  switch (httpStatusOf(err)) {
    case 403: return 'You can’t make views where this one lives, so it can’t be copied there.'
    case 404: return 'This view is gone, or you can no longer open it.'
    case 422: return message || 'This view can’t be copied as it is.'
    default: return message || 'The copy couldn’t be made. Try again.'
  }
}
