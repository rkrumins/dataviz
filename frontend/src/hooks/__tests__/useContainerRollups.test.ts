/**
 * useContainerRollups — every roll-up of a selected collapsed container.
 *
 * Out: the cells from it, no target named. In: the cells into it, no source
 * named. Kept while the container is drawn closed; another graph or level
 * starts empty; an invalidation keeps them until a fresh answer replaces
 * them. A leg the server refuses — an older server cannot answer the
 * in-direction — costs only that leg.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers/GraphProviderContext', async (original) => ({
  ...(await original<typeof import('@/providers/GraphProviderContext')>()),
  useGraphProvider: () => holder.current,
}))

import { invalidateAggregatedEdges, invalidateAggregatedEdgesForScope } from '../useAggregatedLineage'
import { useContainerRollups } from '../useContainerRollups'

const SCOPE = 'ws:ds:main:'

interface Ask { sourceUrns: string[]; targetUrns?: string[]; granularity: string | null }

const cell = (s: string, t: string, edgeCount = 2) => ({
  id: `agg-${s}-${t}`, sourceUrn: s, targetUrn: t, edgeCount, edgeTypes: ['FLOWS_TO'], confidence: 1, sourceEdgeIds: [],
})

/** A graph whose roll-ups are `flows`. An ask naming no targets answers
 *  every flow from its sources; one naming no sources, every flow into its
 *  targets. `fail` rejects the asks it matches. */
function graph(flows: Array<[string, string]>, opts: { scopeKey?: string; fail?: (ask: Ask) => boolean } = {}) {
  const asks: Ask[] = []
  const getAggregatedEdges = vi.fn(async (req: Ask) => {
    asks.push({ ...req, sourceUrns: [...req.sourceUrns], targetUrns: req.targetUrns && [...req.targetUrns] })
    if (opts.fail?.(req)) throw new Error('422 Unprocessable Entity')
    const S = new Set(req.sourceUrns)
    const T = req.targetUrns ? new Set(req.targetUrns) : null
    return {
      aggregatedEdges: flows
        .filter(([s, t]) => (S.size === 0 ? !!T : S.has(s)) && (!T || T.has(t)))
        .map(([s, t]) => cell(s, t)),
      totalSourceEdges: 0,
    }
  })
  holder.current = { scopeKey: opts.scopeKey ?? SCOPE, getAggregatedEdges }
  return asks
}

const shown = (map: ReadonlyMap<string, unknown>) => [...map.keys()].sort()
const always = () => true

function render(granularity: string | null = 'dataset') {
  return renderHook(({ g }) => useContainerRollups(g), { initialProps: { g: granularity } })
}

async function ask(
  hook: ReturnType<typeof render>,
  asks: { out?: string[]; in?: string[] },
  kept: (urn: string) => boolean = always,
) {
  await act(async () => { await hook.result.current.fetchContainerRollups({ out: asks.out ?? [], in: asks.in ?? [] }, kept) })
}

const FLOWS: Array<[string, string]> = [['C', 's9'], ['C', 'far'], ['up', 'C'], ['D', 'x']]

afterEach(() => { invalidateAggregatedEdges() })

describe('useContainerRollups — what it asks', () => {
  it('out names no target, in names no source, and both answers are shown', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, { out: ['C'], in: ['C'] })
    expect(asks).toEqual([
      { sourceUrns: ['C'], targetUrns: undefined, granularity: 'dataset' },
      { sourceUrns: [], targetUrns: ['C'], granularity: 'dataset' },
    ])
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far', 'agg-C-s9', 'agg-up-C'])
  })

  it('several containers go in one ask each way', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, { out: ['C', 'D'] })
    expect(asks.map(a => a.sourceUrns)).toEqual([['C', 'D']])
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far', 'agg-C-s9', 'agg-D-x'])
  })

  it('asks nothing it has been answered', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, { out: ['C'] })
    asks.length = 0
    await ask(hook, { out: ['C'] })
    expect(asks).toEqual([])
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far', 'agg-C-s9'])
  })
})

describe('useContainerRollups — what it keeps', () => {
  it('an in-direction the server refuses costs only that leg, and is asked again next time', async () => {
    let refusing = true
    const asks = graph(FLOWS, { fail: a => refusing && a.sourceUrns.length === 0 })
    const hook = render()
    await ask(hook, { out: ['C'], in: ['C'] })
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far', 'agg-C-s9'])

    refusing = false
    asks.length = 0
    await ask(hook, { out: ['C'], in: ['C'] })
    expect(asks).toEqual([{ sourceUrns: [], targetUrns: ['C'], granularity: 'dataset' }])
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far', 'agg-C-s9', 'agg-up-C'])
  })

  it('a container no longer drawn closed takes its cells, and asks nothing', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, { out: ['C', 'D'] })
    asks.length = 0
    await ask(hook, {}, urn => urn !== 'C')
    expect(asks).toEqual([])
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-D-x'])
  })

  it('another graph starts empty at once, with nothing to ask', async () => {
    graph(FLOWS)
    const hook = render()
    await ask(hook, { out: ['C'] })
    graph(FLOWS, { scopeKey: 'ws:ds:draft-1:' })
    hook.rerender({ g: 'dataset' })
    await ask(hook, {})
    expect(hook.result.current.containerEdges.size).toBe(0)
  })

  it('another level starts empty and asks again', async () => {
    const asks = graph(FLOWS)
    const hook = render('dataset')
    await ask(hook, { out: ['C'] })
    asks.length = 0
    hook.rerender({ g: 'schema' })
    await ask(hook, { out: ['C'] })
    expect(asks).toEqual([{ sourceUrns: ['C'], targetUrns: undefined, granularity: 'schema' }])
  })

  it('an answer for a graph it has left is never shown', async () => {
    let release!: () => void
    const late = new Promise<void>(r => { release = r })
    const getAggregatedEdges = vi.fn(async () => {
      await late
      return { aggregatedEdges: [cell('C', 's9')], totalSourceEdges: 0 }
    })
    holder.current = { scopeKey: SCOPE, getAggregatedEdges }
    const hook = render()
    let first!: Promise<void>
    act(() => { first = hook.result.current.fetchContainerRollups({ out: ['C'], in: [] }, always) })

    graph([], { scopeKey: 'ws:ds:draft-1:' })
    hook.rerender({ g: 'dataset' })
    await ask(hook, {})
    await act(async () => { release(); await first })
    expect(hook.result.current.containerEdges.size).toBe(0)
  })

  it('an invalidation asks again, and keeps the cells until a fresh answer replaces them', async () => {
    const flows: Array<[string, string]> = [['C', 's9']]
    let failing = false
    const asks = graph(flows, { fail: () => failing })
    const hook = render()
    await ask(hook, { out: ['C'] })

    failing = true
    act(() => invalidateAggregatedEdgesForScope(SCOPE))
    hook.rerender({ g: 'dataset' })
    asks.length = 0
    await ask(hook, { out: ['C'] })
    expect(asks).toHaveLength(1)
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-s9'])

    failing = false
    flows.splice(0, 1, ['C', 'far'])
    await ask(hook, { out: ['C'] })
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far'])
  })
})
