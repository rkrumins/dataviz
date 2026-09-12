/**
 * "RETRYING AUTOMATICALLY" HAS TO BE TRUE MORE THAN ONCE.
 *
 * The reconnecting banner offers no Retry button, on the promise that the
 * board asks again by itself. A single timeout does not keep that promise:
 * the retry that comes back `failing_over` sets the SAME stale reason, so
 * nothing re-renders and nothing re-arms — and a cluster failover takes
 * `cluster-node-timeout` plus an election, so that one ask is always too
 * early. The banner would then sit on a board that had stopped asking.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invalidate = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: invalidate }))

import { useFailoverRetry } from '../useFailoverRetry'

beforeEach(() => {
  invalidate.mockClear()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('while the node holding this graph is being replaced', () => {
  it('keeps asking, on a widening gap, for as long as the reason holds', () => {
    renderHook(() => useFailoverRetry('failing_over'))
    expect(invalidate).not.toHaveBeenCalled()          // not on mount

    vi.advanceTimersByTime(3000)
    expect(invalidate).toHaveBeenCalledTimes(1)

    // …and again, which the one-shot version never did.
    vi.advanceTimersByTime(6000)
    expect(invalidate).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(12_000)
    expect(invalidate).toHaveBeenCalledTimes(3)

    // Past the ceiling it settles into a steady poll rather than doubling
    // its way out to hours.
    vi.advanceTimersByTime(30_000 * 4)
    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(6)
  })

  it('stops the moment the store answers again', () => {
    const { rerender, unmount } = renderHook(
      ({ reason }: { reason: string | null }) => useFailoverRetry(reason),
      { initialProps: { reason: 'failing_over' as string | null } },
    )
    vi.advanceTimersByTime(3000)
    expect(invalidate).toHaveBeenCalledTimes(1)

    rerender({ reason: null })
    vi.advanceTimersByTime(60_000)
    expect(invalidate).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('does nothing for any other reason', () => {
    renderHook(() => useFailoverRetry('source_changed'))
    vi.advanceTimersByTime(60_000)
    expect(invalidate).not.toHaveBeenCalled()
  })
})
