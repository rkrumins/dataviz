/**
 * useAncestorChains — asks where the lineage ends the canvas does not draw
 * live.
 *
 * Every end that needs it (lineage, not containment; not rendered; not an
 * anchor, which is drawn as its column; not a logical group), from the store's
 * edges and the aggregated roll-ups alike, each asked once. One settle at a
 * time, two chunks in flight, one update per settle. An end the server left
 * out, or whose chunk failed, is asked again on the hook's own backoff; after
 * five attempts its place is given up on. A reader with no containment walk
 * (501) is left alone, and then — like a provider with no chain route, or
 * the hook switched off — there is no chain source. A 403 is asked again on
 * the backoff like any failure.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStore } from '@/store/canvas'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers', async (original) => ({
  ...(await original<typeof import('@/providers')>()),
  useGraphProvider: () => holder.current,
}))

import { NO_PLACE_FOUND, useAncestorChains } from '../useAncestorChains'

const node = (id: string) => ({ id, type: 'entity', position: { x: 0, y: 0 }, data: { urn: id } })
const link = (id: string, source: string, target: string, edgeType = 'FLOWS_TO') =>
  ({ id, source, target, data: { edgeType } })
const isContainment = (t: string) => t === 'CONTAINS'

const PLACED: ReadonlyMap<string, unknown> = new Map([['loaded-a', {}], ['loaded-b', {}]])
const NO_ANCHORS: ReadonlyMap<string, string> = new Map()
const NO_AGG = new Map()
const NO_ROWS: readonly string[] = []

function seed(version: number, edges = [
  link('e1', 'loaded-a', 'far-x'),
  link('e2', 'far-y', 'loaded-b'),
  link('e3', 'loaded-a', 'child-c', 'CONTAINS'),
  link('e4', 'loaded-a', 'logical:group-1'),
], nodes = ['loaded-a', 'loaded-b']) {
  act(() => {
    useCanvasStore.setState({
      nodes: nodes.map(node) as never,
      edges: edges as never,
      _version: version,
    })
  })
}

const answerAll = (urns: string[]) => Object.fromEntries(urns.map(u => [u, ['warehouse']]))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function render(opts: {
  enabled?: boolean
  placed?: ReadonlyMap<string, unknown>
  anchors?: ReadonlyMap<string, string>
  aggregated?: Map<string, unknown>
  unparented?: readonly string[]
} = {}) {
  const placed = opts.placed ?? PLACED
  const anchors = opts.anchors ?? NO_ANCHORS
  const aggregated = (opts.aggregated ?? NO_AGG) as Parameters<typeof useAncestorChains>[4]
  const unparented = opts.unparented ?? NO_ROWS
  const published: Array<ReturnType<typeof useAncestorChains>> = []
  const hook = renderHook(() => {
    const chains = useAncestorChains(opts.enabled ?? true, isContainment, placed, anchors, aggregated, unparented)
    if (published[published.length - 1] !== chains) published.push(chains)
    return chains
  })
  return { ...hook, published }
}

/** Past the settle debounce, with every promise it starts drained. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(300) })

beforeEach(() => { seed(1) })
afterEach(() => {
  vi.useRealTimers()
  act(() => { useCanvasStore.setState({ nodes: [], edges: [] }) })
  holder.current = {}
})

describe('useAncestorChains — what it asks for', () => {
  it('asks once for the unplaced lineage ends, and keeps the answers', async () => {
    const getAncestorChains = vi.fn(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    const { result } = render()
    await waitFor(() => expect(result.current?.get('far-x')).toEqual(['warehouse']))

    expect(getAncestorChains).toHaveBeenCalledTimes(1)
    expect(getAncestorChains.mock.calls[0][0].sort()).toEqual(['far-x', 'far-y'])
  })

  it('does not ask again for an end it already asked about', async () => {
    const getAncestorChains = vi.fn(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    const { result } = render()
    await waitFor(() => expect(result.current?.size).toBe(2))
    seed(2, [link('e1', 'loaded-a', 'far-x'), link('e5', 'loaded-a', 'far-z')])
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(2))
    expect(getAncestorChains.mock.calls[1][0]).toEqual(['far-z'])
  })

  it('asks for an end that is loaded but not rendered', async () => {
    // Loaded as a page's child, then its parent closed: in the store, on no row.
    seed(2, [link('e1', 'loaded-a', 'hidden-c')], ['loaded-a', 'loaded-b', 'hidden-c'])
    const getAncestorChains = vi.fn(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    render()
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(1))
    expect(getAncestorChains.mock.calls[0][0]).toEqual(['hidden-c'])
  })

  it('never asks for a promoted anchor — it is drawn as its column', async () => {
    seed(2, [link('e1', 'loaded-a', 'anchor-y'), link('e2', 'loaded-a', 'far-x')])
    const getAncestorChains = vi.fn(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    render({ anchors: new Map([['anchor-y', 'L2']]) })
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(1))
    expect(getAncestorChains.mock.calls[0][0]).toEqual(['far-x'])
  })

  it('asks for drawn rows whose parent is not loaded: another drawn row may hold them', async () => {
    seed(2, [])
    const getAncestorChains = vi.fn(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    const { result } = render({ unparented: ['loaded-a'] })
    await waitFor(() => expect(result.current?.get('loaded-a')).toEqual(['warehouse']))
    expect(getAncestorChains.mock.calls[0][0]).toEqual(['loaded-a'])
  })

  it('asks for the ends of aggregated roll-ups and their drilled edges', async () => {
    seed(2, [])
    const getAncestorChains = vi.fn(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    render({
      aggregated: new Map([['agg-1', {
        aggregated: { sourceUrn: 'loaded-a', targetUrn: 'agg-far' },
        detailedEdges: [{ sourceUrn: 'det-far', targetUrn: 'loaded-b' }],
      }]]),
    })
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(1))
    expect(getAncestorChains.mock.calls[0][0].sort()).toEqual(['agg-far', 'det-far'])
  })
})

describe('useAncestorChains — pacing', () => {
  const manyEnds = (n: number) => Array.from({ length: n }, (_, i) => link(`e${i}`, 'loaded-a', `far-${i}`))

  it('publishes once per settle, however many chunks it took', async () => {
    vi.useFakeTimers()
    seed(2, manyEnds(600))
    const pending: Array<{ urns: string[]; d: ReturnType<typeof deferred<Record<string, string[]>>> }> = []
    const getAncestorChains = vi.fn((urns: string[]) => {
      const d = deferred<Record<string, string[]>>()
      pending.push({ urns, d })
      return d.promise
    })
    holder.current = { getAncestorChains }

    const { result, published } = render()
    await settle()
    expect(getAncestorChains.mock.calls.map(c => c[0].length)).toEqual([500, 100])

    await act(async () => { pending[0].d.resolve(answerAll(pending[0].urns)) })
    expect(published).toHaveLength(1)   // still the empty map: the settle is not done
    await act(async () => { pending[1].d.resolve(answerAll(pending[1].urns)) })
    expect(published).toHaveLength(2)   // then one update, with everything
    expect(result.current?.size).toBe(600)
  })

  it('keeps at most two requests in flight', async () => {
    vi.useFakeTimers()
    seed(2, manyEnds(1100))
    const pending: Array<ReturnType<typeof deferred<Record<string, string[]>>>> = []
    const getAncestorChains = vi.fn((urns: string[]) => {
      const d = deferred<Record<string, string[]>>()
      pending.push(d)
      void urns
      return d.promise
    })
    holder.current = { getAncestorChains }

    render()
    await settle()
    expect(getAncestorChains).toHaveBeenCalledTimes(2)

    await act(async () => { pending[0].resolve({}) })
    expect(getAncestorChains).toHaveBeenCalledTimes(3)
  })

  it('runs one settle at a time: a change mid-request is asked for after it', async () => {
    vi.useFakeTimers()
    const first = deferred<Record<string, string[]>>()
    const getAncestorChains = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    const { result } = render()
    await settle()
    expect(getAncestorChains).toHaveBeenCalledTimes(1)

    seed(2, [link('e1', 'loaded-a', 'far-x'), link('e2', 'far-y', 'loaded-b'), link('e5', 'loaded-a', 'far-z')])
    await settle()
    expect(getAncestorChains).toHaveBeenCalledTimes(1)

    await act(async () => { first.resolve(answerAll(['far-x', 'far-y'])) })
    await settle()
    expect(getAncestorChains).toHaveBeenCalledTimes(2)
    expect(getAncestorChains.mock.calls[1][0]).toEqual(['far-z'])
    expect(result.current?.size).toBe(3)
  })
})

describe('useAncestorChains — failures', () => {
  it('asks again on its own clock after a failure, with no canvas change', async () => {
    vi.useFakeTimers()
    const getAncestorChains = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 504 }))
      .mockImplementation(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    const { result } = render()
    await settle()
    expect(getAncestorChains).toHaveBeenCalledTimes(1)
    expect(result.current?.has('far-x')).toBe(false)   // pending, not a root

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    await settle()
    expect(getAncestorChains).toHaveBeenCalledTimes(2)
    expect(result.current?.get('far-x')).toEqual(['warehouse'])
  })

  it('asks again for an end the server left out of its answer', async () => {
    vi.useFakeTimers()
    const getAncestorChains = vi.fn()
      .mockImplementationOnce(async () => ({ 'far-x': ['warehouse'] }))
      .mockImplementation(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    const { result } = render()
    await settle()
    expect(result.current?.has('far-y')).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    await settle()
    expect(getAncestorChains.mock.calls[1][0]).toEqual(['far-y'])
    expect(result.current?.get('far-y')).toEqual(['warehouse'])
  })

  it('gives an end up after five attempts: no place found, and not asked again', async () => {
    vi.useFakeTimers()
    const getAncestorChains = vi.fn(async () => ({}))
    holder.current = { getAncestorChains }

    const { result } = render()
    for (let i = 0; i < 12; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    }
    expect(getAncestorChains).toHaveBeenCalledTimes(5)
    expect(result.current?.get('far-x')).toBe(NO_PLACE_FOUND)
    expect(result.current?.get('far-y')).toBe(NO_PLACE_FOUND)
  })

  it('leaves a reader that answers 501 alone, with no chain source', async () => {
    const getAncestorChains = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 501 }))
    holder.current = { getAncestorChains }

    const { result } = render()
    await waitFor(() => expect(result.current).toBeUndefined())
    seed(2)
    await new Promise(r => setTimeout(r, 450))
    expect(getAncestorChains).toHaveBeenCalledTimes(1)
  })

  it('asks again after a 403 on its own clock: a refusal seen once is not for the session', async () => {
    vi.useFakeTimers()
    const getAncestorChains = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
      .mockImplementation(async (urns: string[]) => answerAll(urns))
    holder.current = { getAncestorChains }

    const { result } = render()
    await settle()
    expect(result.current).toBeDefined()
    expect(result.current?.has('far-x')).toBe(false)   // pending, never outside

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    await settle()
    expect(getAncestorChains).toHaveBeenCalledTimes(2)
    expect(result.current?.get('far-x')).toEqual(['warehouse'])
  })

  it('has no chain source when the provider has no chain route', () => {
    holder.current = {}
    const { result } = render()
    expect(result.current).toBeUndefined()
  })

  it('asks nothing while off, and offers no chain source', async () => {
    const getAncestorChains = vi.fn()
    holder.current = { getAncestorChains }
    const { result } = render({ enabled: false })
    await new Promise(r => setTimeout(r, 450))
    expect(getAncestorChains).not.toHaveBeenCalled()
    expect(result.current).toBeUndefined()
  })
})
