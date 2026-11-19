import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useExpandableRows } from '../useExpandableRows'

const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false,
    target: document.body, preventDefault() {}, ...extra }) as never

describe('useExpandableRows', () => {
  it('moves the current row, opens and closes it a level at a time', () => {
    const visited: string[] = []
    const { result } = renderHook(() => useExpandableRows(['a', 'b', 'c'], { onNavigate: (k) => visited.push(k) }))
    expect(result.current.current).toBe('a')
    act(() => result.current.onKeyDown(key('j')))
    expect(result.current.current).toBe('b')
    act(() => result.current.onKeyDown(key('ArrowRight')))
    expect(result.current.levelOf('b')).toBe(1)
    act(() => result.current.onKeyDown(key('ArrowRight')))
    expect(result.current.levelOf('b')).toBe(2)
    act(() => result.current.onKeyDown(key('ArrowLeft')))
    expect(result.current.levelOf('b')).toBe(1)
    act(() => result.current.onKeyDown(key('End')))
    expect(visited).toEqual(['b', 'c'])
  })

  it('opens and closes everything at once, keeping a row set otherwise only until then', () => {
    const { result } = renderHook(() => useExpandableRows(['a', 'b']))
    act(() => result.current.toggle('a'))
    act(() => result.current.onKeyDown(key('ArrowRight', { shiftKey: true })))
    expect([result.current.levelOf('a'), result.current.levelOf('b'), result.current.allOpen]).toEqual([1, 1, true])
    act(() => result.current.onKeyDown(key('ArrowLeft', { shiftKey: true })))
    expect([result.current.levelOf('a'), result.current.levelOf('b')]).toEqual([0, 0])
  })

  it('leaves typing alone, and lets a surface add its own keys', () => {
    const input = document.createElement('input')
    let seen = ''
    const { result } = renderHook(() => useExpandableRows(['a', 'b'], {
      extraKeys: (e, current) => { if (e.key === 'o') { seen = current ?? ''; return true } return false },
    }))
    act(() => result.current.onKeyDown(key('j', { target: input })))
    expect(result.current.current).toBe('a')
    act(() => result.current.onKeyDown(key('o')))
    expect(seen).toBe('a')
  })
})
