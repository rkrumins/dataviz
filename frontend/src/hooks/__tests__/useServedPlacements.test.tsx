/**
 * Where a view the server places draws what a trace reaches: asked once per entity in
 * batches, again through a slow or busy server, and not at all where the server can't place
 * for this view (the canvas then places as it always has).
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const viewPlacements = vi.fn()
vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => ({ viewPlacements }) }))

import { useServedPlacements } from '../useServedPlacements'

const answer = (urns: string[], layer = 'tables') => ({
  placements: Object.fromEntries(urns.map((u) => [u, { layerId: layer, source: 'member' }])), epoch: 1, dataVersion: 'd', digest: 'x',
})

describe('useServedPlacements', () => {
  beforeEach(() => { viewPlacements.mockReset() })

  it('asks for what it holds, once, in sorted batches — and is empty until answered', async () => {
    viewPlacements.mockImplementation(async (_v: string, urns: string[]) => answer(urns))
    const urns = Array.from({ length: 2500 }, (_, i) => `u${String(i).padStart(4, '0')}`)
    const { result, rerender } = renderHook((p: { urns: string[] }) =>
      useServedPlacements({ viewId: 'v1', active: true, urns: p.urns, resetKey: 'a' }), { initialProps: { urns } })
    await waitFor(() => expect(result.current?.size).toBe(2500))
    expect(viewPlacements).toHaveBeenCalledTimes(2)
    expect(viewPlacements.mock.calls[0][1]).toHaveLength(2000)
    rerender({ urns: [...urns] })
    expect(viewPlacements).toHaveBeenCalledTimes(2)
    expect(result.current?.get('u0001')).toBe('tables')
  })

  it('asks again through a busy server, and not at all where it can’t place for this view', async () => {
    viewPlacements
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 429, retryAfterMs: 10 }))
      .mockImplementation(async (_v: string, urns: string[]) => answer(urns, 'bi'))
    const { result } = renderHook(() => useServedPlacements({ viewId: 'v1', active: true, urns: ['a'], resetKey: 'x' }))
    await waitFor(() => expect(result.current?.get('a')).toBe('bi'))
    viewPlacements.mockReset()
    viewPlacements.mockRejectedValue(Object.assign(new Error('not served'), { status: 422 }))
    const plain = renderHook(() => useServedPlacements({ viewId: 'v2', active: true, urns: ['a'], resetKey: 'y' }))
    await waitFor(() => expect(plain.result.current).toBeUndefined())
  })

  it('asks nothing while no trace is on', () => {
    const { result } = renderHook(() => useServedPlacements({ viewId: 'v1', active: false, urns: ['a'], resetKey: 'x' }))
    expect(result.current).toBeUndefined()
    expect(viewPlacements).not.toHaveBeenCalled()
  })
})
