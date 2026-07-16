import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useDebouncedValue } from './useDebouncedValue'

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 250))
    expect(result.current).toBe('a')
  })

  it('only settles on the latest value after the delay', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    })
    rerender({ v: 'ab' })
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe('a')
    rerender({ v: 'abc' })
    act(() => vi.advanceTimersByTime(249))
    expect(result.current).toBe('a')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe('abc')
  })
})
