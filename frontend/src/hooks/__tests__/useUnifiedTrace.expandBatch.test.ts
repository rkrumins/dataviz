/**
 * The batched drill (/trace/expand-batch) when the server is shedding.
 *
 * A 429 reaching the store has already been asked again by the transport.
 * Fanning the batch out into one drill per pair would put that many more
 * reads on a store that just said it is full, so the batch is asked once
 * more after the backoff; a second shed leaves it, with nothing cached, so
 * the next expand asks again. A pair the server says it could not expand
 * (`pairErrors`) is never cached as drilled; one it says may answer if asked
 * again is asked once more.
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

function provider(batch: (pairs: Array<{ sourceUrn: string; targetUrn: string }>) => Promise<TraceV2Result>) {
  const expandAggregatedBatch = vi.fn(async (req: { pairs: Array<{ sourceUrn: string; targetUrn: string }> }) => batch(req.pairs))
  const expandAggregated = vi.fn(async () => answer(['per-pair']))
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

  it('shed again, is left: nothing cached, so the next expand asks again', async () => {
    const { provider: p, expandAggregatedBatch, expandAggregated } = provider(vi.fn()
      .mockRejectedValueOnce(shed())
      .mockRejectedValueOnce(shed())
      .mockResolvedValueOnce(answer(['e1'])))

    const result = useTraceStore.getState().expandAggregatedEdgesBatch(PAIRS, p)
    await pastBackoff()

    expect(await result).toBeNull()
    expect(expandAggregatedBatch).toHaveBeenCalledTimes(2)
    expect(expandAggregated).not.toHaveBeenCalled()
    expect(drilled()).toEqual([])
    expect(useTraceStore.getState().expandingPairs.size).toBe(0)

    expect((await useTraceStore.getState().expandAggregatedEdgesBatch(PAIRS, p))?.edges.map(e => e.id)).toEqual(['e1'])
  })
})

describe('expandAggregatedEdgesBatch — pairs the server could not expand', () => {
  it('asks a pair that may answer again once more, and caches it once it does', async () => {
    const { provider: p, expandAggregatedBatch } = provider(vi.fn()
      .mockResolvedValueOnce(answer(['e1'], { pairErrors: [{ sourceUrn: 'a', targetUrn: 'c', retryable: true }] }))
      .mockResolvedValueOnce(answer(['e2'])))

    const result = useTraceStore.getState().expandAggregatedEdgesBatch(PAIRS, p)
    await pastBackoff()

    expect((await result)?.edges.map(e => e.id).sort()).toEqual(['e1', 'e2'])
    expect(expandAggregatedBatch.mock.calls[1][0].pairs).toEqual([{ sourceUrn: 'a', targetUrn: 'c', nextLevel: 1 }])
    expect(drilled()).toEqual([drilldownKey('a', 'b', 1), drilldownKey('a', 'c', 1)])
  })

  it('never caches as drilled a pair that failed, so the next expand asks it again', async () => {
    const { provider: p, expandAggregatedBatch } = provider(vi.fn()
      .mockResolvedValueOnce(answer(['e1'], { pairErrors: [{ sourceUrn: 'a', targetUrn: 'c' }] })))

    const result = useTraceStore.getState().expandAggregatedEdgesBatch(PAIRS, p)
    await pastBackoff()

    expect((await result)?.edges.map(e => e.id)).toEqual(['e1'])
    expect(expandAggregatedBatch).toHaveBeenCalledTimes(1)
    expect(drilled()).toEqual([drilldownKey('a', 'b', 1)])
  })
})
