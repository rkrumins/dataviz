/**
 * useEdgeProjection — lineage into rows the view holds but has not loaded.
 *
 * The rows' own roll-ups are asked among the rows drawn. A HOLDER is what
 * holds the rest: an anchor with rows past its loaded page, or an open
 * container with children not loaded yet. Its cell with a row counts every
 * flow into it, the loaded rows' included, so the projection keeps only the
 * rest: w(row, holder) − Σ w(row, X) over the loaded ends X nearest under it,
 * floored at 0.
 *
 *   - An anchor's rest is lineage into its column's rows not loaded yet: in
 *     the view, filed under that column with no partner, never a stub.
 *   - An open container's rest is lineage into its children not loaded yet:
 *     a faint (residual) line to the container.
 *   - A row's own anchor is a roll-up of itself and says nothing: partners in
 *     a row's OWN column past the page cannot be told from its own flows.
 *
 * A closed row holds what is under it the same way, and a child of it placed
 * in another column is a row of its own: each cell keeps only its own flows,
 * by inclusion–exclusion over the rows nearest under each end.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'

import { useEdgeProjection } from '../useEdgeProjection'

const hNode = (id: string, children: HierarchyNode[] = [], data: Record<string, unknown> = {}): HierarchyNode => ({
  id, typeId: 'entity', name: id, data: { urn: id, type: 'entity', label: id, ...data }, children,
  depth: 0, urn: id, entityTypeOption: 'entity', tags: [],
})

const cell = (sourceUrn: string, targetUrn: string, edgeCount: number) => ({
  id: `agg-${sourceUrn}-${targetUrn}`, sourceUrn, targetUrn, edgeCount,
  edgeTypes: ['FLOWS_TO'], confidence: 1, sourceEdgeIds: [],
})

const rowCell = (sourceUrn: string, targetUrn: string, edgeCount: number) => {
  const c = cell(sourceUrn, targetUrn, edgeCount)
  return [c.id, { state: 'collapsed' as const, detailedEdges: [], aggregated: c }] as const
}

/**
 * R is a row of column L1. Column L2 is anchored at A: rows a1 and a2 are
 * loaded, more are not. Column L3 holds P, whose children are not all loaded.
 */
function run(opts: {
  layers?: Record<string, HierarchyNode[]>
  rows?: Array<ReturnType<typeof rowCell>>
  holders?: Array<ReturnType<typeof cell>>
  expandedNodes?: Set<string>
  parentMap?: Record<string, string>
  chains?: Record<string, string[]>
}) {
  const layers = opts.layers ?? {
    L1: [hNode('R')],
    L2: [hNode('a1'), hNode('a2')],
    L3: [hNode('P', [hNode('c1')], { childCount: 5 })],
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
    edges: [],
    aggregatedEdges: new Map(opts.rows ?? []) as Map<string, unknown>,
    holderEdges: new Map((opts.holders ?? []).map(c => [c.id, c])),
    nodesByLayer,
    expandedNodes: opts.expandedNodes ?? new Set(),
    displayFlat: flat,
    displayMap: new Map(flat.map(n => [n.id, n])),
    urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
    showLineageFlow: true,
    isTracing: false,
    traceContextSet: new Set(),
    isContainmentEdge: () => false,
    browseBundleParentMap: new Map(Object.entries(opts.parentMap ?? { a1: 'A', a2: 'A', c1: 'P' })),
    promotedAnchors: new Map([['A', 'L2']]),
    ancestorChains: opts.chains && new Map(Object.entries(opts.chains)),
  }))
  const lines = result.current.visibleLineageEdges as Array<{ source: string; target: string; edgeCount: number; isResidual: boolean }>
  return {
    ...result.current,
    lines: lines.map(l => [l.source, l.target, l.edgeCount, l.isResidual] as const)
      .sort((x, y) => (`${x[0]}>${x[1]}` < `${y[0]}>${y[1]}` ? -1 : 1)),
  }
}

describe('an anchor holding rows not loaded yet', () => {
  it('files what its loaded rows do not carry under its column, with no partner and no stub', () => {
    const res = run({
      rows: [rowCell('R', 'a1', 3), rowCell('R', 'a2', 2)],
      holders: [cell('R', 'A', 10)],
    })
    expect(res.lines).toEqual([['R', 'a1', 3, false], ['R', 'a2', 2, false]])
    const r = res.offCanvasByNode.get('R')!
    expect(r.columns.get('L2')).toMatchObject({ out: 5, in: 0, unnamed: { in: 0, out: 5 } })
    expect(r.columns.get('L2')!.outPartners.size).toBe(0)
    expect(r.out).toBe(0)
    expect(res.unresolvedEdgeCount).toBe(0)
  })

  it('keeps apart what it names no row for, beside a row past the page it does name', () => {
    // A selected container's own roll-up names a9, a row of A not loaded.
    const res = run({
      holders: [cell('R', 'A', 10), cell('R', 'a9', 4)],
      chains: { a9: ['A'] },
    })
    const column = res.offCanvasByNode.get('R')!.columns.get('L2')!
    expect(column).toMatchObject({ out: 10, unnamed: { in: 0, out: 6 } })
    expect([...column.outPartners]).toEqual(['a9'])
  })

  it('files nothing when the loaded rows carry it all', () => {
    const res = run({
      rows: [rowCell('R', 'a1', 3), rowCell('R', 'a2', 2)],
      holders: [cell('R', 'A', 5)],
    })
    expect(res.offCanvasByNode.get('R')?.columns.get('L2')).toBeUndefined()
  })

  it('works the other way: lineage from its rows not loaded arrives at the row', () => {
    const res = run({
      rows: [rowCell('a1', 'R', 1)],
      holders: [cell('A', 'R', 4)],
    })
    expect(res.offCanvasByNode.get('R')!.columns.get('L2')).toMatchObject({ in: 3, out: 0 })
  })

  it("says nothing about a row's own column: that is the row summarised against itself", () => {
    const res = run({ holders: [cell('a1', 'A', 6), cell('A', 'a2', 2)] })
    expect(res.lines).toEqual([])
    expect(res.offCanvasByNode.size).toBe(0)
    expect(res.unresolvedEdgeCount).toBe(0)
  })
})

describe('an open container holding children not loaded yet', () => {
  it('draws a faint line carrying only what its loaded children do not', () => {
    const res = run({
      expandedNodes: new Set(['P']),
      rows: [rowCell('R', 'c1', 5)],
      holders: [cell('R', 'P', 9)],
    })
    expect(res.lines).toEqual([['R', 'P', 4, true], ['R', 'c1', 5, false]])
  })

  it('draws nothing to it when its loaded children carry it all', () => {
    const res = run({
      expandedNodes: new Set(['P']),
      rows: [rowCell('R', 'c1', 5)],
      holders: [cell('R', 'P', 5)],
    })
    expect(res.lines).toEqual([['R', 'c1', 5, false]])
  })

  it('nested in an anchored column: each holder keeps only what is below it and not loaded', () => {
    // A ⊃ {C, a2}; C is open with c1 loaded and more to come.
    const res = run({
      layers: {
        L1: [hNode('R')],
        L2: [hNode('C', [hNode('c1')], { childCount: 4 }), hNode('a2')],
      },
      parentMap: { C: 'A', c1: 'C', a2: 'A' },
      expandedNodes: new Set(['C']),
      rows: [rowCell('R', 'c1', 2), rowCell('R', 'a2', 1)],
      holders: [cell('R', 'A', 10), cell('R', 'C', 6)],
    })
    expect(res.lines).toEqual([['R', 'C', 4, true], ['R', 'a2', 1, false], ['R', 'c1', 2, false]])
    expect(res.offCanvasByNode.get('R')!.columns.get('L2')).toMatchObject({ out: 3 })
  })
})

describe('a row drawn apart from the row that holds it', () => {
  // P is closed in L1; its child C is placed in L2. Both are rows, so the
  // server's cell for P counts C's flows too.
  const layers = { L1: [hNode('P')], L2: [hNode('C')], L3: [hNode('R'), hNode('Q'), hNode('D')] }

  it("keeps on the holder only what the nested row does not carry, and draws nothing between the two", () => {
    const res = run({
      layers,
      parentMap: { C: 'P' },
      rows: [rowCell('P', 'R', 5), rowCell('C', 'R', 3), rowCell('C', 'P', 1)],
    })
    expect(res.lines).toEqual([['C', 'R', 3, false], ['P', 'R', 2, false]])
  })

  it('works on both ends at once', () => {
    // Q holds D the same way. Flows: p→q 1, c→q 2, p→d 4, c→d 8.
    const res = run({
      layers,
      parentMap: { C: 'P', D: 'Q' },
      rows: [rowCell('P', 'Q', 15), rowCell('C', 'Q', 10), rowCell('P', 'D', 12), rowCell('C', 'D', 8)],
    })
    expect(res.lines).toEqual([['C', 'D', 8, false], ['C', 'Q', 2, false], ['P', 'D', 4, false], ['P', 'Q', 1, false]])
  })

  it('finds the holder through a chain when the rows between are not loaded', () => {
    const { result } = renderHook(() => useEdgeProjection({
      edges: [],
      aggregatedEdges: new Map([rowCell('P', 'R', 5), rowCell('C', 'R', 3)]) as Map<string, unknown>,
      nodesByLayer: new Map(Object.entries(layers)),
      expandedNodes: new Set(),
      displayFlat: Object.values(layers).flat(),
      displayMap: new Map(Object.values(layers).flat().map(n => [n.id, n])),
      urnToIdMap: new Map(Object.values(layers).flat().map(n => [n.urn!, n.id])),
      showLineageFlow: true,
      isTracing: false,
      traceContextSet: new Set(),
      isContainmentEdge: () => false,
      browseBundleParentMap: new Map(),
      ancestorChains: new Map([['C', ['M', 'P']]]),
    }))
    const lines = (result.current.visibleLineageEdges as Array<{ source: string; target: string; edgeCount: number }>)
      .map(l => [l.source, l.target, l.edgeCount])
    expect(lines).toContainEqual(['P', 'R', 2])
    expect(lines).toContainEqual(['C', 'R', 3])
  })
})

describe('an open container with a child drawn in another column', () => {
  it('counts that child as loaded: its lines stand aside for the children, not faint', () => {
    // P holds c1 (drawn under it) and C (drawn in L2): both loaded, so P is not partial.
    const res = renderHook(() => useEdgeProjection({
      edges: [
        { id: 'e1', source: 'P', target: 'R', data: { edgeType: 'FLOWS_TO' } },
        { id: 'e2', source: 'c1', target: 'R', data: { edgeType: 'FLOWS_TO' } },
      ],
      aggregatedEdges: new Map(),
      nodesByLayer: new Map([['L1', [hNode('P', [hNode('c1')], { childCount: 2 })]], ['L2', [hNode('C')]], ['L3', [hNode('R')]]]),
      expandedNodes: new Set(['P']),
      displayFlat: [hNode('P', [hNode('c1')], { childCount: 2 }), hNode('c1'), hNode('C'), hNode('R')],
      displayMap: new Map([['P', hNode('P', [hNode('c1')], { childCount: 2 })], ['c1', hNode('c1')], ['C', hNode('C')], ['R', hNode('R')]]),
      urnToIdMap: new Map([['P', 'P'], ['c1', 'c1'], ['C', 'C'], ['R', 'R']]),
      showLineageFlow: true,
      isTracing: false,
      traceContextSet: new Set(),
      isContainmentEdge: () => false,
      browseBundleParentMap: new Map([['c1', 'P'], ['C', 'P']]),
    })).result.current
    const pr = (res.visibleLineageEdges as Array<{ source: string; target: string; isDelegated: boolean; isResidual: boolean }>)
      .find(l => l.source === 'P' && l.target === 'R')
    expect(pr).toMatchObject({ isDelegated: true, isResidual: false })
  })
})
