/**
 * Opening a view made from a query brings it up to date: one ask as it opens, and
 * the view is read again only when its members moved. It keeps asking while the
 * server is still working, and through a server that was slow or busy; it stops on
 * a refusal, and waits while the tab is hidden. Never for a draft, an ordinary
 * view, or with the preview off.
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

  it('a large view still being worked out is asked again until its new members are in', async () => {
    refreshMembership
      .mockResolvedValueOnce({ outcome: 'running', detail: {}, membership: {} })
      .mockResolvedValueOnce({ outcome: 'applied', diff: { added: 40_000, removed: 0 }, detail: {}, membership: {} })
    getView.mockResolvedValue({ id: 'v1', name: 'Orders' })
    const { useCanvasStore } = await import('@/store/canvas')
    const before = useCanvasStore.getState().subsetRefreshNonce
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('info', expect.stringMatching(/^Brought up to date/)), { timeout: 4000 })
    expect(refreshMembership).toHaveBeenCalledTimes(2)
    // Its layers page their members from the server: they are read again.
    expect(useCanvasStore.getState().subsetRefreshNonce).toBe(before + 1)
  })

  it('reads nothing again when it was already current', async () => {
    refreshMembership.mockResolvedValue({ outcome: 'current', detail: { reason: 'up_to_date' }, membership: {} })
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    await waitFor(() => expect(refreshMembership).toHaveBeenCalled())
    expect(getView).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a snapshot is asked too: its first answer, still being worked out, carries on', async () => {
    refreshMembership.mockResolvedValue({ outcome: 'current', detail: { reason: 'snapshot' }, membership: {} })
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'snapshot' })))
    await waitFor(() => expect(refreshMembership).toHaveBeenCalledWith('v1', false, 'open'))
  })

  it('waits on someone else’s run, and shows what it found when it lands', async () => {
    refreshMembership
      .mockResolvedValueOnce({ outcome: 'busy', detail: {}, membership: { revision: 3 } })
      .mockResolvedValueOnce({ outcome: 'current', detail: { reason: 'up_to_date' }, membership: { revision: 4 } })
    getView.mockResolvedValue({ id: 'v1', name: 'Orders' })
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    await waitFor(() => expect(getView).toHaveBeenCalledWith('v1'), { timeout: 4000 })
    expect(refreshMembership).toHaveBeenCalledTimes(2)
  })

  it('asks again through a server that was slow or busy, as long as it said', async () => {
    refreshMembership
      .mockRejectedValueOnce(Object.assign(new Error('timed out'), { status: 504, retryAfterMs: 20 }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 429, retryAfterMs: 20 }))
      .mockResolvedValueOnce({ outcome: 'current', detail: { reason: 'up_to_date' }, membership: {} })
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    await waitFor(() => expect(refreshMembership).toHaveBeenCalledTimes(3))
    expect(notify).not.toHaveBeenCalled()
  })

  it('stops on a refusal', async () => {
    refreshMembership.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }))
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    await waitFor(() => expect(refreshMembership).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 120))
    expect(refreshMembership).toHaveBeenCalledTimes(1)
  })

  it('a hidden tab waits, and asks as soon as it is looked at', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    refreshMembership
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503, retryAfterMs: 10 }))
      .mockResolvedValue({ outcome: 'current', detail: { reason: 'up_to_date' }, membership: {} })
    renderHook(() => useRefreshOnOpen(view({ v: 1, mode: 'live' })))
    await waitFor(() => expect(refreshMembership).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 80))
    expect(refreshMembership).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(refreshMembership).toHaveBeenCalledTimes(2))
    visibility.mockRestore()
  })

  it.each([
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
