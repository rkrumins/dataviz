/**
 * useEdgeProjection — lineage whose far end is not on the canvas, per row.
 *
 * The line cannot be drawn (the far end was never loaded), and without a
 * roll-up it used to vanish into one global "N flows outside this view".
 * The row it belongs to now carries it — per direction, with the far ends
 * a click can bring in.
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

function run(opts: {
  roots: HierarchyNode[]
  edges: ReturnType<typeof edge>[]
  chains?: Record<string, string[]>
  hidden?: string[]
  /** Roll-ups beside the rows' own: a selected container's, all of them. */
  cells?: Array<[string, string, number]>
}) {
  const flat: HierarchyNode[] = []
  const stack = [...opts.roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    flat.push(n)
    stack.push(...n.children)
  }
  const { result } = renderHook(() => useEdgeProjection({
    edges: opts.edges,
    aggregatedEdges: new Map(),
    nodesByLayer: new Map([['L1', opts.roots]]),
    expandedNodes: new Set(),
    displayFlat: flat,
    displayMap: new Map(flat.map(n => [n.id, n])),
    urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
    showLineageFlow: true,
    isTracing: false,
    traceContextSet: new Set(),
    isContainmentEdge: () => false,
    ancestorChains: opts.chains ? new Map(Object.entries(opts.chains)) : undefined,
    hiddenEdgeTypes: opts.hidden ? new Set(opts.hidden) : undefined,
    holderEdges: new Map((opts.cells ?? []).map(([s, t, n]) => [`agg-${s}-${t}`, {
      id: `agg-${s}-${t}`, sourceUrn: s, targetUrn: t, edgeCount: n, edgeTypes: ['FLOWS_TO'], confidence: 1, sourceEdgeIds: [],
    }])),
  }))
  return result.current.offCanvasByNode
}

describe('useEdgeProjection — off-canvas lineage per row', () => {
  it('files each such line on the row it leaves or reaches, with its far end', () => {
    const off = run({
      roots: [hNode('orders'), hNode('customers')],
      edges: [
        edge('e1', 'orders', 'far-a'),
        edge('e2', 'orders', 'far-b'),
        edge('e3', 'far-c', 'orders'),
        edge('e4', 'orders', 'customers'),     // both on canvas: drawn, not a stub
      ],
    })
    const orders = off.get('orders')!
    expect(orders.out).toBe(2)
    expect(orders.in).toBe(1)
    expect([...orders.outPartners].sort()).toEqual(['far-a', 'far-b'])
    expect([...orders.inPartners]).toEqual(['far-c'])
    expect(off.has('customers')).toBe(false)
  })

  it('counts nothing when neither end is on the canvas — there is no row to carry it', () => {
    const off = run({ roots: [hNode('orders')], edges: [edge('e1', 'far-a', 'far-b')] })
    expect(off.size).toBe(0)
  })

  it('leaves a line to the roll-up when its far end can be placed', () => {
    const off = run({
      roots: [hNode('orders'), hNode('warehouse')],
      edges: [edge('e1', 'orders', 'unloaded-table')],
      chains: { 'unloaded-table': ['warehouse'] },
    })
    expect(off.size).toBe(0)
  })

  it('counts a roll-up edge as every flow it stands for, as a line would', () => {
    const rollup = { id: 'r1', source: 'orders', target: 'far-a', data: { edgeType: 'AGGREGATED', isAggregated: true, edgeCount: 40 } }
    const off = run({ roots: [hNode('orders')], edges: [rollup as ReturnType<typeof edge>, edge('e2', 'orders', 'far-b')] })
    expect(off.get('orders')!.out).toBe(41)
  })

  it('does not count what the reader chose to hide', () => {
    const off = run({
      roots: [hNode('orders')],
      edges: [edge('e1', 'orders', 'far-a', 'FEEDS'), edge('e2', 'orders', 'far-b', 'FLOWS_TO')],
      hidden: ['FEEDS'],
    })
    expect(off.get('orders')!.out).toBe(1)
  })
})

describe("useEdgeProjection — a closed container's own roll-ups beside its rows' flows", () => {
  // C is drawn closed; the store holds c1's flow out of the view. C's own
  // roll-up counts that flow among its three: it is not counted twice.
  it('counts a flow to an end outside once, where a roll-up of the row already counts it', () => {
    const off = run({
      roots: [hNode('C', [hNode('c1')])],
      edges: [edge('e1', 'c1', 'far-x')],
      cells: [['C', 'far-x', 3]],
    })
    expect(off.get('C')!.out).toBe(3)
    expect([...off.get('C')!.outPartners]).toEqual(['far-x'])
  })

  it('and where the roll-up names what holds that end', () => {
    const off = run({
      roots: [hNode('C', [hNode('c1')])],
      edges: [edge('e1', 'c1', 't1'), edge('e2', 'u1', 'c1')],
      chains: { t1: ['T'], T: [], u1: [] },
      cells: [['C', 'T', 3]],
    })
    expect(off.get('C')).toMatchObject({ out: 3, in: 1 })
  })
})
