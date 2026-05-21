import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCacheStalenessStore } from '../cacheStaleness'

function resetStore() {
  useCacheStalenessStore.setState({ entries: new Map() })
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
})
