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

import { primeLineageFor, PRIME_BATCH, PRIME_LINEAGE_LIMIT } from '../primeLineageFor'
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
    const { edges } = await primeLineageFor(provider, ['a'], ['FLOWS_TO'])

    expect(edges.map((e) => e.id).sort()).toEqual(['e1', 'e2'])
  })

  it('counts an edge once when it comes back from both directions', async () => {
    const both = [edge('e1', 'a', 'b')]
    const { provider } = providerWith(both, both)
    const { edges } = await primeLineageFor(provider, ['a', 'b'], ['FLOWS_TO'])

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
    const { edges } = await primeLineageFor(provider, ['a'], [], ['CONTAINS'])

    expect(getEdges).toHaveBeenCalledWith(
      expect.objectContaining({ edgeTypes: undefined }))
    expect(edges.map((e) => e.id)).toEqual(['e1'])
  })

  it('never asks for AGGREGATED — roll-ups come from /edges/aggregated', async () => {
    const { provider, getEdges } = providerWith([edge('r1', 'a', 'far', 'AGGREGATED')], [])
    const { edges } = await primeLineageFor(provider, ['a'], ['FLOWS_TO', 'AGGREGATED'])

    expect(getEdges).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrns: ['a'], edgeTypes: ['FLOWS_TO'] }))
    expect(edges).toEqual([])
  })

  it('asks for nothing when there is nothing to ask about', async () => {
    const { provider, getEdges } = providerWith([], [])
    expect((await primeLineageFor(provider, [], ['FLOWS_TO'])).edges).toEqual([])
    expect(getEdges).not.toHaveBeenCalled()
  })

  it('is a no-op without a provider', async () => {
    expect((await primeLineageFor(null, ['a'], ['FLOWS_TO'])).edges).toEqual([])
    expect((await primeLineageFor({} as GraphDataProvider, ['a'], ['FLOWS_TO'])).edges).toEqual([])
  })

  it('asks about a batch of rows at a time, each capped, so one hub cannot starve the rest', async () => {
    const urns = Array.from({ length: 60 }, (_, i) => `n${i}`)
    const { provider, getEdges } = providerWith([], [])
    await primeLineageFor(provider, urns, ['FLOWS_TO'])

    const asked = getEdges.mock.calls.map(([q]) => q as { sourceUrns?: string[]; targetUrns?: string[]; limit: number })
    expect(PRIME_BATCH).toBe(25)
    expect(asked).toHaveLength(6)
    for (const q of asked) {
      expect((q.sourceUrns ?? q.targetUrns)!.length).toBeLessThanOrEqual(PRIME_BATCH)
      expect(q.limit).toBe(PRIME_LINEAGE_LIMIT)
    }
    expect(asked.filter(q => q.sourceUrns).flatMap(q => q.sourceUrns)).toEqual(urns)
    expect(asked.filter(q => q.targetUrns).flatMap(q => q.targetUrns)).toEqual(urns)
  })

  it("a direction that comes back at its cap marks that batch's rows partial that way", async () => {
    const urns = Array.from({ length: 30 }, (_, i) => `n${i}`)
    // n0 is a hub: its first batch's outgoing read is cut at the cap.
    const getEdges = vi.fn(async (q: { sourceUrns?: string[]; targetUrns?: string[]; limit: number }) =>
      (q.sourceUrns?.includes('n0')
        ? Array.from({ length: q.limit }, (_, i) => edge(`h${i}`, 'n0', `p${i}`))
        : q.targetUrns?.includes('n29') ? [edge('u1', 'up', 'n29')] : []) as never)
    const { edges, partial } = await primeLineageFor({ getEdges } as unknown as GraphDataProvider, urns, ['FLOWS_TO'], [], 3)

    expect(edges.map((e) => e.id)).toEqual(['h0', 'h1', 'h2', 'u1'])
    expect(partial.out).toEqual(urns.slice(0, 25))
    expect(partial.in).toEqual([])
  })

  it('a failed batch costs its rows their flows, not the others', async () => {
    const urns = Array.from({ length: 30 }, (_, i) => `n${i}`)
    const getEdges = vi.fn(async (q: { sourceUrns?: string[] }) => {
      if (q.sourceUrns?.includes('n0')) throw new Error('boom')
      return (q.sourceUrns?.includes('n29') ? [edge('e29', 'n29', 'far')] : []) as never
    })
    const { edges, failed } = await primeLineageFor({ getEdges } as unknown as GraphDataProvider, urns, ['FLOWS_TO'])
    expect(edges.map((e) => e.id)).toEqual(['e29'])
    // Its rows were not read: the caller can ask about them again.
    expect(failed).toEqual(urns.slice(0, 25))
  })

  it('lets a failure reach the caller, which decides what it costs', async () => {
    const provider = {
      getEdges: async () => { throw new Error('boom') },
    } as unknown as GraphDataProvider
    await expect(primeLineageFor(provider, ['a'], ['FLOWS_TO'])).rejects.toThrow('boom')
  })
})
