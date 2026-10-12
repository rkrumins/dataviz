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
import { CONTAINER_CELLS_CAP, useContainerRollups } from '../useContainerRollups'

const SCOPE = 'ws:ds:main:'

interface Ask { sourceUrns: string[]; targetUrns?: string[]; granularity: string | null; excludeInternal?: boolean }

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
  inside?: (container: string, far: string) => boolean,
) {
  await act(async () => { await hook.result.current.fetchContainerRollups({ out: asks.out ?? [], in: asks.in ?? [] }, kept, inside) })
}

const FLOWS: Array<[string, string]> = [['C', 's9'], ['C', 'far'], ['up', 'C'], ['D', 'x']]

afterEach(() => { invalidateAggregatedEdges() })

describe('useContainerRollups — what it asks', () => {
  it('out names no target, in names no source, and both answers are shown', async () => {
    const asks = graph(FLOWS)
    const hook = render()
    await ask(hook, { out: ['C'], in: ['C'] })
    // The server leaves out the cells between a container and what it
    // holds, or what holds it.
    expect(asks).toEqual([
      { sourceUrns: ['C'], targetUrns: undefined, granularity: 'dataset', excludeInternal: true },
      { sourceUrns: [], targetUrns: ['C'], granularity: 'dataset', excludeInternal: true },
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

describe('useContainerRollups — how much it keeps', () => {
  it('drops the cells to what the container holds, or what holds it', async () => {
    graph([['C', 'C.t1'], ['up', 'C'], ['C', 's9'], ['x', 'C']])
    const hook = render()
    const inside = (container: string, far: string) => far === `${container}.t1` || far === 'up'
    await ask(hook, { out: ['C'], in: ['C'] }, always, inside)
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-s9', 'agg-x-C'])
    expect(hook.result.current.containerPartial.out.size + hook.result.current.containerPartial.in.size).toBe(0)
  })

  it('keeps the strongest cells of a leg, and says it holds that way only in part', async () => {
    const flows = Array.from({ length: CONTAINER_CELLS_CAP + 1 }, (_, i): [string, string] => ['C', `p${i}`])
    graph(flows)
    const getAggregatedEdges = (holder.current as { getAggregatedEdges: (req: Ask) => Promise<{ aggregatedEdges: ReturnType<typeof cell>[] }> }).getAggregatedEdges
    // The weakest is the last.
    holder.current = {
      ...holder.current,
      getAggregatedEdges: async (req: Ask) => {
        const answer = await getAggregatedEdges(req)
        return { ...answer, aggregatedEdges: answer.aggregatedEdges.map((c, i) => ({ ...c, edgeCount: flows.length - i })) }
      },
    }
    const hook = render()
    await ask(hook, { out: ['C'] })
    expect(hook.result.current.containerEdges.size).toBe(CONTAINER_CELLS_CAP)
    expect(hook.result.current.containerEdges.has(`agg-C-p${CONTAINER_CELLS_CAP}`)).toBe(false)
    expect([...hook.result.current.containerPartial.out]).toEqual(['C'])
  })

  it('bounds what is left once the cells to the container itself are out', async () => {
    // Heavier cells to rows it holds that the canvas never loaded, which
    // the server leaves out when asked to.
    const inner = Array.from({ length: CONTAINER_CELLS_CAP + 10 }, (_, i) => ({ ...cell('C', `C.hidden${i}`), edgeCount: 10 }))
    graph([['C', 's9']])
    const getAggregatedEdges = (holder.current as { getAggregatedEdges: (req: Ask) => Promise<{ aggregatedEdges: ReturnType<typeof cell>[] }> }).getAggregatedEdges
    holder.current = {
      ...holder.current,
      getAggregatedEdges: async (req: Ask) => {
        const answer = await getAggregatedEdges(req)
        return req.excludeInternal ? answer : { ...answer, aggregatedEdges: [...inner, ...answer.aggregatedEdges] }
      },
    }
    const hook = render()
    await ask(hook, { out: ['C'] })
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-s9'])
    expect(hook.result.current.containerPartial.out.size).toBe(0)
  })
})

describe('useContainerRollups — what it keeps', () => {
  it('an in-direction the server refuses costs only that leg, and is asked again next time', async () => {
    let refusing = true
    const asks = graph(FLOWS, { fail: a => refusing && a.sourceUrns.length === 0 })
    const hook = render()
    await ask(hook, { out: ['C'], in: ['C'] })
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far', 'agg-C-s9'])
    expect([...hook.result.current.containerRead.out]).toEqual(['C'])
    expect(hook.result.current.containerRead.in.size).toBe(0)

    refusing = false
    asks.length = 0
    await ask(hook, { out: ['C'], in: ['C'] })
    expect(asks).toEqual([{ sourceUrns: [], targetUrns: ['C'], granularity: 'dataset', excludeInternal: true }])
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far', 'agg-C-s9', 'agg-up-C'])
  })

  it('a cut-short answer is kept, and says that way is known only in part until a whole one comes', async () => {
    let cut = true
    graph(FLOWS)
    const answer = (holder.current as { getAggregatedEdges: (req: Ask) => Promise<Record<string, unknown>> }).getAggregatedEdges
    // A read that gave up: it may do better next time.
    holder.current = {
      ...holder.current,
      getAggregatedEdges: async (req: Ask) => ({
        ...(await answer(req)), truncated: cut && req.sourceUrns.length > 0, truncationReason: 'timeout',
      }),
    }
    const hook = render()
    await ask(hook, { out: ['C'], in: ['C'] })
    expect(shown(hook.result.current.containerEdges)).toEqual(['agg-C-far', 'agg-C-s9', 'agg-up-C'])
    expect([...hook.result.current.containerPartial.out]).toEqual(['C'])
    expect(hook.result.current.containerPartial.in.size).toBe(0)

    cut = false
    await ask(hook, { out: ['C'] })
    expect(hook.result.current.containerPartial.out.size).toBe(0)

    // One no longer drawn closed is nothing's partial answer.
    cut = true
    act(() => invalidateAggregatedEdgesForScope(SCOPE))
    hook.rerender({ g: 'dataset' })
    await ask(hook, { out: ['C'] })
    expect([...hook.result.current.containerPartial.out]).toEqual(['C'])
    await ask(hook, {}, urn => urn !== 'C')
    expect(hook.result.current.containerPartial.out.size).toBe(0)
  })

  it('an answer cut at a cap is its answer: kept in part, and not asked again', async () => {
    const asks = graph(FLOWS)
    const answer = (holder.current as { getAggregatedEdges: (req: Ask) => Promise<Record<string, unknown>> }).getAggregatedEdges
    holder.current = {
      ...holder.current,
      getAggregatedEdges: async (req: Ask) => ({ ...(await answer(req)), truncated: true, truncationReason: null }),
    }
    const hook = render()
    await ask(hook, { out: ['C'] })
    expect([...hook.result.current.containerPartial.out]).toEqual(['C'])
    asks.length = 0
    await ask(hook, { out: ['C'] })
    expect(asks).toEqual([])
    expect([...hook.result.current.containerPartial.out]).toEqual(['C'])
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
    expect(asks).toEqual([{ sourceUrns: ['C'], targetUrns: undefined, granularity: 'schema', excludeInternal: true }])
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
