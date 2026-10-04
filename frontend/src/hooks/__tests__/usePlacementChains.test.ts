/**
 * usePlacementChains — the containment chains the placement contract climbs for loaded entities
 * whose parent is not loaded. Chunks of 500, two at a time; each URN asked once; an unanswered one
 * asked again on the next change, five asks at most; a reader with no containment walk (501) left
 * alone; a provider switch forgets everything, late answers included.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers', async (original) => ({
  ...(await original<typeof import('@/providers')>()),
  useGraphProvider: () => holder.current,
}))

import { usePlacementChains } from '../usePlacementChains'

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const urnsOf = (n: number, prefix = 'u') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
const rootChains = (urns: string[]) => Object.fromEntries(urns.map(u => [u, ['root']]))

function mount(initial: readonly string[]) {
  return renderHook(({ urns }: { urns: readonly string[] }) => usePlacementChains(urns), { initialProps: { urns: initial } })
}

describe('usePlacementChains', () => {
  it('asks in chunks of 500, at most two requests at a time', async () => {
    let inFlight = 0
    let peak = 0
    const getAncestorChains = vi.fn(async (urns: string[]) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
      return rootChains(urns)
    })
    holder.current = { getAncestorChains }
    const { result } = mount(urnsOf(1200))
    await waitFor(() => expect(result.current.size).toBe(1200))
    expect(getAncestorChains.mock.calls.map(([urns]) => urns.length)).toEqual([500, 500, 200])
    expect(peak).toBe(2)
    expect(result.current.get('u7')).toEqual(['root'])
  })

  it('asks each URN once across renders, and asks again for one the provider left out, five times at most', async () => {
    const getAncestorChains = vi.fn(async (urns: string[]) =>
      Object.fromEntries(urns.filter(u => u !== 'b').map(u => [u, []])))
    holder.current = { getAncestorChains }
    const { result, rerender } = mount(['a', 'b'])
    await waitFor(() => expect(result.current.has('a')).toBe(true))
    expect(result.current.has('b')).toBe(false)                  // unknown, not a root

    rerender({ urns: ['a', 'b', 'c'] })
    await waitFor(() => expect(result.current.has('c')).toBe(true))
    expect(getAncestorChains.mock.calls.map(([urns]) => urns)).toEqual([['a', 'b'], ['b', 'c']])

    // Each change asks it again until it has been asked five times; then it is left unknown.
    for (let i = 0; i < 4; i++) {
      rerender({ urns: ['a', 'b', 'c'] })
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(getAncestorChains.mock.calls.map(([urns]) => urns)).toEqual([['a', 'b'], ['b', 'c'], ['b'], ['b'], ['b']])
    expect(result.current.has('b')).toBe(false)
  })

  it('stops asking a reader with no containment walk (501)', async () => {
    const getAncestorChains = vi.fn(async () => { throw Object.assign(new Error('no walk'), { status: 501 }) })
    holder.current = { getAncestorChains }
    const { result, rerender } = mount(['a'])
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(1))
    rerender({ urns: ['a', 'b'] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(getAncestorChains).toHaveBeenCalledTimes(1)
    expect(result.current.size).toBe(0)
  })

  it('asks a failed chunk again on the next change', async () => {
    const getAncestorChains = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
      .mockImplementation(async (urns: string[]) => rootChains(urns))
    holder.current = { getAncestorChains }
    const { result, rerender } = mount(['a'])
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(1))
    rerender({ urns: ['a'] })
    await waitFor(() => expect(result.current.get('a')).toEqual(['root']))
  })

  it('forgets everything on a provider switch, and drops the old provider\'s late answer', async () => {
    const late = deferred<Record<string, string[]>>()
    const first = { getAncestorChains: vi.fn(() => late.promise) }
    holder.current = first
    const urns = ['a']
    const { result, rerender } = mount(urns)
    await waitFor(() => expect(first.getAncestorChains).toHaveBeenCalledTimes(1))

    const second = { getAncestorChains: vi.fn(async (asked: string[]) => Object.fromEntries(asked.map(u => [u, ['other']]))) }
    holder.current = second
    rerender({ urns })
    await waitFor(() => expect(result.current.get('a')).toEqual(['other']))
    expect(second.getAncestorChains).toHaveBeenCalledWith(['a'])

    late.resolve({ a: ['stale'] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(result.current.get('a')).toEqual(['other'])
  })

  it('asks nothing of a provider without the bulk chain route', async () => {
    holder.current = {}
    const { result } = mount(['a'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(result.current.size).toBe(0)
  })
})
