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
  const status = await authFetch<MembershipStatus>(base(viewId), { method: 'PUT', body: JSON.stringify(body) })
  invalidate(viewId)
  return status
}

/** Keep entities out, bring them back, always include them, or stop. */
export async function memberOps(viewId: string, ops: MemberOps): Promise<ViewWithMembership> {
  const out = await authFetch<ViewWithMembership>(`${base(viewId)}/members`, { method: 'POST', body: JSON.stringify(ops) })
  invalidate(viewId)
  return out
}

/** Work the members out again now. A large removal waits for `confirmRemovals`. */
export async function refreshMembership(viewId: string, confirmRemovals = false): Promise<RefreshResult> {
  const qs = confirmRemovals ? '?confirmRemovals=true' : ''
  const out = await authFetch<RefreshResult>(`${base(viewId)}/refresh${qs}`, { method: 'POST' })
  invalidate(viewId)
  return out
}
