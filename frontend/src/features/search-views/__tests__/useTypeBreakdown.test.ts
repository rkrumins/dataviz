/**
 * useTypeBreakdown — the kinds a would-be subset view holds: one by-type
 * breakdown of what it finds, where it looks, asked a beat after the last change.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Predicate } from '@/types/search'

const searchAdvanced = vi.fn()
const provider = { searchAdvanced }
vi.mock('@/providers', () => ({ useGraphProvider: () => provider }))

import { useTypeBreakdown } from '../useTypeBreakdown'

const pii = { kind: 'tag', values: ['pii'] } as unknown as Predicate
const bucket = (type: string, matchCount: number) =>
  ({ ancestorUrn: '', ancestorDisplayName: type, ancestorEntityType: type, ancestorDepthFromScopeRoot: 0, matchCount })

describe('useTypeBreakdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    searchAdvanced.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('asks nothing until there is a view to ask about', () => {
    const { result } = renderHook(() => useTypeBreakdown(null, pii, false))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current).toEqual({ status: 'idle' })
    expect(searchAdvanced).not.toHaveBeenCalled()
  })

  it('asks for a breakdown by type of what the view finds, where it looks', async () => {
    searchAdvanced.mockResolvedValue({ aggregates: [[bucket('column', 40), bucket('table', 3), bucket('', 5)]] })
    const { result } = renderHook(() => useTypeBreakdown('v-base', pii, true))
    expect(result.current).toEqual({ status: 'loading' })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(searchAdvanced).toHaveBeenCalledTimes(1)
    const [query] = searchAdvanced.mock.calls[0]
    expect(query).toMatchObject({
      predicate: { kind: 'group', op: 'and', children: [pii] },
      scope: { viewId: 'v-base', scopeMode: 'data_source' },
      options: { results: 'aggregates', aggregations: [{ by: 'entityType' }] },
    })
    // A bucket with no kind is no layer.
    expect(result.current).toEqual({ status: 'done', types: [{ type: 'column', count: 40 }, { type: 'table', count: 3 }] })
  })

  it('a newer question aborts the older one', async () => {
    searchAdvanced.mockResolvedValue({ aggregates: [[bucket('table', 1)]] })
    const { rerender } = renderHook(({ within }) => useTypeBreakdown('v-base', pii, within), { initialProps: { within: false } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    const firstSignal = searchAdvanced.mock.calls[0][1].signal as AbortSignal
    rerender({ within: true })
    expect(firstSignal.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(searchAdvanced.mock.calls[1][0].scope).toEqual({ viewId: 'v-base', scopeMode: 'data_source' })
  })

  it('says when the kinds can’t be found', async () => {
    searchAdvanced.mockRejectedValue(new Error('busy'))
    const { result } = renderHook(() => useTypeBreakdown('v-base', pii, false))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(result.current).toEqual({ status: 'error' })
  })
})
