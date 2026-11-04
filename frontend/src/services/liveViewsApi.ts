/**
 * liveViewsApi — views made from a query (`/api/v1/views/from-members`,
 * `/api/v1/views/{id}/membership`). The contract is `@/types/membership`; the
 * preview (`POST /{ws}/graph/members/plan`) goes through the graph provider,
 * like every other graph read.
 */
import type {
  FromMembersRequest,
  MemberOps,
  MembershipStatus,
  MembershipUpdate,
  RefreshResult,
} from '@/types/membership'
import { queryClient } from '@/lib/queryClient'

import { authFetch } from './apiClient'
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

/** Make a view from one or more queries. `idempotencyKey` makes a retry return
 *  the view the first attempt made, never a second one. */
export async function createFromMembers(body: FromMembersRequest, idempotencyKey: string): Promise<ViewWithMembership> {
  return authFetch<ViewWithMembership>('/api/v1/views/from-members', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Idempotency-Key': idempotencyKey },
  })
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
  if (trigger === 'open' && out.outcome !== 'applied') {
    // Nothing moved: the status it answers with is the chip's, without asking again.
    queryClient.setQueryData([MEMBERSHIP_QUERY_KEY, viewId], out.membership)
  } else {
    invalidate(viewId)
  }
  return out
}
