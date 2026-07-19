/**
 * Device-local per-view sort overrides (`viewSortOverrides` in the
 * preferences store): set/clear semantics, no-op referential stability,
 * and the ~20-view recency prune that keeps the record bounded.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { usePreferencesStore } from '../preferences'

const store = () => usePreferencesStore.getState()

beforeEach(() => {
  usePreferencesStore.setState({ viewSortOverrides: {} })
})

describe('preferences — viewSortOverrides', () => {
  it('sets, replaces and clears a layer override', () => {
    store().setViewSortOverride('v1', 'l1', 'alpha-desc')
    expect(store().viewSortOverrides.v1).toEqual({ l1: 'alpha-desc' })
    store().setViewSortOverride('v1', 'l1', 'type-asc')
    expect(store().viewSortOverrides.v1).toEqual({ l1: 'type-asc' })
    store().setViewSortOverride('v1', 'l1', null)
    expect(store().viewSortOverrides.v1).toBeUndefined() // empty view entry pruned
  })

  it('is a state no-op when nothing changes', () => {
    store().setViewSortOverride('v1', 'l1', 'alpha-desc')
    const snapshot = store().viewSortOverrides
    store().setViewSortOverride('v1', 'l1', 'alpha-desc') // same value
    expect(store().viewSortOverrides).toBe(snapshot)
    store().setViewSortOverride('v1', 'l9', null)         // clearing absent key
    expect(store().viewSortOverrides).toBe(snapshot)
  })

  it('clearViewSortOverrides removes only that view', () => {
    store().setViewSortOverride('v1', 'l1', 'alpha-desc')
    store().setViewSortOverride('v2', 'l1', 'count-desc')
    store().clearViewSortOverrides('v1')
    expect(store().viewSortOverrides.v1).toBeUndefined()
    expect(store().viewSortOverrides.v2).toEqual({ l1: 'count-desc' })
  })

  it('prunes the oldest views beyond 20 (touched views survive)', () => {
    for (let i = 0; i < 22; i++) {
      store().setViewSortOverride(`v${i}`, 'l1', 'alpha-desc')
    }
    const keys = Object.keys(store().viewSortOverrides)
    expect(keys).toHaveLength(20)
    expect(keys).not.toContain('v0')
    expect(keys).not.toContain('v1')
    expect(keys).toContain('v21')
  })
})
