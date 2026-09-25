/**
 * useAggregatedLineage — an answer that arrives late, and one that never does.
 *
 * A slower answer used to land after a newer one and replace the whole map,
 * and one failed chunk replaced it with whatever the others said; nothing
 * asked again until the view changed, and the "Some relationships could not
 * be loaded" banner went up on the first 504.
 *
 * Now an answer for a graph, level or cache version the canvas has left is
 * cached but never shown; a failure removes nothing that was known; the rows
 * a failed or cut-short chunk was about are asked again on the hook's own
 * backoff, five times in all, and only then is there an error to show.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
interface Answer { aggregatedEdges: ReturnType<typeof pair>[]; totalSourceEdges: number; truncated?: boolean }

const pair = (s: string, t: string) => ({
  id: `agg-${s}-${t}`, sourceUrn: s, targetUrn: t, edgeCount: 1, edgeTypes: ['FLOWS_TO'], confidence: 1, sourceEdgeIds: [],
})

const answerFor = (flows: Array<[string, string]>, ask: Ask): Answer => {
  const S = new Set(ask.sourceUrns)
  const T = new Set(ask.targetUrns ?? [])
  return {
    aggregatedEdges: flows.filter(([s, t]) => S.has(s) && T.has(t)).map(([s, t]) => pair(s, t)),
    totalSourceEdges: 0,
  }
}

/** A graph whose roll-ups are `flows`; `respond` may answer an ask its own
 *  way (a rejection, a cut-short answer, a promise the test settles). */
function graph(flows: Array<[string, string]>, respond?: (ask: Ask) => Promise<Answer> | undefined) {
  const asks: Ask[] = []
  const getAggregatedEdges = vi.fn(async (req: Ask) => {
    const ask = { ...req, sourceUrns: [...req.sourceUrns], targetUrns: req.targetUrns && [...req.targetUrns] }
    asks.push(ask)
    return (await respond?.(ask)) ?? answerFor(flows, ask)
  })
  holder.current = { scopeKey: SCOPE, getAggregatedEdges }
  return { asks }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

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

/** Past `ms` of fake time, with every promise it starts drained. */
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

// 700 rows: two chunks of sources, r0000–r0499 and r0500–r0699.
const ROWS = Array.from({ length: 700 }, (_, i) => `r${String(i).padStart(4, '0')}`)
const FLOWS: Array<[string, string]> = [['r0001', 'r0600'], ['r0600', 'r0001'], ['r0650', 'r0002']]
const SECOND_CHUNK = ROWS.slice(500)
const inSecondChunk = (a: Ask) => a.sourceUrns.includes('r0600')

beforeEach(() => {
  invalidateAggregatedEdges()
  // No jitter: lookupRetryDelayMs(n) is exactly 2s · 2^(n−1).
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useAggregatedLineage — an answer the canvas has moved on from', () => {
  it('an answer for a level it has left is cached, never shown', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Answer>>>()
    const flows: Array<[string, string]> = [['a', 'b']]
    graph(flows, a => {
      const d = deferred<Answer>()
      pending.set(a.granularity!, d)
      return d.promise
    })
    const rows = ['a', 'b']
    const hook = render('dataset')
    act(() => { void hook.result.current.fetchAggregated(rows, rows) })
    act(() => hook.result.current.setGranularity('system'))

    // The dataset answer lands after the level moved on.
    await act(async () => { pending.get('dataset')!.resolve(answerFor(flows, { sourceUrns: rows, targetUrns: rows, granularity: 'dataset' })) })
    expect(shown(hook.result.current.aggregatedEdges)).toEqual([])

    // The system answer is the one shown.
    await vi.waitFor(() => expect(pending.has('system')).toBe(true))
    await act(async () => { pending.get('system')!.resolve({ aggregatedEdges: [pair('b', 'a')], totalSourceEdges: 0 }) })
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(['agg-b-a'])

    // The dataset answer was kept: another canvas at that level is answered
    // from the cache.
    pending.clear()
    const other = render('dataset')
    await ask(other, rows)
    expect(shown(other.result.current.aggregatedEdges)).toEqual(['agg-a-b'])
    expect(pending.size).toBe(0)
  })

  it('an older answer to a one-sided ask never replaces a newer one from the cache', async () => {
    const flows: Array<[string, string]> = [['a', 't'], ['b', 't']]
    let slow: ReturnType<typeof deferred<Answer>> | undefined
    graph(flows, a => {
      if (!a.sourceUrns.includes('a')) return undefined
      slow = deferred<Answer>()
      return slow.promise
    })
    const hook = render()
    // B once, so that asking it again is a cache hit.
    await act(async () => { await hook.result.current.fetchAggregated(['b'], ['t']) })

    let late: Promise<void> | undefined
    act(() => { late = hook.result.current.fetchAggregated(['a'], ['t']) })
    await act(async () => { await hook.result.current.fetchAggregated(['b'], ['t']) })
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(['agg-b-t'])

    await act(async () => {
      slow!.resolve(answerFor(flows, { sourceUrns: ['a'], targetUrns: ['t'], granularity: 'dataset' }))
      await late
    })
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(['agg-b-t'])
  })
})

describe('useAggregatedLineage — a failure removes nothing that was known', () => {
  it('an invalidation whose asks all fail keeps the pairs it had', async () => {
    let failing = false
    graph(FLOWS, () => (failing ? Promise.reject(new Error('504 Gateway Timeout')) : undefined))
    const hook = render()
    await ask(hook, ROWS)
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ROWS))

    failing = true
    act(() => invalidateAggregatedEdgesForScope(SCOPE))
    await ask(hook, ROWS)
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ROWS))
  })

  it('an invalidation still drops a pair its fresh answer no longer names', async () => {
    const flows: Array<[string, string]> = [['a', 'b'], ['b', 'c']]
    graph(flows)
    const hook = render()
    await ask(hook, ['a', 'b', 'c'])
    flows.splice(0, 1)
    act(() => invalidateAggregatedEdgesForScope(SCOPE))
    await ask(hook, ['a', 'b', 'c'])
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(['agg-b-c'])
  })
})

describe('useAggregatedLineage — the rows a failed chunk was about are asked again', () => {
  it('after the backoff, and only they', async () => {
    vi.useFakeTimers()
    let failures = 1
    const g = graph(FLOWS, a => (inSecondChunk(a) && failures-- > 0 ? Promise.reject(new Error('504')) : undefined))
    const hook = render()
    await ask(hook, ROWS)
    expect(g.asks).toHaveLength(2)
    expect(hook.result.current.error).toBeNull()

    await wait(1999)
    expect(g.asks).toHaveLength(2)
    await wait(1)
    const retry = g.asks.slice(2).map(a => ({ s: sorted(a.sourceUrns), t: sorted(a.targetUrns) }))
    expect(retry).toEqual([
      { s: SECOND_CHUNK, t: ROWS },
      { s: ROWS.slice(0, 500), t: SECOND_CHUNK },
    ])
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ROWS))
    expect(hook.result.current.error).toBeNull()
  })

  it('five times in all; only then is there an error, and nothing more is asked', async () => {
    vi.useFakeTimers()
    const g = graph(FLOWS, a => (inSecondChunk(a) ? Promise.reject(new Error('504 Gateway Timeout')) : undefined))
    const hook = render()
    await ask(hook, ROWS)
    const secondChunkAsks = () => g.asks.filter(inSecondChunk).length

    for (const backoff of [2000, 4000, 8000, 16000]) {
      expect(hook.result.current.error).toBeNull()
      await wait(backoff)
    }
    expect(secondChunkAsks()).toBe(5)
    expect(hook.result.current.error).toBe('504 Gateway Timeout')
    // What the first chunk answered is still shown.
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(['agg-r0001-r0600'])

    await wait(120_000)
    expect(secondChunkAsks()).toBe(5)
  })

  it('a new page while a retry waits asks only about the page', async () => {
    vi.useFakeTimers()
    let failures = 1
    const g = graph(FLOWS, a => (inSecondChunk(a) && failures-- > 0 ? Promise.reject(new Error('504')) : undefined))
    const hook = render()
    await ask(hook, ROWS)
    await ask(hook, [...ROWS, 'r9999'])

    const page = g.asks.slice(2).map(a => ({ s: sorted(a.sourceUrns), t: sorted(a.targetUrns) }))
    expect(page).toEqual([
      { s: ['r9999'], t: sorted([...ROWS, 'r9999']) },
      { s: ROWS.slice(0, 500), t: ['r9999'] },
    ])
  })

  it('a chunk that came back cut short is asked again', async () => {
    vi.useFakeTimers()
    let cut = 1
    const g = graph(FLOWS, a => (inSecondChunk(a) && cut-- > 0
      ? Promise.resolve({ aggregatedEdges: [pair('r0650', 'r0002')], totalSourceEdges: 1, truncated: true })
      : undefined))
    const hook = render()
    await ask(hook, ROWS)
    expect(hook.result.current.truncated).toBe(true)

    await wait(2000)
    expect(sorted(g.asks[2].sourceUrns)).toEqual(SECOND_CHUNK)
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ROWS))
    expect(hook.result.current.truncated).toBe(false)
  })

  it('a refusal by the open circuit breaker waits for the breaker, not the backoff', async () => {
    vi.useFakeTimers()
    let refusals = 1
    const g = graph(FLOWS, a => (inSecondChunk(a) && refusals-- > 0
      ? Promise.reject(new Error('Provider unavailable (circuit open)'))
      : undefined))
    const hook = render()
    await ask(hook, ROWS)

    await wait(14_999)
    expect(g.asks).toHaveLength(2)
    await wait(1)
    expect(sorted(g.asks[2].sourceUrns)).toEqual(SECOND_CHUNK)
  })

  it('Retry asks again, now, about the rows that ran out of attempts', async () => {
    vi.useFakeTimers()
    let failing = true
    const g = graph(FLOWS, a => (failing && inSecondChunk(a) ? Promise.reject(new Error('504')) : undefined))
    const hook = render()
    await ask(hook, ROWS)
    for (const backoff of [2000, 4000, 8000, 16000]) await wait(backoff)
    expect(hook.result.current.error).toBe('504')

    failing = false
    const before = g.asks.length
    await act(async () => { await hook.result.current.retryAggregated() })
    expect(sorted(g.asks[before].sourceUrns)).toEqual(SECOND_CHUNK)
    expect(shown(hook.result.current.aggregatedEdges)).toEqual(pairsAmong(FLOWS, ROWS))
    expect(hook.result.current.error).toBeNull()
  })
})
