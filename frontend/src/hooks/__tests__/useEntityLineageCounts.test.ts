/**
 * useEntityLineageCounts — the drawer's headline counts come from the
 * closure walk, not from locally-held edges.
 *
 * Contract: one depth-1 request per focal, distinct partners as reported by
 * the server, truncation surfaced rather than hidden, one request per focal
 * (cached), superseded responses ignored, and a provider without the lane
 * answering `unsupported` instead of a zero it cannot stand behind.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useEntityLineageCounts } from '../useEntityLineageCounts'
import type {
  GraphDataProvider,
  TraceV2Result,
  LensClosureExtras,
  TraceClosureRequest,
} from '@/providers/GraphDataProvider'

const FOCAL = 'urn:demo:table:orders'

function closureResult(
  upstream: string[],
  downstream: string[],
  extra: Partial<TraceV2Result & LensClosureExtras> = {},
): TraceV2Result & LensClosureExtras {
  return {
    nodes: [],
    edges: [],
    containmentEdges: [],
    upstreamUrns: new Set(upstream),
    downstreamUrns: new Set(downstream),
    focus: { urn: FOCAL, level: 1, entityType: 'table' },
    effectiveLevel: 1,
    isInherited: false,
    truncated: false,
    frontierUp: [],
    frontierDown: [],
    seedTruncated: false,
    ...extra,
  } as TraceV2Result & LensClosureExtras
}

/** A provider whose closure answers with the given result. */
function providerReturning(
  result: TraceV2Result & LensClosureExtras,
  spy?: (req: TraceClosureRequest) => void,
): GraphDataProvider {
  return {
    traceClosure: async (req: TraceClosureRequest) => {
      spy?.(req)
      return result
    },
  } as unknown as GraphDataProvider
}

describe('useEntityLineageCounts', () => {
  it('reports the distinct partners the server walk found', async () => {
    const provider = providerReturning(
      closureResult(['urn:a', 'urn:b', 'urn:c'], ['urn:d']),
    )
    const { result } = renderHook(() => useEntityLineageCounts(FOCAL, provider, []))

    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.upstream).toBe(3)
    expect(result.current.downstream).toBe(1)
    expect(result.current.truncated).toBe(false)
  })

  it('asks for exactly one hop in both directions', async () => {
    const seen: TraceClosureRequest[] = []
    const provider = providerReturning(closureResult([], []), (req) => seen.push(req))
    const { result } = renderHook(() => useEntityLineageCounts(FOCAL, provider, []))

    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      urn: FOCAL,
      direction: 'both',
      upstreamDepth: 1,
      downstreamDepth: 1,
    })
  })

  it('passes the view lineage types through, and null when there are none', async () => {
    const seen: TraceClosureRequest[] = []
    const provider = providerReturning(closureResult([], []), (req) => seen.push(req))

    const typed = renderHook(() =>
      useEntityLineageCounts(FOCAL, provider, ['FLOWS_TO']),
    )
    await waitFor(() => expect(typed.result.current.status).toBe('done'))
    expect(seen[0].lineageEdgeTypes).toEqual(['FLOWS_TO'])

    const untyped = renderHook(() => useEntityLineageCounts('urn:other', provider, []))
    await waitFor(() => expect(untyped.result.current.status).toBe('done'))
    expect(seen[1].lineageEdgeTypes).toBeNull()
  })

  it('says the counts are a floor when the walk did not finish', async () => {
    const provider = providerReturning(
      closureResult(['urn:a'], [], { seedTruncated: true }),
    )
    const { result } = renderHook(() => useEntityLineageCounts(FOCAL, provider, []))

    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.truncated).toBe(true)
  })

  it('asks once per focal and serves a repeat from cache', async () => {
    const calls = vi.fn()
    const provider = providerReturning(closureResult(['urn:a'], []), calls)
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useEntityLineageCounts(id, provider, []),
      { initialProps: { id: FOCAL } },
    )

    await waitFor(() => expect(result.current.status).toBe('done'))
    rerender({ id: 'urn:other' })
    await waitFor(() => expect(result.current.status).toBe('done'))
    rerender({ id: FOCAL })
    await waitFor(() => expect(result.current.upstream).toBe(1))

    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('reports unsupported — not zero — when the provider has no closure lane', async () => {
    const { result } = renderHook(() =>
      useEntityLineageCounts(FOCAL, {} as GraphDataProvider, []),
    )
    await waitFor(() => expect(result.current.status).toBe('unsupported'))
    expect(result.current.upstream).toBeNull()
    expect(result.current.downstream).toBeNull()
  })

  it('reports unsupported when the server refuses with 501', async () => {
    const provider = {
      traceClosure: async () => {
        throw Object.assign(new Error('nope'), { status: 501 })
      },
    } as unknown as GraphDataProvider
    const { result } = renderHook(() => useEntityLineageCounts(FOCAL, provider, []))

    await waitFor(() => expect(result.current.status).toBe('unsupported'))
    expect(result.current.upstream).toBeNull()
  })

  it('reports an error without inventing a count', async () => {
    const provider = {
      traceClosure: async () => {
        throw new Error('boom')
      },
    } as unknown as GraphDataProvider
    const { result } = renderHook(() => useEntityLineageCounts(FOCAL, provider, []))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.upstream).toBeNull()
  })

  it('does not spin the request lane when the provider prop is unstable', async () => {
    // A caller that builds its provider inline hands this hook a NEW
    // object every render. The answer-less states are shared references
    // so React bails out of the re-render instead of re-firing the
    // effect — without that, this test exhausts the heap.
    const calls = vi.fn()
    const { result, rerender } = renderHook(() =>
      useEntityLineageCounts(FOCAL, { traceClosure: async () => { calls(); return closureResult(['urn:a'], []) } } as unknown as GraphDataProvider, []),
    )
    await waitFor(() => expect(result.current.status).toBe('done'))
    const before = calls.mock.calls.length
    rerender()
    rerender()
    await waitFor(() => expect(result.current.upstream).toBe(1))
    // A fresh provider identity legitimately re-asks, but each render must
    // cost at most one request — never an unbounded cascade.
    expect(calls.mock.calls.length - before).toBeLessThanOrEqual(2)
  })

  it('is idle with no focal', () => {
    const provider = providerReturning(closureResult(['urn:a'], []))
    const { result } = renderHook(() => useEntityLineageCounts(null, provider, []))
    expect(result.current.status).toBe('idle')
    expect(result.current.upstream).toBeNull()
  })
})
