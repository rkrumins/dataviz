import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getReadiness = vi.fn()
const invalidateAggregatedEdges = vi.fn()

vi.mock('@/services/aggregationService', () => ({
  aggregationService: { getReadiness: (...a: unknown[]) => getReadiness(...a) },
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({
  invalidateAggregatedEdges: () => invalidateAggregatedEdges(),
}))

import { useSourceChangedRefresh } from '../useSourceChangedRefresh'

/**
 * useSourceChangedRefresh keeps the canvas from re-serving a cached stale
 * rollup forever: while `source_changed`, it polls the cheap readiness
 * endpoint and invalidates the aggregated cache ONCE the rebuild completes so
 * the banner self-clears. These lock the poll's contract.
 */
describe('useSourceChangedRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getReadiness.mockReset()
    invalidateAggregatedEdges.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('does not poll when the overlay is not source_changed', async () => {
    getReadiness.mockResolvedValue({ isReady: true, aggregationStatus: 'ready' })
    renderHook(() => useSourceChangedRefresh('ds-1', null, 1000))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(getReadiness).not.toHaveBeenCalled()
  })

  it('does not poll without a data source id', async () => {
    getReadiness.mockResolvedValue({ isReady: true, aggregationStatus: 'ready' })
    renderHook(() => useSourceChangedRefresh(null, 'source_changed', 1000))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(getReadiness).not.toHaveBeenCalled()
  })

  it('invalidates exactly once on the not-ready → ready transition', async () => {
    getReadiness
      .mockResolvedValueOnce({ isReady: false, aggregationStatus: 'running' })
      .mockResolvedValue({ isReady: true, aggregationStatus: 'ready' })

    renderHook(() => useSourceChangedRefresh('ds-1', 'source_changed', 1000))

    // mount check → running (prevReady=false); tick @1000 → ready ⇒ invalidate;
    // tick @2000 → ready again ⇒ no second invalidate.
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })

    expect(invalidateAggregatedEdges).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate while the rebuild is still running', async () => {
    getReadiness.mockResolvedValue({ isReady: false, aggregationStatus: 'running' })
    renderHook(() => useSourceChangedRefresh('ds-1', 'source_changed', 1000))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(getReadiness.mock.calls.length).toBeGreaterThan(1)
    expect(invalidateAggregatedEdges).not.toHaveBeenCalled()
  })

  it('stops polling after a failed rebuild (banner stays, no spin)', async () => {
    getReadiness.mockResolvedValue({ isReady: false, aggregationStatus: 'failed' })
    renderHook(() => useSourceChangedRefresh('ds-1', 'source_changed', 1000))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })  // mount check → failed → stop
    const afterFailed = getReadiness.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(getReadiness.mock.calls.length).toBe(afterFailed)
    expect(invalidateAggregatedEdges).not.toHaveBeenCalled()
  })

  it('stops polling on unmount', async () => {
    getReadiness.mockResolvedValue({ isReady: false, aggregationStatus: 'running' })
    const { unmount } = renderHook(() => useSourceChangedRefresh('ds-1', 'source_changed', 1000))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const beforeUnmount = getReadiness.mock.calls.length
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(getReadiness.mock.calls.length).toBe(beforeUnmount)
  })
})
