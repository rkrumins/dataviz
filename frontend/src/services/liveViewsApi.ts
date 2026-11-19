/**
 * liveViewsApi — views made from a query (`/api/v1/views/from-members`,
 * `/api/v1/views/{id}/membership`). The contract is `@/types/membership`; the
 * preview (`POST /{ws}/graph/members/plan`) goes through the graph provider,
 * like every other graph read.
 */
import {
  isResolving,
  type FromMembersRequest,
  type MemberOps,
  type MembershipResolving,
  type MembershipStatus,
  type MembershipUpdate,
  type RefreshResult,
} from '@/types/membership'
import { queryClient } from '@/lib/queryClient'

import { authFetch } from './apiClient'
import { isTransientFailure, patientDelayMs } from './graphRequestFailure'
import type { View } from './viewApiService'

export interface ViewWithMembership {
  view: View
  membership: MembershipStatus
}

/** The query key of a view's membership status. */
export const MEMBERSHIP_QUERY_KEY = 'view-membership'

const base = (viewId: string) => `/api/v1/views/${encodeURIComponent(viewId)}/membership`

function invalidate(viewId: string) {
  void queryClient.invalidateQueries({ queryKey: [MEMBERSHIP_QUERY_KEY, viewId] })
  void queryClient.invalidateQueries({ queryKey: ['view', viewId] })
}

/** A backstop, not a budget: at ten seconds an ask, about five hours. */
const RESOLVE_MAX_ASKS = 2_000

/** Wait `ms`, or less if `signal` aborts (then reject as the fetch would). */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Make a view from one or more queries. `idempotencyKey` makes a retry return
 *  the view the first attempt made, never a second one. A large set is worked
 *  out a step at a time: the server answers 202 with its progress and makes
 *  nothing until it is complete, so the same ask is sent again — reported to
 *  `onProgress` — until the view is made; it answers as soon as the view
 *  exists, with its members still being worked out (`membership.status`
 *  `updating`). A server that didn't answer in time, was busy or briefly away,
 *  or a dropped connection is asked again as it was — the same key, so never a
 *  second view — after its `Retry-After` or a growing pause (`onRetry`). */
export async function createFromMembers(
  body: FromMembersRequest,
  idempotencyKey: string,
  onProgress?: (resolving: MembershipResolving) => void,
  opts: { onRetry?: (inMs: number) => void; signal?: AbortSignal } = {},
): Promise<ViewWithMembership> {
  let failures = 0
  for (let n = 0; n < RESOLVE_MAX_ASKS; n++) {
    let out: ViewWithMembership | MembershipResolving
    try {
      out = await authFetch<ViewWithMembership | MembershipResolving>('/api/v1/views/from-members', {
        method: 'POST',
        // The server's own wait applies (10 s, then 202): sent by no client, so a server
        // from before it took one still answers.
        body: JSON.stringify(body),
        headers: { 'Idempotency-Key': idempotencyKey },
        signal: opts.signal,
      })
    } catch (err) {
      if (opts.signal?.aborted || !isTransientFailure(err)) throw err
      const inMs = patientDelayMs(err, failures++)
      opts.onRetry?.(inMs)
      await pause(inMs, opts.signal)
      continue
    }
    failures = 0
    if (!isResolving(out)) return out
    onProgress?.(out)
  }
  throw new Error('Still working out what it reaches — try again later.')
}

/** What the view is made of, and how keeping it up to date is going. */
export async function getMembershipStatus(viewId: string): Promise<MembershipStatus> {
  return authFetch<MembershipStatus>(base(viewId))
}

/** Change the queries, freeze or resume — against the hash the definition was read at. */
export async function putMembership(viewId: string, body: MembershipUpdate): Promise<MembershipStatus> {
  try {
    return await authFetch<MembershipStatus>(base(viewId), { method: 'PUT', body: JSON.stringify(body) })
  } finally {
    // Read again either way: a refusal (someone else's edit, 409) leaves the hash stale.
    invalidate(viewId)
  }
}

/** Keep entities out, bring them back, always include them, or stop. */
export async function memberOps(viewId: string, ops: MemberOps): Promise<ViewWithMembership> {
  try {
    return await authFetch<ViewWithMembership>(`${base(viewId)}/members`, { method: 'POST', body: JSON.stringify(ops) })
  } finally {
    invalidate(viewId)
  }
}

/** Work the members out again now. A large removal waits for `confirmRemovals`. */
/** Work the view's members out again. `trigger: 'open'` — the view was opened: anyone who can
 *  read it may ask, and nothing is read unless its data or query changed (`current` otherwise). */
export async function refreshMembership(
  viewId: string, confirmRemovals = false, trigger: 'manual' | 'open' = 'manual',
): Promise<RefreshResult> {
  const params = new URLSearchParams()
  if (confirmRemovals) params.set('confirmRemovals', 'true')
  if (trigger === 'open') params.set('trigger', 'open')
  const qs = params.toString() ? `?${params}` : ''
  const out = await authFetch<RefreshResult>(`${base(viewId)}/refresh${qs}`, { method: 'POST' })
  if (trigger === 'open') {
    // The status it answers with is the chip's, without asking again; when the members moved,
    // the opener reads the view once itself (`showLatest`).
    queryClient.setQueryData([MEMBERSHIP_QUERY_KEY, viewId], out.membership)
  } else {
    invalidate(viewId)
  }
  return out
}
