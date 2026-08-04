/**
 * useLensImpact — transitive-reach counts for the Lens focal.
 * Contract: one trace per focal per session, explicit retry only,
 * session clears when the lens closes, truncation reported, and a
 * provider without the capability yields nothing (never a fake zero).
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useLensImpact, IMPACT_DEPTH } from '../useLensImpact'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

function makeProvider(impl?: (urn: string) => unknown) {
  const traceAtLevel = vi.fn(async ({ urn }: { urn: string }) =>
    impl ? impl(urn) : {
      nodes: [], edges: [], containmentEdges: [],
      upstreamUrns: new Set(['u1', 'u2']),
      downstreamUrns: new Set(['d1', 'd2', 'd3']),
      focus: { urn, level: 0, entityType: 'dataset' },
      effectiveLevel: 0, isInherited: false, truncated: false,
    })
  return { provider: { traceAtLevel } as unknown as GraphDataProvider, traceAtLevel }
}

describe('useLensImpact', () => {
  it('measures each focal once with bounded depth and reports counts', async () => {
    const { provider, traceAtLevel } = makeProvider()
    const { result, rerender } = renderHook(
      ({ focal }: { focal: string | null }) => useLensImpact(focal, provider),
      { initialProps: { focal: 'a' as string | null } },
    )
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    expect(result.current.impact.get('a')).toEqual({ up: 2, down: 3, truncated: false })
    expect(traceAtLevel).toHaveBeenCalledWith(expect.objectContaining({
      urn: 'a', direction: 'both', upstreamDepth: IMPACT_DEPTH, downstreamDepth: IMPACT_DEPTH,
    }))

    // Walking to b measures b; returning to a does NOT re-measure.
    rerender({ focal: 'b' })
    await waitFor(() => expect(result.current.status.get('b')).toBe('done'))
    rerender({ focal: 'a' })
    expect(traceAtLevel).toHaveBeenCalledTimes(2)
  })

  it('clears the session when the lens closes; reopening measures fresh', async () => {
    const { provider, traceAtLevel } = makeProvider()
    const { result, rerender } = renderHook(
      ({ focal }: { focal: string | null }) => useLensImpact(focal, provider),
      { initialProps: { focal: 'a' as string | null } },
    )
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    rerender({ focal: null })
    expect(result.current.impact.size).toBe(0)
    rerender({ focal: 'a' })
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    expect(traceAtLevel).toHaveBeenCalledTimes(2)
  })

  it('reports errors and recovers via explicit retry; truncation is surfaced', async () => {
    let fail = true
    const { provider } = makeProvider((urn) => {
      if (fail) throw new Error('down')
      return {
        nodes: [], edges: [], containmentEdges: [],
        upstreamUrns: new Set(), downstreamUrns: new Set(['d1']),
        focus: { urn, level: 0, entityType: 'dataset' },
        effectiveLevel: 0, isInherited: false, truncated: true,
      }
    })
    const { result } = renderHook(() => useLensImpact('a', provider))
    await waitFor(() => expect(result.current.status.get('a')).toBe('error'))
    fail = false
    act(() => result.current.retry('a'))
    await waitFor(() => expect(result.current.status.get('a')).toBe('done'))
    expect(result.current.impact.get('a')).toEqual({ up: 0, down: 1, truncated: true })
  })

  it('walking past a node does not measure it — only the focal you stop on', async () => {
    const { provider, traceAtLevel } = makeProvider()
    const { result, rerender } = renderHook(
      ({ focal }: { focal: string | null }) => useLensImpact(focal, provider),
      { initialProps: { focal: 'a' as string | null } },
    )
    // Walk a → b → c faster than the settle time: the two hops passed
    // through must never fire their own multi-hop traces.
    rerender({ focal: 'b' })
    rerender({ focal: 'c' })
    await waitFor(() => expect(result.current.status.get('c')).toBe('done'))
    expect(traceAtLevel).toHaveBeenCalledTimes(1)
    expect(traceAtLevel).toHaveBeenCalledWith(expect.objectContaining({ urn: 'c' }))
    expect(result.current.status.has('a')).toBe(false)
    expect(result.current.status.has('b')).toBe(false)
  })

  it('a provider without the capability yields nothing — no invented zeros', async () => {
    const provider = {} as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensImpact('a', provider))
    await new Promise(r => setTimeout(r, 10))
    expect(result.current.status.size).toBe(0)
    expect(result.current.impact.size).toBe(0)
  })
})
