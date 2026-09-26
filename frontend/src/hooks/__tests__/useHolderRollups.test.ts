/**
 * useHolderRollups — roll-ups into the rows the view holds but has not loaded.
 *
 * Beside the rows' own roll-ups, the canvas asks about each HOLDER (an anchor
 * with rows past its page, an open container with children not loaded)
 * against its rows, both ways, in a request of its own. Asked as a delta: new
 * rows against every holder, the rows already asked against a new holder;
 * whatever leaves takes its cells and asks nothing. A failed or cut-short ask
 * is asked again on the hook's own backoff, five rounds at most.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers/GraphProviderContext', async (original) => ({
  ...(await original<typeof import('@/providers/GraphProviderContext')>()),
  useGraphProvider: () => holder.current,
}))

import { invalidateAggregatedEdges, invalidateAggregatedEdgesForScope } from '../useAggregatedLineage'
import { useHolderRollups } from '../useHolderRollups'

interface Ask { sourceUrns: string[]; targetUrns?: string[]; granularity: string | null }

const cell = (s: string, t: string) => ({
  id: `agg-${s}-${t}`, sourceUrn: s, targetUrn: t, edgeCount: 2, edgeTypes: ['FLOWS_TO'], confidence: 1, sourceEdgeIds: [],
})

/** A graph whose roll-ups are `flows`: an ask for S × T answers the flows
 *  from S to T. `fail` rejects, and `cut` truncates, the asks it matches. */
function graph(flows: Array<[string, string]>, opts: { fail?: (ask: Ask) => boolean; cut?: (ask: Ask) => boolean; scopeKey?: string } = {}) {
  const asks: Ask[] = []
  const getAggregatedEdges = vi.fn(async (req: Ask) => {
    const ask = { ...req, sourceUrns: [...req.sourceUrns], targetUrns: [...(req.targetUrns ?? [])] }
    asks.push(ask)
    if (opts.fail?.(ask)) throw new Error('504 Gateway Timeout')
    const S = new Set(req.sourceUrns)
    const T = new Set(req.targetUrns ?? [])
    return {
      aggregatedEdges: flows.filter(([s, t]) => S.has(s) && T.has(t)).map(([s, t]) => cell(s, t)),
      totalSourceEdges: 0,
      truncated: opts.cut?.(ask) ?? false,
    }
  })
  holder.current = { scopeKey: opts.scopeKey ?? 'ws:ds:main:', getAggregatedEdges }
  return asks
}

const pairsOf = (asks: Ask[]) => asks.map(a => `${[...a.sourceUrns].sort().join(',')} > ${[...(a.targetUrns ?? [])].sort().join(',')}`).sort()
const shown = (map: ReadonlyMap<string, unknown>) => [...map.keys()].sort()

function render(granularity: string | null = null) {
  return renderHook(({ g }) => useHolderRollups(g), { initialProps: { g: granularity } })
}

async function ask(hook: ReturnType<typeof render>, rows: string[], holders: string[]) {
  await act(async () => { await hook.result.current.fetchHolders(rows, holders) })
}

const FLOWS: Array<[string, string]> = [['r1', 'A'], ['A', 'r2'], ['r3', 'B'], ['r1', 'r2']]

afterEach(() => {
  vi.useRealTimers()
  invalidateAggregatedEdges()
})

describe('useHolderRollups — what it asks', () => {
  it('asks the rows against the holders, both ways, and shows the cells', async () => {
    const asks = graph(FLOWS)
    const hook = render('dataset')
    await ask(hook, ['r1', 'r2'], ['A'])
    expect(pairsOf(asks)).toEqual(['A > r1,r2', 'r1,r2 > A'])
    expect(asks.every(a => a.granularity === 'dataset')).toBe(true)
    // The rows' own pair (r1 → r2) is not the holders' to answer.
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2', 'agg-r1-A'])
  })

  it('asks nothing while there are no holders', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, ['r1', 'r2'], [])
    expect(asks).toEqual([])
    expect(hook.result.current.holderEdges.size).toBe(0)
  })

  it('sends the rows 500 at a time', async () => {
    const asks = graph([])
    const hook = render()
    const rows = Array.from({ length: 1200 }, (_, i) => `r${i}`)
    await ask(hook, rows, ['A'])
    expect(asks.filter(a => a.targetUrns?.[0] === 'A').map(a => a.sourceUrns.length)).toEqual([500, 500, 200])
    expect(asks.filter(a => a.sourceUrns[0] === 'A').map(a => a.targetUrns?.length)).toEqual([500, 500, 200])
  })
})

describe('useHolderRollups — asks only what changed', () => {
  it('a new row is asked against every holder, and nothing else', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, ['r1', 'r2'], ['A', 'B'])
    asks.length = 0
    await ask(hook, ['r1', 'r2', 'r3'], ['A', 'B'])
    expect(pairsOf(asks)).toEqual(['A,B > r3', 'r3 > A,B'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2', 'agg-r1-A', 'agg-r3-B'])
  })

  it('a new holder is asked against the rows already asked', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, ['r1', 'r3'], ['A'])
    asks.length = 0
    await ask(hook, ['r1', 'r3'], ['A', 'B'])
    expect(pairsOf(asks)).toEqual(['B > r1,r3', 'r1,r3 > B'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-r1-A', 'agg-r3-B'])
  })

  it('a holder or a row that leaves takes its cells, and asks nothing', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, ['r1', 'r2', 'r3'], ['A', 'B'])
    asks.length = 0
    await ask(hook, ['r1', 'r2', 'r3'], ['A'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2', 'agg-r1-A'])
    await ask(hook, ['r2', 'r3'], ['A'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2'])
    expect(asks).toEqual([])
  })

  it('a new level starts over', async () => {
    const asks = graph(FLOWS)
    const hook = render('dataset')
    await ask(hook, ['r1', 'r2'], ['A'])
    asks.length = 0
    hook.rerender({ g: 'schema' })
    await ask(hook, ['r1', 'r2'], ['A'])
    expect(pairsOf(asks)).toEqual(['A > r1,r2', 'r1,r2 > A'])
    expect(asks.every(a => a.granularity === 'schema')).toBe(true)
  })
})

describe('useHolderRollups — failures', () => {
  it('asks a failed ask again on its own clock, and keeps what the rest answered', async () => {
    vi.useFakeTimers()
    let failing = true
    const asks = graph(FLOWS, { fail: a => failing && a.sourceUrns.includes('r3') })
    const hook = render()
    await ask(hook, ['r1', 'r2', 'r3'], ['A', 'B'])
    // The rows' out leg failed; the in leg's answer stays.
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2'])

    failing = false
    asks.length = 0
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(pairsOf(asks)).toEqual(['A,B > r1,r2,r3', 'r1,r2,r3 > A,B'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2', 'agg-r1-A', 'agg-r3-B'])
  })

  it('asks a cut-short answer again, keeping what it did say', async () => {
    vi.useFakeTimers()
    let cutting = true
    const asks = graph(FLOWS, { cut: () => cutting })
    const hook = render()
    await ask(hook, ['r1'], ['A'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-r1-A'])

    cutting = false
    asks.length = 0
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(pairsOf(asks)).toEqual(['A > r1', 'r1 > A'])
  })

  it('stops after five rounds, until the next change', async () => {
    vi.useFakeTimers()
    const asks = graph(FLOWS, { fail: () => true })
    const hook = render()
    await ask(hook, ['r1'], ['A'])
    for (let i = 0; i < 12; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    }
    expect(asks).toHaveLength(5 * 2)
  })
})

describe('useHolderRollups — a graph the canvas has left', () => {
  it('a switch to another graph drops the old cells at once, with nothing to ask', async () => {
    graph(FLOWS)
    const hook = render('dataset')
    await ask(hook, ['r1', 'r2'], ['A'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2', 'agg-r1-A'])

    graph([], { scopeKey: 'ws:ds:draft-1:' })
    hook.rerender({ g: 'dataset' })
    await ask(hook, ['r1', 'r2'], [])
    expect(shown(hook.result.current.holderEdges)).toEqual([])
  })

  it("an answer for a graph it has left is never shown", async () => {
    const release: Array<() => void> = []
    holder.current = {
      scopeKey: 'ws:ds:main:',
      getAggregatedEdges: vi.fn((req: Ask) => new Promise(resolve => {
        release.push(() => resolve({
          aggregatedEdges: req.sourceUrns.includes('r1') ? [cell('r1', 'A')] : [], totalSourceEdges: 0,
        }))
      })),
    }
    const hook = render('dataset')
    let first!: Promise<void>
    act(() => { first = hook.result.current.fetchHolders(['r1'], ['A']) })

    // The canvas moves to a draft with no holders while main's answer is out.
    graph([], { scopeKey: 'ws:ds:draft-1:' })
    hook.rerender({ g: 'dataset' })
    act(() => { void hook.result.current.fetchHolders(['r1'], []) })
    await act(async () => { while (release.length) release.shift()!(); await first })
    expect(shown(hook.result.current.holderEdges)).toEqual([])
  })
})

describe('useHolderRollups — an invalidation', () => {
  it('asks again, and a resync that fails keeps the cells it had', async () => {
    let failing = false
    const asks = graph(FLOWS, { fail: () => failing })
    const hook = render()
    await ask(hook, ['r1', 'r2'], ['A'])

    failing = true
    act(() => invalidateAggregatedEdgesForScope('ws:ds:main:'))
    hook.rerender({ g: null })
    asks.length = 0
    await ask(hook, ['r1', 'r2'], ['A'])
    expect(pairsOf(asks)).toEqual(['A > r1,r2', 'r1,r2 > A'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2', 'agg-r1-A'])
  })

  it('a fresh answer still drops a cell it no longer names', async () => {
    const flows: Array<[string, string]> = [['r1', 'A'], ['A', 'r2']]
    graph(flows)
    const hook = render()
    await ask(hook, ['r1', 'r2'], ['A'])

    flows.splice(0, 1)
    act(() => invalidateAggregatedEdgesForScope('ws:ds:main:'))
    hook.rerender({ g: null })
    await ask(hook, ['r1', 'r2'], ['A'])
    expect(shown(hook.result.current.holderEdges)).toEqual(['agg-A-r2'])
  })
})
