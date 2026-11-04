/**
 * A refused edit reads the view again: refused because someone else changed it
 * (409), the hash the edit was sent with is stale, and every later try would be
 * refused too until the page was reloaded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock('../apiClient', () => ({ authFetch }))

import { queryClient } from '@/lib/queryClient'
import { putSearch, SEARCH_VIEW_QUERY_KEY } from '../searchViewsApi'
import { MEMBERSHIP_QUERY_KEY, memberOps, putMembership } from '../liveViewsApi'

describe('a refused edit', () => {
  beforeEach(() => {
    authFetch.mockReset()
    vi.restoreAllMocks()
  })

  it('reads the subset view again, so the next try has the hash stored now', async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    authFetch.mockRejectedValue(Object.assign(new Error('changed'), { status: 409 }))
    await expect(putSearch('v1', { ifDefinitionHash: 'old', layout: 'own' })).rejects.toThrow('changed')
    expect(spy).toHaveBeenCalledWith({ queryKey: [SEARCH_VIEW_QUERY_KEY, 'v1'] })
  })

  it("reads the list view's membership again", async () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    authFetch.mockRejectedValue(Object.assign(new Error('changed'), { status: 409 }))
    await expect(putMembership('v2', { ifDefinitionHash: 'old', mode: 'snapshot' })).rejects.toThrow()
    await expect(memberOps('v2', { exclude: ['urn:x'] })).rejects.toThrow()
    expect(spy.mock.calls.filter(([arg]) => JSON.stringify(arg) === JSON.stringify({ queryKey: [MEMBERSHIP_QUERY_KEY, 'v2'] })))
      .toHaveLength(2)
  })
})
