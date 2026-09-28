/**
 * useEdgeProjection — one walk per URN per pass.
 *
 * Every roll-up cell asks where its ends sit in containment (is one inside
 * the other? which row above holds it?), and every undrawn end of every
 * edge asks where it lands. Those answers depend only on the URN within one
 * pass, but each was walked again for every cell and edge naming it:
 * O(pairs × depth) on each recompute, where O(URNs × depth) is enough.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'

import { useEdgeProjection } from '../useEdgeProjection'

const hNode = (id: string): HierarchyNode => ({
  id, typeId: 'entity', name: id, data: { urn: id, type: 'entity', label: id }, children: [],
  depth: 0, urn: id, entityTypeOption: 'entity', tags: [],
})

/** A Map that counts its lookups. */
class CountingMap<K, V> extends Map<K, V> {
  gets = 0
  get(key: K): V | undefined {
    this.gets++
    return super.get(key)
  }
}

const URNS = 50
const DEPTH = 10
const PAIRS = 1000

/** URN i and URN j, for the k-th of PAIRS pairs among URNS URNs. */
const pairOf = (k: number): [number, number] => {
  const i = k % URNS
  return [i, (i + 1 + Math.floor(k / URNS)) % URNS]
}

function project(opts: { cells?: boolean; edges?: boolean }) {
  // 50 rows, each under its own chain of DEPTH containers not drawn.
  const rows = Array.from({ length: URNS }, (_, i) => hNode(`u${i}`))
  const parents = new CountingMap<string, string>()
  for (let i = 0; i < URNS; i++) {
    parents.set(`u${i}`, `u${i}.p1`)
    for (let d = 1; d < DEPTH; d++) parents.set(`u${i}.p${d}`, `u${i}.p${d + 1}`)
  }
  // 50 ends no one loaded, each with a chain of DEPTH containers.
  const chains = new CountingMap<string, readonly string[]>()
  for (let i = 0; i < URNS; i++) chains.set(`far${i}`, Array.from({ length: DEPTH }, (_, d) => `far${i}.p${d + 1}`))

  const aggregated = new Map<string, unknown>()
  const edges: Array<{ id: string; source: string; target: string; data: { edgeType: string } }> = []
  for (let k = 0; k < PAIRS; k++) {
    const [i, j] = pairOf(k)
    if (opts.cells) {
      const id = `agg-u${i}-u${j}-${k}`
      aggregated.set(id, {
        state: 'collapsed', detailedEdges: [],
        aggregated: { id, sourceUrn: `u${i}`, targetUrn: `u${j}`, edgeCount: 1, edgeTypes: ['FLOWS_TO'], confidence: 1, sourceEdgeIds: [] },
      })
    }
    if (opts.edges) edges.push({ id: `e${k}`, source: `u${i}`, target: `far${j}`, data: { edgeType: 'FLOWS_TO' } })
  }

  renderHook(() => useEdgeProjection({
    edges,
    aggregatedEdges: aggregated as Map<string, unknown>,
    nodesByLayer: new Map([['L1', rows]]),
    expandedNodes: new Set(),
    displayFlat: rows,
    displayMap: new Map(rows.map(n => [n.id, n])),
    urnToIdMap: new Map(rows.map(n => [n.urn!, n.id])),
    showLineageFlow: true,
    isTracing: false,
    traceContextSet: new Set(),
    isContainmentEdge: () => false,
    browseBundleParentMap: parents,
    ancestorChains: chains,
  }))
  return { parents, chains }
}

describe('useEdgeProjection — the cost of one pass', () => {
  it("walks each roll-up end's containment once, however many cells name it", () => {
    const { parents } = project({ cells: true })
    // One walk per URN: its parent, then each container above it.
    expect(parents.gets).toBeLessThanOrEqual(URNS * (DEPTH + 1))
  })

  it('places each undrawn end once, however many edges name it', () => {
    const { chains } = project({ edges: true })
    expect(chains.gets).toBeLessThanOrEqual(URNS)
  })
})
