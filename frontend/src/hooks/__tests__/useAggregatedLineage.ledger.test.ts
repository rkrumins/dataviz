/**
 * useAggregatedLineage — the pair ledger.
 *
 * The canvas asks for the roll-ups among the rows it draws by passing the same
 * list as sources and targets. It used to re-ask the whole V × V set whenever
 * that list changed: every page that landed, every expand and collapse, sent
 * ceil(V / 500) requests, each carrying all V targets. A pair's answer depends
 * only on that pair, so the hook now keeps what it already knows and asks only
 * the delta: the new rows out to every row, and the rows it kept in to the new
 * ones. Rows that leave take their pairs with them and ask nothing. A new level,
 * a new graph or an invalidation starts over.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers/GraphProviderContext', async (original) => ({
  ...(await original<typeof import('@/providers/GraphProviderContext')>()),
  useGraphProvider: () => holder.current,
}))

import {
  invalidateAggregatedEdges,
  invalidateAggregatedEdgesForScope,
  useAggregatedLineage,
} from '../useAggregatedLineage'

const SCOPE = 'ws:ds:main:'

interface Ask { sourceUrns: string[]; targetUrns?: string[]; granularity: string | null }

const pair = (s: string, t: string) => ({
  id: `agg-${s}-${t}`, sourceUrn: s, targetUrn: t, edgeCount: 1, edgeTypes: ['FLOWS_TO'], confidence: 1, sourceEdgeIds: [],
})

/** A graph whose roll-ups are `flows`: an ask for S × T answers the flows
 *  from S to T, as the server does. `fail` rejects the asks it matches. */
function graph(flows: Array<[string, string]>, fail?: (ask: Ask) => boolean) {
  const asks: Ask[] = []
  const getAggregatedEdges = vi.fn(async (req: Ask) => {
    const ask = { ...req, sourceUrns: [...req.sourceUrns], targetUrns: req.targetUrns && [...req.targetUrns] }
    asks.push(ask)
    if (fail?.(ask)) throw new Error('504 Gateway Timeout')
    const S = new Set(req.sourceUrns)
    const T = new Set(req.targetUrns ?? [])
    return {
      aggregatedEdges: flows.filter(([s, t]) => S.has(s) && T.has(t)).map(([s, t]) => pair(s, t)),
      totalSourceEdges: 0,
    }
  })
  holder.current = { scopeKey: SCOPE, getAggregatedEdges }
  return { asks, flows }
}

/** The ids the server would answer for every pair among `rows`. */
const pairsAmong = (flows: Array<[string, string]>, rows: string[]) => {
  const V = new Set(rows)
  return flows.filter(([s, t]) => V.has(s) && V.has(t)).map(([s, t]) => `agg-${s}-${t}`).sort()
}

const shown = (map: Map<string, unknown>) => [...map.keys()].sort()
const sorted = (urns: string[] | undefined) => [...(urns ?? [])].sort()

function render(granularity: string | null = 'dataset') {
  return renderHook(() => useAggregatedLineage({ granularity }))
}

async function ask(hook: ReturnType<typeof render>, rows: string[]) {
  await act(async () => { await hook.result.current.fetchAggregated(rows, rows) })
}

const FLOWS: Array<[string, string]> = [
  ['a', 'b'], ['b', 'c'], ['c', 'a'], ['d', 'a'], ['b', 'e'], ['e', 'd'], ['c', 'e'],
]

beforeEach(() => {
  // Module cache from another test must not answer this one.
  invalidateAggregatedEdges()
})

describe('useAggregatedLineage — asks only about what changed', () => {
  it('the first ask is the whole set', async () => {
    const g = graph(FLOWS)
    const hook = render()
    await ask(hook, ['a', 'b', 'c'])

    expect(g.asks).toHaveLength(1)
    expect(sorted(g.asks[0].sourceUrns)).toEqual(['a', 'b', 'c'])
    expect(sorted(g.asks[0].targetUrns)).toEqual(['a', 'b', 'c'])
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ['a', 'b', 'c']))
  })

  it('a page that lands asks the new rows out to every row, and the kept rows in to the new ones', async () => {
    const g = graph(FLOWS)
    const hook = render()
    await ask(hook, ['a', 'b', 'c'])
    await ask(hook, ['a', 'b', 'c', 'd', 'e'])

    const delta = g.asks.slice(1).map(a => ({ s: sorted(a.sourceUrns), t: sorted(a.targetUrns) }))
    expect(delta).toEqual([
      { s: ['d', 'e'], t: ['a', 'b', 'c', 'd', 'e'] },
      { s: ['a', 'b', 'c'], t: ['d', 'e'] },
    ])
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ['a', 'b', 'c', 'd', 'e']))
  })

  it('the same rows twice ask nothing', async () => {
    const g = graph(FLOWS)
    const hook = render()
    await ask(hook, ['a', 'b', 'c'])
    await ask(hook, ['c', 'b', 'a'])

    expect(g.asks).toHaveLength(1)
  })

  it('rows that leave take their pairs with them, and ask nothing', async () => {
    const g = graph(FLOWS)
    const hook = render()
    await ask(hook, ['a', 'b', 'c', 'd', 'e'])
    await ask(hook, ['a', 'b', 'd'])

    expect(g.asks).toHaveLength(1)
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ['a', 'b', 'd']))
  })

  it('a row a collapse purged is asked about again when it comes back', async () => {
    const g = graph(FLOWS)
    const hook = render()
    await ask(hook, ['a', 'b', 'c'])
    act(() => hook.result.current.purgeEdgesIncidentToUrns(['c']))
    await ask(hook, ['a', 'b', 'c'])

    const delta = g.asks.slice(1).map(a => ({ s: sorted(a.sourceUrns), t: sorted(a.targetUrns) }))
    expect(delta).toEqual([
      { s: ['c'], t: ['a', 'b', 'c'] },
      { s: ['a', 'b'], t: ['c'] },
    ])
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ['a', 'b', 'c']))
  })

  it('more than 500 new rows go out 500 sources at a time', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => `r${String(i).padStart(4, '0')}`)
    const g = graph([['r0000', 'r1199'], ['r1199', 'r0600']])
    const hook = render()
    await ask(hook, rows)

    expect(g.asks.map(a => a.sourceUrns.length)).toEqual([500, 500, 200])
    for (const a of g.asks) expect(a.targetUrns).toHaveLength(1200)
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(['agg-r0000-r1199', 'agg-r1199-r0600'])
  })
})

describe('useAggregatedLineage — a new level, graph or invalidation starts over', () => {
  it('a new level asks the whole set again, at that level', async () => {
    const g = graph(FLOWS)
    const hook = render()
    await ask(hook, ['a', 'b', 'c'])
    await act(async () => { hook.result.current.setGranularity('system') })
    await vi.waitFor(() => expect(g.asks).toHaveLength(2))

    expect(g.asks[1].granularity).toBe('system')
    expect(sorted(g.asks[1].sourceUrns)).toEqual(['a', 'b', 'c'])
    expect(sorted(g.asks[1].targetUrns)).toEqual(['a', 'b', 'c'])
  })

  it('an invalidation of this graph asks the whole set again', async () => {
    const g = graph(FLOWS)
    const hook = render()
    await ask(hook, ['a', 'b', 'c'])
    act(() => invalidateAggregatedEdgesForScope(SCOPE))
    await ask(hook, ['a', 'b', 'c'])

    expect(g.asks).toHaveLength(2)
    expect(sorted(g.asks[1].sourceUrns)).toEqual(['a', 'b', 'c'])
    expect(sorted(g.asks[1].targetUrns)).toEqual(['a', 'b', 'c'])
  })
})

describe('useAggregatedLineage — the pairs are always those among the rows asked about', () => {
  it('over a run of adds and removes', async () => {
    const universe = Array.from({ length: 24 }, (_, i) => `n${i}`)
    const flows: Array<[string, string]> = []
    // A fixed pseudo-random graph and walk, so a failure reproduces.
    let seed = 7
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (const s of universe) for (const t of universe) if (s !== t && rand() < 0.12) flows.push([s, t])
    const g = graph(flows)
    const hook = render()

    let rows = universe.slice(0, 8)
    await ask(hook, rows)
    for (let step = 0; step < 20; step++) {
      const kept = new Set(rows)
      const next = new Set(rows)
      for (const u of universe) if (rand() < 0.15) { if (next.has(u)) next.delete(u); else next.add(u) }
      if (next.size === 0) next.add(universe[step])
      rows = [...next]
      const before = g.asks.length
      await ask(hook, rows)
      expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(flows, rows))
      // Every ask names a new row: as a source out to every row, or as a
      // target of the kept ones. A kept row is never asked out to all.
      for (const a of g.asks.slice(before)) {
        const outLeg = a.sourceUrns.every(u => !kept.has(u))
        const inLeg = a.targetUrns!.every(u => !kept.has(u))
        expect(outLeg || inLeg).toBe(true)
      }
    }
  })
})

describe('useAggregatedLineage — a failed chunk', () => {
  const rows = Array.from({ length: 700 }, (_, i) => `r${String(i).padStart(4, '0')}`)
  const flows: Array<[string, string]> = [['r0001', 'r0600'], ['r0600', 'r0001'], ['r0650', 'r0002']]

  it('keeps the pairs the other chunks answered', async () => {
    // When its rows are asked again is useAggregatedLineage.retry.test.ts.
    graph(flows, a => a.sourceUrns.includes('r0600'))
    const hook = render()
    await ask(hook, rows)

    // The first chunk answered r0001 → r0600; the second, which holds r0600
    // and r0650, did not.
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(['agg-r0001-r0600'])
  })
})
