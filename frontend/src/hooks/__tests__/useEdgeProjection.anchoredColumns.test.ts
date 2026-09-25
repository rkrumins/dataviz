/**
 * useEdgeProjection — anchored columns, and where each end of a line lands.
 *
 * A column anchored to an entity draws that entity AS the column: the anchor
 * is never a row, so no row map holds it. Every end of every line is placed
 * once: on a row, in a column (an anchor, or a row of one not loaded yet —
 * in the view), outside the view, or pending (its place is still being
 * asked). Only "outside" makes a stub or counts as missing.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'

import { useEdgeProjection } from '../useEdgeProjection'

const hNode = (id: string, children: HierarchyNode[] = []): HierarchyNode => ({
  id, typeId: 'entity', name: id, data: { urn: id, type: 'entity', label: id }, children,
  depth: 0, urn: id, entityTypeOption: 'entity', tags: [],
})

const edge = (id: string, source: string, target: string, edgeType = 'FLOWS_TO') =>
  ({ id, source, target, data: { edgeType } })

type DetailedEdge = { id: string; sourceUrn: string; targetUrn: string; edgeType: string }
type AggregatedEntry = {
  state: 'collapsed' | 'expanded'
  detailedEdges: DetailedEdge[]
  aggregated: { id: string; sourceUrn: string; targetUrn: string; edgeCount: number; edgeTypes: string[]; confidence: number }
}

const agg = (id: string, sourceUrn: string, targetUrn: string, edgeCount = 3): [string, AggregatedEntry] => [id, {
  state: 'collapsed',
  detailedEdges: [],
  aggregated: { id, sourceUrn, targetUrn, edgeCount, edgeTypes: ['FLOWS_TO'], confidence: 1 },
}]

const expanded = (id: string, detailedEdges: DetailedEdge[]): [string, AggregatedEntry] => [id, {
  state: 'expanded',
  detailedEdges,
  aggregated: { id, sourceUrn: detailedEdges[0].sourceUrn, targetUrn: detailedEdges[0].targetUrn, edgeCount: detailedEdges.length, edgeTypes: [], confidence: 1 },
}]

/**
 * Two anchored columns: L1 is X (rows r1, r2), L2 is Y (row y1). L3 is an
 * ordinary column holding D, which contains Y in the graph.
 */
function run(opts: {
  layers?: Record<string, HierarchyNode[]>
  edges?: ReturnType<typeof edge>[]
  aggregated?: Array<[string, AggregatedEntry]>
  chains?: Record<string, string[]>
  expandedNodes?: Set<string>
  parentMap?: Record<string, string>
  hidden?: string[]
}) {
  const layers = opts.layers ?? {
    L1: [hNode('r1'), hNode('r2')],
    L2: [hNode('y1')],
    L3: [hNode('D')],
  }
  const nodesByLayer = new Map(Object.entries(layers))
  const flat: HierarchyNode[] = []
  nodesByLayer.forEach(roots => {
    const stack = [...roots]
    while (stack.length > 0) {
      const n = stack.pop()!
      flat.push(n)
      stack.push(...n.children)
    }
  })
  const { result } = renderHook(() => useEdgeProjection({
    edges: opts.edges ?? [],
    aggregatedEdges: new Map(opts.aggregated ?? []),
    nodesByLayer,
    expandedNodes: opts.expandedNodes ?? new Set(),
    displayFlat: flat,
    displayMap: new Map(flat.map(n => [n.id, n])),
    urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
    showLineageFlow: true,
    isTracing: false,
    traceContextSet: new Set(),
    isContainmentEdge: () => false,
    browseBundleParentMap: new Map(Object.entries(opts.parentMap ?? { r1: 'X', r2: 'X', y1: 'Y', Y: 'D' })),
    promotedAnchors: new Map([['X', 'L1'], ['Y', 'L2']]),
    ancestorChains: opts.chains ? new Map(Object.entries(opts.chains)) : undefined,
    hiddenEdgeTypes: opts.hidden ? new Set(opts.hidden) : undefined,
  }))
  return {
    ...result.current,
    lines: (result.current.visibleLineageEdges as Array<{ source: string; target: string }>)
      .map(l => [l.source, l.target]),
  }
}

describe('useEdgeProjection — an anchor and its own rows', () => {
  it('draws, files and counts nothing for a roll-up between the anchor and its own row', () => {
    // The first-open stub: X is the column r1 sits in.
    const res = run({ aggregated: [agg('a1', 'X', 'r1')] })
    expect(res.lines).toEqual([])
    expect(res.offCanvasByNode.size).toBe(0)
    expect(res.unresolvedEdgeCount).toBe(0)
    expect(res.hiddenInsideCollapsedCount).toBe(0)
  })

  it('does the same for a raw edge from a row to its own anchor', () => {
    const res = run({ edges: [edge('e1', 'r1', 'X')] })
    expect(res.lines).toEqual([])
    expect(res.offCanvasByNode.size).toBe(0)
    expect(res.unresolvedEdgeCount).toBe(0)
  })
})

describe('useEdgeProjection — lineage into another column', () => {
  it('files an end whose chain reaches a column anchor under that column, not as outside', () => {
    const res = run({ edges: [edge('e1', 'r1', 'far')], chains: { far: ['Y', 'D'] } })
    const r1 = res.offCanvasByNode.get('r1')!
    expect(r1.out).toBe(0)
    expect(r1.outPartners.size).toBe(0)
    expect(r1.columns?.get('L2')?.out).toBe(1)
    expect([...(r1.columns?.get('L2')?.outPartners ?? [])]).toEqual(['far'])
    expect(res.unresolvedEdgeCount).toBe(0)
  })

  it('stops the chain at the anchor, even when a row above it is drawn elsewhere', () => {
    const res = run({ edges: [edge('e1', 'far', 'r1')], chains: { far: ['Y', 'D'] } })
    expect(res.lines).toEqual([])
    expect(res.offCanvasByNode.get('r1')?.columns?.get('L2')?.in).toBe(1)
  })

  it('a roll-up naming another column\'s anchor keeps what its rows do not carry; a raw edge to it is that column, with no partner', () => {
    const rolled = run({ aggregated: [agg('a1', 'r1', 'Y', 5), agg('a2', 'r1', 'y1', 2)] })
    expect(rolled.lines).toEqual([['r1', 'y1']])
    expect(rolled.offCanvasByNode.get('r1')?.columns?.get('L2')).toMatchObject({ out: 3 })
    expect(rolled.offCanvasByNode.get('r1')?.columns?.get('L2')?.outPartners.size).toBe(0)
    expect(rolled.unresolvedEdgeCount).toBe(0)
    const carried = run({ aggregated: [agg('a1', 'r1', 'Y', 2), agg('a2', 'r1', 'y1', 2)] })
    expect(carried.offCanvasByNode.size).toBe(0)

    const raw = run({ edges: [edge('e1', 'r1', 'Y')] })
    const col = raw.offCanvasByNode.get('r1')?.columns?.get('L2')
    expect(col?.out).toBe(1)
    expect(col?.outPartners.size).toBe(0)
    expect(raw.offCanvasByNode.get('r1')?.out).toBe(0)
    expect(raw.unresolvedEdgeCount).toBe(0)
  })
})

describe('useEdgeProjection — an end whose place is still being asked', () => {
  it('is pending: no stub, not counted, held on its row so the port waits too', () => {
    const res = run({ edges: [edge('e1', 'r1', 'far')], chains: {} })
    expect(res.offCanvasByNode.get('r1')).toMatchObject({ in: 0, out: 0, unplaced: { in: 0, out: 1 } })
    expect(res.offCanvasByNode.get('r1')?.columns.size).toBe(0)
    expect(res.unresolvedEdgeCount).toBe(0)
  })
})

describe('useEdgeProjection — roll-ups resolve to the row the reader sees', () => {
  it('rolls an aggregated end hidden in a collapsed row up to that row', () => {
    const res = run({
      layers: { L1: [hNode('p', [hNode('c')])], L2: [hNode('q')] },
      parentMap: { c: 'p' },
      aggregated: [agg('a1', 'c', 'q')],
    })
    expect(res.lines).toEqual([['p', 'q']])
  })

  it('draws no roll-up between an open row and its own visible child', () => {
    const res = run({
      layers: { L1: [hNode('p', [hNode('c')])] },
      parentMap: { c: 'p' },
      expandedNodes: new Set(['p']),
      aggregated: [agg('a1', 'p', 'c')],
    })
    expect(res.lines).toEqual([])
    expect(res.hiddenInsideCollapsedCount).toBe(0)
  })
})

describe('useEdgeProjection — counting', () => {
  it('counts the flows that leave the view, weighted, and not the hidden ones', () => {
    const res = run({
      aggregated: [agg('a1', 'r1', 'far', 40)],
      edges: [edge('e1', 'r2', 'far-2', 'FEEDS')],
      hidden: ['FEEDS'],
    })
    expect(res.unresolvedEdgeCount).toBe(40)
    expect(res.offCanvasByNode.get('r1')?.out).toBe(40)
    expect(res.offCanvasByNode.has('r2')).toBe(false)
  })

  it('counts a roll-up and a drilled edge that both land inside one closed row', () => {
    const layers = { L1: [hNode('p', [hNode('c1'), hNode('c2')])] }
    const parentMap = { c1: 'p', c2: 'p' }
    const rolled = run({ layers, parentMap, aggregated: [agg('a1', 'c1', 'c2')] })
    expect(rolled.lines).toEqual([])
    expect(rolled.hiddenInsideCollapsedCount).toBe(1)

    const drilled = run({
      layers, parentMap,
      aggregated: [expanded('x1', [{ id: 'd1', sourceUrn: 'c1', targetUrn: 'c2', edgeType: 'FLOWS_TO' }])],
    })
    expect(drilled.lines).toEqual([])
    expect(drilled.hiddenInsideCollapsedCount).toBe(1)
  })
})
