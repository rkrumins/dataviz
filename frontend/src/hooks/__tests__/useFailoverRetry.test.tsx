/**
 * "RETRYING AUTOMATICALLY" HAS TO BE TRUE MORE THAN ONCE — AND MUST NOT BE A
 * FLEET-SYNCHRONISED STORM.
 *
 * The reconnecting banner offers no Retry button, on the promise that the
 * board asks again by itself. A single timeout does not keep that promise:
 * the retry that comes back `failing_over` sets the SAME stale reason, so
 * nothing re-renders and nothing re-arms — and a cluster failover takes
 * `cluster-node-timeout` plus an election, so that one ask is always too
 * early. The banner would then sit on a board that had stopped asking.
 *
 * The other half is that this arms on a SHARED condition. One node rotating
 * puts every viewer of every graph on that shard into `failing_over` inside
 * the same second, so an unjittered 3s/6s/12s ladder is every one of them
 * asking at the same instants, at a node mid-election. These tests pin the
 * jitter, the cap, the hidden-tab pause, and — the expensive one — that the
 * ask is scoped to the provider that is failing over rather than dropping
 * every mounted canvas's aggregated edges.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invalidateScope = vi.hoisted(() => vi.fn())
const invalidateAll = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useAggregatedLineage', () => ({
  invalidateAggregatedEdgesForScope: invalidateScope,
  invalidateAggregatedEdges: invalidateAll,
}))

import { POLLING_INTERVALS, PROVIDER_RETRY_MAX_ATTEMPTS } from '@/config/polling'
import { useFailoverRetry } from '../useFailoverRetry'

const SCOPE = 'ws1:ds1:main:'

/** No jitter, so the ladder's instants are readable. The jitter itself is
 *  asserted separately — pinning both at once pins neither. */
function noJitter() {
  vi.spyOn(Math, 'random').mockReturnValue(0)
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

beforeEach(() => {
  invalidateScope.mockClear()
  invalidateAll.mockClear()
  setHidden(false)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('while the node holding this graph is being replaced', () => {
  it('keeps asking, on a widening gap, for as long as the reason holds', () => {
    noJitter()
    renderHook(() => useFailoverRetry('failing_over', SCOPE))
    expect(invalidateScope).not.toHaveBeenCalled()          // not on mount

    vi.advanceTimersByTime(3000)
    expect(invalidateScope).toHaveBeenCalledTimes(1)

    // …and again, which the one-shot version never did.
    vi.advanceTimersByTime(6000)
    expect(invalidateScope).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(12_000)
    expect(invalidateScope).toHaveBeenCalledTimes(3)
  })

  it('jitters every delay, so a shard full of viewers does not ask in lockstep', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)             // the top of the band
    renderHook(() => useFailoverRetry('failing_over', SCOPE))

    // Unjittered this fired at exactly 3000, on every client at once.
    vi.advanceTimersByTime(3000)
    expect(invalidateScope).not.toHaveBeenCalled()
    vi.advanceTimersByTime(900)                             // 3000 * 1.3
    expect(invalidateScope).toHaveBeenCalledTimes(1)
  })

  it('caps the fast attempts and settles onto the slow background cadence', () => {
    noJitter()
    renderHook(() => useFailoverRetry('failing_over', SCOPE))

    // Run the whole fast ladder out: 3s, then the doubling to the 30s ceiling.
    vi.advanceTimersByTime(3000)
    for (let i = 1; i <= PROVIDER_RETRY_MAX_ATTEMPTS; i++) {
      vi.advanceTimersByTime(Math.min(3000 * 2 ** i, 30_000))
    }
    const afterFast = invalidateScope.mock.calls.length
    expect(afterFast).toBe(PROVIDER_RETRY_MAX_ATTEMPTS + 1)

    // Past the cap it is the slow floor, not the 30s loop that used to run
    // for the life of the tab.
    vi.advanceTimersByTime(30_000)
    expect(invalidateScope).toHaveBeenCalledTimes(afterFast)
    vi.advanceTimersByTime(POLLING_INTERVALS.providerRetrySlow - 30_000)
    expect(invalidateScope).toHaveBeenCalledTimes(afterFast + 1)
  })

  it('asks nothing while the tab is hidden, and resumes when it is not', () => {
    noJitter()
    setHidden(true)
    renderHook(() => useFailoverRetry('failing_over', SCOPE))

    vi.advanceTimersByTime(3000 + 6000 + 12_000)
    expect(invalidateScope).not.toHaveBeenCalled()

    setHidden(false)
    vi.advanceTimersByTime(24_000)
    expect(invalidateScope).toHaveBeenCalledTimes(1)
  })

  it('drops only the failing provider, never every mounted canvas', () => {
    noJitter()
    renderHook(() => useFailoverRetry('failing_over', SCOPE))
    vi.advanceTimersByTime(3000)

    expect(invalidateScope).toHaveBeenCalledWith(SCOPE)
    // The global drop makes every canvas refetch POST /graph/edges/aggregated
    // — the most expensive endpoint there is, and a POST, so no client cache
    // absorbs it. One shard rotating must not cost the whole tab that.
    expect(invalidateAll).not.toHaveBeenCalled()
  })

  it('stops the moment the store answers again', () => {
    noJitter()
    const { rerender, unmount } = renderHook(
      ({ reason }: { reason: string | null }) => useFailoverRetry(reason, SCOPE),
      { initialProps: { reason: 'failing_over' as string | null } },
    )
    vi.advanceTimersByTime(3000)
    expect(invalidateScope).toHaveBeenCalledTimes(1)

    rerender({ reason: null })
    vi.advanceTimersByTime(120_000)
    expect(invalidateScope).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('does nothing for any other reason', () => {
    noJitter()
    renderHook(() => useFailoverRetry('source_changed', SCOPE))
    vi.advanceTimersByTime(120_000)
    expect(invalidateScope).not.toHaveBeenCalled()
  })
})
