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
    expect(r.columns.get('L2')).toMatchObject({ out: 5, in: 0 })
    expect(r.columns.get('L2')!.outPartners.size).toBe(0)
    expect(r.out).toBe(0)
    expect(res.unresolvedEdgeCount).toBe(0)
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
