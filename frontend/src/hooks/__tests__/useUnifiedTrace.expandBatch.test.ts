/**
 * The batched drill (/trace/expand-batch) when the server is shedding.
 *
 * A 429 reaching the store has already been asked again by the transport.
 * Fanning the batch out at once into one drill per pair would put that many
 * more reads on a store that just said it is full, so the batch is asked
 * once more after the backoff. Shed again, it falls back to one pair at a
 * time, two at most, and only the pairs that answer are cached as drilled.
 * A trace cleared while the drill was out is not written into.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GraphDataProvider, TraceV2Result } from '@/providers/GraphDataProvider'

import { drilldownKey, useTraceStore } from '../useUnifiedTrace'

const PAIRS = [
  { sourceUrn: 'a', targetUrn: 'b', currentLevel: 0 },
  { sourceUrn: 'a', targetUrn: 'c', currentLevel: 0 },
]

const answer = (edgeIds: string[], extra: Record<string, unknown> = {}): TraceV2Result => ({
  nodes: [],
  edges: edgeIds.map(id => ({ id, sourceUrn: 'x', targetUrn: 'y', edgeType: 'FLOWS_TO' })),
  containmentEdges: [],
  upstreamUrns: new Set(),
  downstreamUrns: new Set(),
  focus: { urn: 'a' },
  effectiveLevel: 1,
  isInherited: false,
  truncated: false,
  ...extra,
}) as unknown as TraceV2Result

const shed = () => Object.assign(new Error('busy'), { status: 429 })

function provider(
  batch: (pairs: Array<{ sourceUrn: string; targetUrn: string }>) => Promise<TraceV2Result>,
  pair: (p: { sourceUrn: string; targetUrn: string }) => Promise<TraceV2Result> = async () => answer(['per-pair']),
) {
  const expandAggregatedBatch = vi.fn(async (req: { pairs: Array<{ sourceUrn: string; targetUrn: string }> }) => batch(req.pairs))
  const expandAggregated = vi.fn(pair)
  return { expandAggregatedBatch, expandAggregated, provider: { expandAggregatedBatch, expandAggregated } as unknown as GraphDataProvider }
}

const drilled = () => [...useTraceStore.getState().drilldowns.keys()].sort()

/** Past the backoff (2 s, jittered up to +30%). */
const pastBackoff = () => vi.advanceTimersByTimeAsync(3_000)

beforeEach(() => {
  vi.useFakeTimers()
  useTraceStore.getState().clearTrace()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('expandAggregatedEdgesBatch — a batch the server shed', () => {
  it('is asked once more after the backoff, never fanned out per pair', async () => {
    const { provider: p, expandAggregatedBatch, expandAggregated } = provider(vi.fn()
      .mockRejectedValueOnce(shed())
      .mockResolvedValueOnce(answer(['e1'])))

    const result = useTraceStore.getState().expandAggregatedEdgesBatch(PAIRS, p)
    await pastBackoff()

    expect((await result)?.edges.map(e => e.id)).toEqual(['e1'])
    expect(expandAggregatedBatch).toHaveBeenCalledTimes(2)
    expect(expandAggregated).not.toHaveBeenCalled()
    expect(drilled()).toEqual([drilldownKey('a', 'b', 1), drilldownKey('a', 'c', 1)])
  })

  it('shed again, falls back to one pair at a time, two at most, and caches only the pairs that answer', async () => {
    let out = 0
    let most = 0
    const { provider: p, expandAggregatedBatch, expandAggregated } = provider(
      vi.fn().mockRejectedValue(shed()),
      async ({ targetUrn }) => {
        most = Math.max(most, ++out)
        await new Promise(r => setTimeout(r, 10))
        out--
        if (targetUrn === 'd') throw shed()
        return answer([`e-${targetUrn}`])
      })

    const result = useTraceStore.getState().expandAggregatedEdgesBatch(
      [...PAIRS, { sourceUrn: 'a', targetUrn: 'd', currentLevel: 0 }], p)
    await pastBackoff()

    expect((await result)?.edges.map(e => e.id).sort()).toEqual(['e-b', 'e-c'])
    expect(expandAggregatedBatch).toHaveBeenCalledTimes(2)
    expect(expandAggregated).toHaveBeenCalledTimes(3)
    expect(most).toBe(2)
    expect(drilled()).toEqual([drilldownKey('a', 'b', 1), drilldownKey('a', 'c', 1)])
    expect(useTraceStore.getState().expandingPairs.size).toBe(0)
  })
})

describe('expandAggregatedEdgesBatch — a trace cleared while it was out', () => {
  it('is not written into: nothing cached, nothing handed back', async () => {
    const { provider: p } = provider(vi.fn()
      .mockRejectedValueOnce(shed())
      .mockResolvedValueOnce(answer(['e1'])))

    const result = useTraceStore.getState().expandAggregatedEdgesBatch(PAIRS, p)
    await vi.advanceTimersByTimeAsync(0)
    useTraceStore.getState().clearTrace()
    await pastBackoff()

    expect(await result).toBeNull()
    expect(drilled()).toEqual([])
  })
})
