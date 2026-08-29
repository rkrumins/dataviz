/**
 * Per-user, per-view connection-type visibility store (Connections panel,
 * Phase 1 — task P2). One localStorage key, many views, keyed by view id —
 * never written into the view definition. See
 * .superpowers/sdd/connections-panel-phase1/task-P2-brief.md.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CONNECTION_VISIBILITY_STORAGE_KEY,
  useConnectionVisibilityStore,
  useConnectionVisibility,
} from '../connectionVisibility'

describe('connectionVisibility', () => {
  beforeEach(() => {
    useConnectionVisibilityStore.setState({ hiddenByView: {} })
    window.localStorage.clear()
  })

  it('hidden types are per view — hiding in one view leaves another untouched', () => {
    const v1 = renderHook(() => useConnectionVisibility('v1'))
    const v2 = renderHook(() => useConnectionVisibility('v2'))

    act(() => v1.result.current.toggle('FLOWS_TO'))

    expect(v1.result.current.hiddenTypes.has('FLOWS_TO')).toBe(true)
    expect(v2.result.current.hiddenTypes.has('FLOWS_TO')).toBe(false)
  })

  it('toggle adds then removes, and uppercases whatever casing it is given', () => {
    const { result } = renderHook(() => useConnectionVisibility('v1'))

    act(() => result.current.toggle('flows_to'))
    expect(result.current.hiddenTypes.has('FLOWS_TO')).toBe(true)
    expect(result.current.isHidden('flows_to')).toBe(true)

    act(() => result.current.toggle('FLOWS_TO'))
    expect(result.current.hiddenTypes.has('FLOWS_TO')).toBe(false)
    expect(result.current.hiddenTypes.size).toBe(0)
  })

  it('solo hides every other type and leaves the soloed one visible', () => {
    const { result } = renderHook(() => useConnectionVisibility('v1'))

    act(() => result.current.solo('b', ['A', 'B', 'C']))

    expect(result.current.hiddenTypes.has('A')).toBe(true)
    expect(result.current.hiddenTypes.has('C')).toBe(true)
    expect(result.current.hiddenTypes.has('B')).toBe(false)
    expect(result.current.hiddenTypes.size).toBe(2)
  })

  it('solo over a single type hides nothing', () => {
    const { result } = renderHook(() => useConnectionVisibility('v1'))

    act(() => result.current.solo('A', ['A']))

    expect(result.current.hiddenTypes.size).toBe(0)
  })

  it('showAll deletes the view entry rather than storing an empty list', () => {
    const { result } = renderHook(() => useConnectionVisibility('v1'))

    act(() => result.current.toggle('A'))
    expect('v1' in useConnectionVisibilityStore.getState().hiddenByView).toBe(true)

    act(() => result.current.showAll())
    expect('v1' in useConnectionVisibilityStore.getState().hiddenByView).toBe(false)
    expect(result.current.hiddenTypes.size).toBe(0)
  })

  it('an empty viewId reads empty and never writes a bucket', () => {
    const { result } = renderHook(() => useConnectionVisibility(''))

    expect(result.current.hiddenTypes.size).toBe(0)

    act(() => result.current.toggle('A'))
    expect(result.current.hiddenTypes.size).toBe(0)
    expect('' in useConnectionVisibilityStore.getState().hiddenByView).toBe(false)

    act(() => result.current.solo('A', ['A', 'B']))
    expect('' in useConnectionVisibilityStore.getState().hiddenByView).toBe(false)

    act(() => result.current.showAll())
    expect('' in useConnectionVisibilityStore.getState().hiddenByView).toBe(false)
  })

  it('hiddenTypes keeps a stable Set identity across re-renders while the stored list is unchanged', () => {
    useConnectionVisibilityStore.getState().setHidden('v1', ['A'])

    const { result, rerender } = renderHook(() => useConnectionVisibility('v1'))
    const first = result.current.hiddenTypes

    rerender()

    expect(result.current.hiddenTypes).toBe(first)
  })

  it('a corrupted stored payload rehydrates as nothing hidden', async () => {
    window.localStorage.setItem(
      CONNECTION_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ state: { hiddenByView: { v1: 'NOT_AN_ARRAY' } } })
    )

    await useConnectionVisibilityStore.persist.rehydrate()

    expect(useConnectionVisibilityStore.getState().hiddenByView.v1).toBeUndefined()

    const { result } = renderHook(() => useConnectionVisibility('v1'))
    expect(result.current.hiddenTypes.size).toBe(0)
  })
})
