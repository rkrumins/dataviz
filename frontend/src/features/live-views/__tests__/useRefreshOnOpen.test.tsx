/**
 * Opening an auto-updating view brings it up to date: one ask as it opens, and
 * the view is read again only when its members moved. Never for a snapshot, a
 * draft, an ordinary view, or with the preview off.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const refreshMembership = vi.fn()
const getView = vi.fn()
const notify = vi.fn()
let featureOn = true

vi.mock('@/services/liveViewsApi', () => ({
  refreshMembership: (...a: unknown[]) => refreshMembership(...a),
}))
vi.mock('@/services/viewApiService', () => ({
  getView: (id: string) => getView(id),
  viewToViewConfig: (v: unknown) => v,
}))
vi.mock('@/store/features', () => ({ useFeature: () => featureOn }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { useSchemaStore } from '@/store/schema'

import { useRefreshOnOpen } from '../useRefreshOnOpen'

const view = (membership: unknown, extra: Record<string, unknown> = {}) =>
  ({ id: 'v1', name: 'Orders', config: membership ? { membership } : {}, ...extra }) as never

describe('useRefreshOnOpen', () => {
  beforeEach(() => {
    refreshMembership.mockReset()
    getView.mockReset()
    notify.mockReset()
    featureOn = true
  })

  it('asks once as an auto-updating view opens, and reads it again when its members moved', async () => {
    refreshMembership.mockResolvedValue({ outcome: 'applied', diff: { added: 3, removed: 1 }, detail: {}, membership: {} })
    getView.mockResolvedValue({ id: 'v1', name: 'Orders' })
    const added = vi.spyOn(useSchemaStore.getState(), 'addOrUpdateView')
    const { rerender } = renderHook(({ v }) => useRefreshOnOpen(v), { initialProps: { v: view({ v: 1, mode: 'live' }) } })
    rerender({ v: view({ v: 1, mode: 'live' }) })
    await waitFor(() => expect(notify).toHaveBeenCalledWith('info', 'Brought up to date · 3 new, 1 left'))
    expect(refreshMembership).toHaveBeenCalledTimes(1)
    expect(refreshMembership).toHaveBeenCalledWith('v1', false, 'open')
    expect(getView).toHaveBeenCalledWith('v1')
    expect(added).toHaveBeenCalled()
  })

  it('reads nothing again when it was already current', async () => {
    refreshMembership.mockResolvedValue({ outcome: 'current', detail: { reason: 'up_to_date' }, membership: {} })
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    await waitFor(() => expect(refreshMembership).toHaveBeenCalled())
    expect(getView).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it.each([
    ['a snapshot', view({ v: 1, mode: 'snapshot' })],
    ['a draft', view({ v: 1, mode: 'live' }, { draftBranchId: 'b1' })],
    ['an ordinary view', view(null)],
  ])('asks nothing for %s', (_what, v) => {
    renderHook(() => useRefreshOnOpen(v))
    expect(refreshMembership).not.toHaveBeenCalled()
  })

  it('asks nothing with the preview off', () => {
    featureOn = false
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    expect(refreshMembership).not.toHaveBeenCalled()
  })

  it('never fails the page when it can’t ask', async () => {
    refreshMembership.mockRejectedValue(new Error('503'))
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    await waitFor(() => expect(refreshMembership).toHaveBeenCalled())
    expect(notify).not.toHaveBeenCalled()
  })
})
