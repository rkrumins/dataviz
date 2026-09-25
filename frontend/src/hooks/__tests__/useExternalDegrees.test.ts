/**
 * useExternalDegrees — every card's lineage total, and which ones could not
 * be counted.
 *
 * An answer is kept whatever the canvas does while it is in flight; only a
 * provider switch drops it. A URN the server left out, or whose request
 * failed, is reported as failed and asked again on the hook's own backoff,
 * with no canvas change needed. A pass stops at its first failed chunk. A
 * reader that cannot count (501) is left alone and nothing reads as failed.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStore } from '@/store/canvas'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers', async (original) => ({
  ...(await original<typeof import('@/providers')>()),
  useGraphProvider: () => holder.current,
}))
// The view's lineage types include the roll-up cells' own type, as the
// server's system edge types do.
const LINEAGE = ['FLOWS_TO', 'AGGREGATED']
vi.mock('@/hooks/useViewSchema', () => ({ useViewLineageEdgeTypes: () => LINEAGE }))

import { useExternalDegrees } from '../useExternalDegrees'

type Degrees = Record<string, { in: number; out: number }>

const node = (id: string) => ({ id, type: 'entity', position: { x: 0, y: 0 }, data: { urn: id } })

function seed(version: number, ids: string[]) {
  act(() => {
    useCanvasStore.setState({ nodes: ids.map(node) as never, edges: [], _version: version })
  })
}

const counted = (urns: string[]): Degrees => Object.fromEntries(urns.map(u => [u, { in: 1, out: 2 }]))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const render = (enabled = true) => renderHook(() => useExternalDegrees(enabled))

/** Past the settle debounce, with every promise it starts drained. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(800) })
/** Past the first retry's backoff (2 s, jittered up to +30%). */
const pastFirstRetry = () => act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

beforeEach(() => {
  vi.useFakeTimers()
  seed(1, ['a', 'b', 'logical:group-1'])
})
afterEach(() => {
  vi.useRealTimers()
  act(() => { useCanvasStore.setState({ nodes: [], edges: [] }) })
  holder.current = {}
})

describe('useExternalDegrees — answers are kept', () => {
  it('counts every card once, never a logical group', async () => {
    const getNodeDegrees = vi.fn(async (urns: string[]) => counted(urns))
    holder.current = { getNodeDegrees }

    const { result } = render()
    await settle()
    expect(getNodeDegrees).toHaveBeenCalledTimes(1)
    // Flows by type, never the roll-up cells as flows; whether a container
    // holds cells is asked for on its own.
    expect(getNodeDegrees.mock.calls[0]).toEqual([['a', 'b'], ['FLOWS_TO'], { includeRollups: true }])
    expect(result.current.totals.get('a')).toEqual({ in: 1, out: 2 })
    expect(result.current.failed.size).toBe(0)

    seed(2, ['a', 'b', 'c'])
    await settle()
    expect(getNodeDegrees).toHaveBeenCalledTimes(2)
    expect(getNodeDegrees.mock.calls[1][0]).toEqual(['c'])
  })

  it('an answer that lands after the canvas changed is kept', async () => {
    const pending = deferred<Degrees>()
    const getNodeDegrees = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementation(async (urns: string[]) => counted(urns))
    holder.current = { getNodeDegrees }

    const { result } = render()
    await settle()
    // A page lands while the count is in flight.
    seed(2, ['a', 'b', 'c'])
    await act(async () => { pending.resolve(counted(['a', 'b'])) })
    await settle()
    expect(result.current.totals.get('a')).toEqual({ in: 1, out: 2 })
    expect(result.current.totals.get('b')).toEqual({ in: 1, out: 2 })
  })

  it('the chunks after a canvas change are still asked', async () => {
    const ids = Array.from({ length: 401 }, (_, i) => `n${i}`)
    seed(2, ids)
    const first = deferred<Degrees>()
    const getNodeDegrees = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (urns: string[]) => counted(urns))
    holder.current = { getNodeDegrees }

    const { result } = render()
    await settle()
    expect(getNodeDegrees).toHaveBeenCalledTimes(1)
    seed(3, ids)
    await act(async () => { first.resolve(counted(ids.slice(0, 400))) })
    await settle()
    expect(getNodeDegrees.mock.calls[1][0]).toEqual(['n400'])
    expect(result.current.totals.size).toBe(401)
  })

  it('a provider switch drops answers still in flight', async () => {
    const stale = deferred<Degrees>()
    const before = { getNodeDegrees: vi.fn(() => stale.promise) }
    holder.current = before
    const { result, rerender } = render()
    await settle()

    const after = { getNodeDegrees: vi.fn(async (urns: string[]) => counted(urns)) }
    holder.current = after
    rerender()
    await act(async () => { stale.resolve({ a: { in: 99, out: 99 } }) })
    await settle()
    expect(after.getNodeDegrees).toHaveBeenCalledTimes(1)
    expect(result.current.totals.get('a')).toEqual({ in: 1, out: 2 })
  })
})

describe('useExternalDegrees — roll-up presence', () => {
  it('keeps whether a container holds roll-up cells, and a server that does not say is fine', async () => {
    const getNodeDegrees = vi.fn(async () => ({
      a: { in: 0, out: 0, rollupIn: 0, rollupOut: 1 },
      // A server from before the flag answers flows alone.
      b: { in: 1, out: 2 },
    }))
    holder.current = { getNodeDegrees }

    const { result } = render()
    await settle()
    expect(result.current.totals.get('a')).toEqual({ in: 0, out: 0, rollupIn: 0, rollupOut: 1 })
    expect(result.current.totals.get('b')).toEqual({ in: 1, out: 2 })
    expect(result.current.failed.size).toBe(0)
  })
})

describe('useExternalDegrees — what could not be counted', () => {
  it('a URN the server left out is failed, then asked again on its own', async () => {
    const getNodeDegrees = vi.fn()
      .mockImplementationOnce(async () => counted(['a']))
      .mockImplementation(async (urns: string[]) => counted(urns))
    holder.current = { getNodeDegrees }

    const { result } = render()
    await settle()
    expect(result.current.totals.has('b')).toBe(false)
    expect([...result.current.failed]).toEqual(['b'])

    await pastFirstRetry()
    await settle()
    expect(getNodeDegrees.mock.calls[1][0]).toEqual(['b'])
    expect(result.current.totals.get('b')).toEqual({ in: 1, out: 2 })
    expect(result.current.failed.size).toBe(0)
  })

  it('a failed request is asked again with no canvas change', async () => {
    const getNodeDegrees = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 504 }))
      .mockImplementation(async (urns: string[]) => counted(urns))
    holder.current = { getNodeDegrees }

    const { result } = render()
    await settle()
    expect(getNodeDegrees).toHaveBeenCalledTimes(1)
    expect([...result.current.failed].sort()).toEqual(['a', 'b'])

    await pastFirstRetry()
    await settle()
    expect(getNodeDegrees).toHaveBeenCalledTimes(2)
    expect(result.current.totals.size).toBe(2)
    expect(result.current.failed.size).toBe(0)
  })

  it('a failed chunk stops the pass; the rest are asked on the retry', async () => {
    const ids = Array.from({ length: 401 }, (_, i) => `n${i}`)
    seed(2, ids)
    const getNodeDegrees = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 504 }))
      .mockImplementation(async (urns: string[]) => counted(urns))
    holder.current = { getNodeDegrees }

    const { result } = render()
    await settle()
    expect(getNodeDegrees).toHaveBeenCalledTimes(1)
    expect(result.current.failed.size).toBe(401)

    await pastFirstRetry()
    await settle()
    expect(getNodeDegrees).toHaveBeenCalledTimes(3)
    expect(result.current.totals.size).toBe(401)
    expect(result.current.failed.size).toBe(0)
  })

  it('a reader that cannot count (501) is left alone, and nothing reads as failed', async () => {
    const getNodeDegrees = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { status: 501 }))
    holder.current = { getNodeDegrees }

    const { result } = render()
    await settle()
    expect(getNodeDegrees).toHaveBeenCalledTimes(1)
    seed(2, ['a', 'b', 'c'])
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(getNodeDegrees).toHaveBeenCalledTimes(1)
    expect(result.current.totals.size).toBe(0)
    expect(result.current.failed.size).toBe(0)
  })

  it('asks nothing while off', async () => {
    const getNodeDegrees = vi.fn()
    holder.current = { getNodeDegrees }
    render(false)
    await settle()
    expect(getNodeDegrees).not.toHaveBeenCalled()
  })
})
