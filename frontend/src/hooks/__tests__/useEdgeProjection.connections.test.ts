/**
 * useEdgeProjection — connection visibility and the roll-up (ghost) rule.
 *
 * 1. `isGhost` means "this line stands for something other than the raw
 *    relationship between the two cards it touches": an AGGREGATED edge, a
 *    browse-meta-bundle, or an edge whose endpoint was resolved up to an
 *    ancestor. The old rule compared `originalSourceId`/`originalTargetId`,
 *    fields nothing ever assigns, so EVERY bundle came back a ghost and every
 *    line on the board drew dashed.
 * 2. `hiddenEdgeTypes` is applied per GROUP MEMBER: a bundle whose members all
 *    carry only hidden types disappears; a mixed bundle keeps a reduced
 *    `edgeCount` and loses the hidden type from `types`. Grouping itself is
 *    untouched, and hiding never moves `unresolvedEdgeCount`.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useEdgeProjection } from '../useEdgeProjection'
import type { HierarchyNode } from '@/types/hierarchy'

const hNode = (id: string, children: HierarchyNode[] = [], data: Record<string, unknown> = {}): HierarchyNode => ({
  id,
  typeId: 'entity',
  name: id,
  data: { urn: id, type: 'entity', label: id, ...data },
  children,
  depth: 0,
  urn: id,
  entityTypeOption: 'entity',
  tags: [],
})

const edge = (id: string, source: string, target: string, type = 'FLOWS_TO', edgeTypes?: string[]) => ({
  id, source, target,
  data: edgeTypes === undefined
    ? { edgeType: type }
    : { edgeType: type, edgeTypes },
})

/** One collapsed AGGREGATED entry as `aggregatedEdges` holds them. */
const aggEntry = (id: string, sourceUrn: string, targetUrn: string, edgeTypes: string[] = ['FLOWS_TO']) => ([
  id,
  {
    state: 'collapsed',
    detailedEdges: [],
    aggregated: { id, sourceUrn, targetUrn, edgeCount: 7, edgeTypes, confidence: 1 },
  },
])

/** One EXPANDED entry — its `detailedEdges` take the urn-keyed case-C path. */
const expandedEntry = (id: string, detailedEdges: Array<{ id: string; sourceUrn: string; targetUrn: string; edgeType: string }>) => ([
  id,
  {
    state: 'expanded',
    detailedEdges,
    aggregated: { id, sourceUrn: detailedEdges[0].sourceUrn, targetUrn: detailedEdges[0].targetUrn, edgeCount: detailedEdges.length, edgeTypes: [], confidence: 1 },
  },
])

function run(opts: {
  edges?: ReturnType<typeof edge>[]
  roots: HierarchyNode[]
  aggregatedEdges?: Map<string, any>
  expandedNodes?: Set<string>
  parentMap?: Map<string, string>
  browseBundleEnabled?: boolean
  hiddenEdgeTypes?: ReadonlySet<string>
  hoveredNodeId?: string | null
}) {
  const flat: HierarchyNode[] = []
  const stack = [...opts.roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    flat.push(n)
    stack.push(...n.children)
  }
  const displayMap = new Map(flat.map(n => [n.id, n]))
  const urnToIdMap = new Map(flat.map(n => [n.urn!, n.id]))
  const { result } = renderHook(() =>
    useEdgeProjection({
      edges: opts.edges ?? [],
      aggregatedEdges: opts.aggregatedEdges ?? new Map(),
      nodesByLayer: new Map([['L1', opts.roots]]),
      expandedNodes: opts.expandedNodes ?? new Set(),
      displayFlat: flat,
      displayMap,
      urnToIdMap,
      showLineageFlow: true,
      isTracing: false,
      traceContextSet: new Set(),
      isContainmentEdge: () => false,
      hoveredNodeId: opts.hoveredNodeId ?? null,
      browseBundleEnabled: opts.browseBundleEnabled,
      browseBundleParentMap: opts.parentMap,
      hiddenEdgeTypes: opts.hiddenEdgeTypes,
    }),
  )
  return result.current
}

type Projected = {
  source: string
  target: string
  isGhost: boolean
  isBrowseBundle: boolean
  isAggregated: boolean
  isBidirectional: boolean
  edgeCount: number
  types: string[]
}

const bundles = (res: ReturnType<typeof run>) => res.visibleLineageEdges as Projected[]

describe('useEdgeProjection — the roll-up (isGhost) rule', () => {
  it('a direct edge between two visible cards is not a roll-up', () => {
    const res = run({
      roots: [hNode('a'), hNode('b')],
      edges: [edge('e1', 'a', 'b')],
    })
    expect(bundles(res)).toHaveLength(1)
    expect(bundles(res)[0].isGhost).toBe(false)
  })

  it('an edge whose endpoint rolls up to a collapsed ancestor is a roll-up', () => {
    const c1 = hNode('c1')
    c1.depth = 1
    const res = run({
      roots: [hNode('p', [c1]), hNode('b')],   // p collapsed → c1 resolves to p
      edges: [edge('e1', 'c1', 'b')],
    })
    const pb = bundles(res).find(e => e.source === 'p' && e.target === 'b')
    expect(pb).toBeDefined()
    expect(pb!.isGhost).toBe(true)
  })

  it('an AGGREGATED edge is a roll-up even when both endpoints are visible', () => {
    const res = run({
      roots: [hNode('a'), hNode('b')],
      aggregatedEdges: new Map([aggEntry('agg1', 'a', 'b')] as any),
    })
    expect(bundles(res)).toHaveLength(1)
    expect(bundles(res)[0].isAggregated).toBe(true)
    expect(bundles(res)[0].isGhost).toBe(true)
  })

  it('a browse-meta-bundled group is a roll-up', () => {
    const res = run({
      roots: [hNode('s1'), hNode('s2'), hNode('t')],
      edges: [edge('e1', 's1', 't'), edge('e2', 's2', 't')],
      browseBundleEnabled: true,
      parentMap: new Map([['s1', 'sp'], ['s2', 'sp']]),
    })
    const sp = bundles(res).find(e => e.source === 'sp' && e.target === 't')
    expect(sp).toBeDefined()
    expect(sp!.isBrowseBundle).toBe(true)
    expect(sp!.isGhost).toBe(true)
  })

  it('a bidirectional pair is a roll-up when either direction is', () => {
    const res = run({
      roots: [hNode('a'), hNode('b')],
      edges: [edge('e1', 'a', 'b')],                                   // forward: raw
      aggregatedEdges: new Map([aggEntry('agg1', 'b', 'a')] as any),   // reverse: AGGREGATED
    })
    expect(bundles(res)).toHaveLength(1)
    expect(bundles(res)[0].isBidirectional).toBe(true)
    expect(bundles(res)[0].isGhost).toBe(true)
  })

  it('a detailed edge whose endpoint is a collapsed child is a roll-up', () => {
    const c1 = hNode('c1')
    c1.depth = 1
    const res = run({
      roots: [hNode('p', [c1]), hNode('b')],   // p collapsed → c1 resolves to p
      aggregatedEdges: new Map([expandedEntry('agg1', [
        { id: 'd1', sourceUrn: 'c1', targetUrn: 'b', edgeType: 'FLOWS_TO' },
      ])] as any),
    })
    const pb = bundles(res).find(e => e.source === 'p' && e.target === 'b')
    expect(pb).toBeDefined()
    expect(pb!.isGhost).toBe(true)
  })

  it('a detailed edge whose endpoint urn is unknown is not marked lifted', () => {
    // c1 owns the urn `urn:c1`, so the edge's `c1` endpoint is absent from
    // urnToIdMap — the projection must not claim a lift it cannot prove.
    const c1: HierarchyNode = { ...hNode('c1'), urn: 'urn:c1', depth: 1 }
    const res = run({
      roots: [hNode('p', [c1]), hNode('b')],
      aggregatedEdges: new Map([expandedEntry('agg1', [
        { id: 'd1', sourceUrn: 'c1', targetUrn: 'b', edgeType: 'FLOWS_TO' },
      ])] as any),
    })
    const pb = bundles(res).find(e => e.source === 'p' && e.target === 'b')
    expect(pb).toBeDefined()
    expect(pb!.isGhost).toBe(false)
  })
})

describe('useEdgeProjection — hidden connection types', () => {
  it('hiding a type drops bundles whose members all carry it', () => {
    const res = run({
      roots: [hNode('a'), hNode('b'), hNode('c'), hNode('d')],
      edges: [
        edge('e1', 'a', 'b', 'FLOWS_TO'),
        // lowercase on the wire — the hidden set is UPPERCASE keys
        edge('e2', 'c', 'd', 'DERIVES_FROM', ['derives_from']),
      ],
      hiddenEdgeTypes: new Set(['DERIVES_FROM']),
    })
    expect(bundles(res)).toHaveLength(1)
    expect(bundles(res)[0].source).toBe('a')
    expect(bundles(res)[0].types).toEqual(['FLOWS_TO'])
  })

  it('a mixed bundle survives with a reduced edgeCount and the hidden type gone from types', () => {
    const res = run({
      roots: [hNode('a'), hNode('b')],
      edges: [
        edge('e1', 'a', 'b', 'FLOWS_TO'),
        edge('e2', 'a', 'b', 'FLOWS_TO'),
        edge('e3', 'a', 'b', 'DERIVES_FROM'),
      ],
      hiddenEdgeTypes: new Set(['DERIVES_FROM']),
    })
    expect(bundles(res)).toHaveLength(1)
    expect(bundles(res)[0].edgeCount).toBe(2)
    expect(bundles(res)[0].types).toEqual(['FLOWS_TO'])
  })

  it('a member whose data.edgeTypes is an empty array still contributes its originalType', () => {
    const res = run({
      roots: [hNode('a'), hNode('b')],
      edges: [edge('e1', 'a', 'b', 'FLOWS_TO', [])],
    })
    expect(bundles(res)).toHaveLength(1)
    expect(bundles(res)[0].types).toEqual(['FLOWS_TO'])
  })

  it('hiding a type does not change unresolvedEdgeCount', () => {
    const edges = [
      edge('e1', 'a', 'b', 'FLOWS_TO'),
      edge('e2', 'a', 'ghost', 'DERIVES_FROM'),  // target unresolved → counted
    ]
    const before = run({ roots: [hNode('a'), hNode('b')], edges })
    const after = run({
      roots: [hNode('a'), hNode('b')],
      edges,
      hiddenEdgeTypes: new Set(['FLOWS_TO', 'DERIVES_FROM']),
    })
    expect(before.unresolvedEdgeCount).toBe(1)
    expect(after.unresolvedEdgeCount).toBe(1)
    expect(after.visibleLineageEdges).toHaveLength(0)
  })

  it('an empty hidden set is a no-op', () => {
    const edges = [
      edge('e1', 'a', 'b', 'FLOWS_TO'),
      edge('e2', 'a', 'b', 'FLOWS_TO'),
      edge('e3', 'a', 'b', 'DERIVES_FROM'),
    ]
    const none = run({ roots: [hNode('a'), hNode('b')], edges })
    const empty = run({ roots: [hNode('a'), hNode('b')], edges, hiddenEdgeTypes: new Set<string>() })
    expect(bundles(empty)).toHaveLength(bundles(none).length)
    expect(bundles(empty)[0].edgeCount).toBe(bundles(none)[0].edgeCount)
    expect(bundles(empty)[0].types).toEqual(bundles(none)[0].types)
    expect(bundles(empty)[0].edgeCount).toBe(3)
  })
})
