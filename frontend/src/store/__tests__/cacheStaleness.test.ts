import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCacheStalenessStore } from '../cacheStaleness'

function resetStore() {
  useCacheStalenessStore.getState().reset()
}

describe('cacheStaleness store', () => {
  beforeEach(() => {
    resetStore()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetStore()
  })

  it('markStale + isStale within TTL returns true', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale('ws1', 'ds1', 'children-with-edges')
    expect(useCacheStalenessStore.getState().isStale('ws1', 'ds1')).toBe(true)
  })

  it('isStale clears after the TTL elapses', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale('ws1', 'ds1')
    expect(useCacheStalenessStore.getState().isStale('ws1', 'ds1')).toBe(true)
    // Default TTL is 30s; advance past it.
    vi.advanceTimersByTime(31_000)
    expect(useCacheStalenessStore.getState().isStale('ws1', 'ds1')).toBe(false)
  })

  it('clear removes the entry explicitly', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale('ws1', 'ds1')
    s.clear('ws1', 'ds1')
    expect(useCacheStalenessStore.getState().isStale('ws1', 'ds1')).toBe(false)
  })

  it('scopes are isolated', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale('ws1', 'ds1')
    expect(useCacheStalenessStore.getState().isStale('ws1', 'ds2')).toBe(false)
    expect(useCacheStalenessStore.getState().isStale('ws2', 'ds1')).toBe(false)
  })

  it('isStale returns false when ws or ds is missing', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale('ws1', 'ds1')
    expect(useCacheStalenessStore.getState().isStale(undefined, 'ds1')).toBe(false)
    expect(useCacheStalenessStore.getState().isStale('ws1', undefined)).toBe(false)
  })

  it('markStale ignores missing identifiers (defensive)', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale(undefined, 'ds1')
    s.markStale('ws1', undefined)
    expect(useCacheStalenessStore.getState().entries.size).toBe(0)
  })

  // Regression for P2.1.2: without the auto-clear timer, the banner
  // stays visible past the TTL because Zustand only re-renders on a
  // state mutation. With the timer in place, a setTimeout fires at
  // STALE_TTL_MS and mutates state — subscribers re-render and the
  // banner disappears.
  it('schedules a setTimeout that clears the entry at TTL elapse', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale('ws1', 'ds1')
    expect(useCacheStalenessStore.getState().entries.has('ws1:ds1')).toBe(true)
    // Advance past the default TTL window (30s).
    vi.advanceTimersByTime(31_000)
    // The entry must be gone from state (mutation visible to subscribers),
    // not just rejected by isStale's wall-clock check.
    expect(useCacheStalenessStore.getState().entries.has('ws1:ds1')).toBe(false)
  })

  it('re-marking within TTL refreshes timer without churning state', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale('ws1', 'ds1')
    const firstEntries = useCacheStalenessStore.getState().entries
    // Advance halfway, then re-mark — should coalesce (same Map reference,
    // no spurious render) but reset the timer so the banner stays up.
    vi.advanceTimersByTime(10_000)
    s.markStale('ws1', 'ds1')
    expect(useCacheStalenessStore.getState().entries).toBe(firstEntries)
    // Advance another 20s — original timer would have fired at 30s
    // (already past), but the re-mark reset it; entry still present.
    vi.advanceTimersByTime(20_000)
    expect(useCacheStalenessStore.getState().entries.has('ws1:ds1')).toBe(true)
    // Now advance past the *re-mark's* TTL.
    vi.advanceTimersByTime(20_000)
    expect(useCacheStalenessStore.getState().entries.has('ws1:ds1')).toBe(false)
  })

  it('reset() wipes entries and pending timers', () => {
    const s = useCacheStalenessStore.getState()
    s.markStale('ws1', 'ds1')
    s.markStale('ws2', 'ds2')
    s.reset()
    expect(useCacheStalenessStore.getState().entries.size).toBe(0)
    // Pending timers should have been cancelled — advancing past TTL
    // doesn't re-add anything.
    vi.advanceTimersByTime(60_000)
    expect(useCacheStalenessStore.getState().entries.size).toBe(0)
  })
})
