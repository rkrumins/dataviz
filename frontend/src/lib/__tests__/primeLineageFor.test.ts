/**
 * primeLineageFor — the flows that neither path brings with it.
 *
 * A search reveal primes CONTAINMENT only (that is what attaches the hit to
 * its parents), and a child page is answered with cross-child lineage only
 * (edges between the children returned, to keep that query O(pageSize²)).
 * So a hit opened from Advanced Search, and a row from "Load 13 more", both
 * landed with no lineage: the drawer listed connections the canvas did not
 * draw.
 */
import { describe, expect, it, vi } from 'vitest'

import { primeLineageFor, PRIME_LINEAGE_LIMIT } from '../primeLineageFor'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

const edge = (id: string, sourceUrn: string, targetUrn: string, edgeType = 'FLOWS_TO') => ({
  id, sourceUrn, targetUrn, edgeType,
})

function providerWith(out: unknown[], incoming: unknown[]) {
  const getEdges = vi.fn(async (q: { sourceUrns?: string[]; targetUrns?: string[] }) =>
    (q.sourceUrns ? out : incoming) as never)
  return { provider: { getEdges } as unknown as GraphDataProvider, getEdges }
}

describe('primeLineageFor', () => {
  it('asks for both directions, capped', async () => {
    const { provider, getEdges } = providerWith([], [])
    await primeLineageFor(provider, ['a', 'b'], ['FLOWS_TO'])

    expect(getEdges).toHaveBeenCalledTimes(2)
    expect(getEdges).toHaveBeenCalledWith(
      { sourceUrns: ['a', 'b'], edgeTypes: ['FLOWS_TO'], limit: PRIME_LINEAGE_LIMIT })
    expect(getEdges).toHaveBeenCalledWith(
      { targetUrns: ['a', 'b'], edgeTypes: ['FLOWS_TO'], limit: PRIME_LINEAGE_LIMIT })
  })

  it('returns both directions as canvas edges', async () => {
    const { provider } = providerWith([edge('e1', 'a', 'partner')], [edge('e2', 'upstream', 'a')])
    const edges = await primeLineageFor(provider, ['a'], ['FLOWS_TO'])

    expect(edges.map((e) => e.id).sort()).toEqual(['e1', 'e2'])
  })

  it('counts an edge once when it comes back from both directions', async () => {
    const both = [edge('e1', 'a', 'b')]
    const { provider } = providerWith(both, both)
    const edges = await primeLineageFor(provider, ['a', 'b'], ['FLOWS_TO'])

    expect(edges).toHaveLength(1)
  })

  it('drops containment and AGGREGATED when the view declares no lineage types', async () => {
    // Untyped, the server answers every relationship the rows have: their
    // containment, and the stored roll-up cells. Neither is a flow.
    const { provider, getEdges } = providerWith([
      edge('e1', 'a', 'partner'),
      edge('c1', 'a', 'child', 'CONTAINS'),
      edge('r1', 'a', 'far-container', 'AGGREGATED'),
    ], [])
    const edges = await primeLineageFor(provider, ['a'], [], ['CONTAINS'])

    expect(getEdges).toHaveBeenCalledWith(
      expect.objectContaining({ edgeTypes: undefined }))
    expect(edges.map((e) => e.id)).toEqual(['e1'])
  })

  it('never asks for AGGREGATED — roll-ups come from /edges/aggregated', async () => {
    const { provider, getEdges } = providerWith([edge('r1', 'a', 'far', 'AGGREGATED')], [])
    const edges = await primeLineageFor(provider, ['a'], ['FLOWS_TO', 'AGGREGATED'])

    expect(getEdges).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrns: ['a'], edgeTypes: ['FLOWS_TO'] }))
    expect(edges).toEqual([])
  })

  it('asks for nothing when there is nothing to ask about', async () => {
    const { provider, getEdges } = providerWith([], [])
    expect(await primeLineageFor(provider, [], ['FLOWS_TO'])).toEqual([])
    expect(getEdges).not.toHaveBeenCalled()
  })

  it('is a no-op without a provider', async () => {
    expect(await primeLineageFor(null, ['a'], ['FLOWS_TO'])).toEqual([])
    expect(await primeLineageFor({} as GraphDataProvider, ['a'], ['FLOWS_TO'])).toEqual([])
  })

  it('lets a failure reach the caller, which decides what it costs', async () => {
    const provider = {
      getEdges: async () => { throw new Error('boom') },
    } as unknown as GraphDataProvider
    await expect(primeLineageFor(provider, ['a'], ['FLOWS_TO'])).rejects.toThrow('boom')
  })
})
