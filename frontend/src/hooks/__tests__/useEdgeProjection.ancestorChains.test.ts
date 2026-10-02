/**
 * useEdgeProjection — lineage endpoints the canvas never loaded.
 *
 * A lineage edge names both of its ends; the canvas loads only what the
 * reader opened. With the far end's containment chain (useAncestorChains)
 * the projection files that end under the nearest container that IS on
 * canvas, so the line rolls up there instead of being counted as leading
 * outside the view. Measured live before this: 909 of 998 loaded lineage
 * edges were undrawable, their partners sitting inside containers on screen.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'

import { NO_PLACE_FOUND } from '../useAncestorChains'
import { useEdgeProjection } from '../useEdgeProjection'

const hNode = (id: string, children: HierarchyNode[] = []): HierarchyNode => ({
  id,
  typeId: 'entity',
  name: id,
  data: { urn: id, type: 'entity', label: id },
  children,
  depth: 0,
  urn: id,
  entityTypeOption: 'entity',
  tags: [],
})

const edge = (id: string, source: string, target: string) => ({
  id, source, target, data: { edgeType: 'FLOWS_TO' },
})

type Projected = { source: string; target: string; isGhost?: boolean }

function run(opts: {
  roots: HierarchyNode[]
  edges: ReturnType<typeof edge>[]
  chains?: Record<string, readonly string[]>
  expandedNodes?: Set<string>
  openScope?: boolean
}) {
  const flat: HierarchyNode[] = []
  const stack = [...opts.roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    flat.push(n)
    stack.push(...n.children)
  }
  const { result } = renderHook(() =>
    useEdgeProjection({
      edges: opts.edges,
      aggregatedEdges: new Map(),
      nodesByLayer: new Map([['L1', opts.roots]]),
      expandedNodes: opts.expandedNodes ?? new Set(),
      displayFlat: flat,
      displayMap: new Map(flat.map(n => [n.id, n])),
      urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
      showLineageFlow: true,
      isTracing: false,
      traceContextSet: new Set(),
      isContainmentEdge: () => false,
      ancestorChains: opts.chains ? new Map(Object.entries(opts.chains)) : undefined,
      openScope: opts.openScope,
    }),
  )
  return {
    ...result.current,
    lines: result.current.visibleLineageEdges as Projected[],
  }
}

describe('useEdgeProjection — ends filed under their chain', () => {
  it('rolls a line up to the nearest container on canvas, as a roll-up', () => {
    const res = run({
      roots: [hNode('fact'), hNode('warehouse')],
      edges: [edge('e1', 'fact', 'unloaded-table')],
      chains: { 'unloaded-table': ['warehouse'] },
    })
    expect(res.lines.map(l => [l.source, l.target])).toEqual([['fact', 'warehouse']])
    expect(res.lines[0].isGhost).toBe(true)
    expect(res.unresolvedEdgeCount).toBe(0)
  })

  it('walks the chain nearest-first, past ancestors that are not loaded either', () => {
    const res = run({
      roots: [hNode('fact'), hNode('platform', [hNode('schema')])],
      expandedNodes: new Set(['platform']),
      edges: [edge('e1', 'column', 'fact')],
      chains: { column: ['table', 'schema', 'platform'] },
    })
    expect(res.lines.map(l => [l.source, l.target])).toEqual([['schema', 'fact']])
  })

  it('lands on the collapsed row a loaded ancestor is folded into', () => {
    const res = run({
      roots: [hNode('fact'), hNode('platform', [hNode('schema')])],
      // `platform` closed: `schema` is loaded but anchored to it.
      edges: [edge('e1', 'column', 'fact')],
      chains: { column: ['table', 'schema', 'platform'] },
    })
    expect(res.lines.map(l => [l.source, l.target])).toEqual([['platform', 'fact']])
  })

  it('never lifts an end that is on canvas itself', () => {
    const res = run({
      roots: [hNode('fact'), hNode('warehouse'), hNode('table')],
      edges: [edge('e1', 'table', 'fact')],
      chains: { table: ['warehouse'] },
    })
    expect(res.lines.map(l => [l.source, l.target])).toEqual([['table', 'fact']])
    expect(res.lines[0].isGhost).toBeFalsy()
  })

  it('counts an end outside only once its chain reaches nothing on canvas; one not answered yet is pending', () => {
    const res = run({
      roots: [hNode('fact')],
      edges: [edge('e1', 'fact', 'no-chain'), edge('e2', 'fact', 'elsewhere')],
      chains: { elsewhere: ['other-schema', 'other-platform'] },
    })
    expect(res.lines).toHaveLength(0)
    expect(res.unresolvedEdgeCount).toBe(1)
    expect([...res.offCanvasByNode.get('fact')!.outPartners]).toEqual(['elsewhere'])
  })

  it('draws no line when both ends land in the same container — and says so', () => {
    const res = run({
      roots: [hNode('warehouse')],
      edges: [edge('e1', 'a', 'b')],
      chains: { a: ['warehouse'], b: ['warehouse'] },
    })
    expect(res.lines).toHaveLength(0)
    expect(res.unresolvedEdgeCount).toBe(0)
    expect(res.hiddenInsideCollapsedCount).toBe(1)
  })
})

describe('useEdgeProjection — an end whose place is not known', () => {
  it('holds a pending end on its row, per direction: no stub, not counted', () => {
    const res = run({
      roots: [hNode('fact')],
      edges: [edge('e1', 'fact', 'far'), edge('e2', 'src', 'fact'), edge('e3', 'src-2', 'fact')],
      chains: {},
    })
    const fact = res.offCanvasByNode.get('fact')!
    expect(fact.unplaced).toEqual({ in: 2, out: 1 })
    expect(fact.in + fact.out).toBe(0)
    expect(fact.inPartners.size + fact.outPartners.size).toBe(0)
    expect(res.unresolvedEdgeCount).toBe(0)
  })

  it('reads an end whose place was never found as unknown, never outside', () => {
    const lost = run({ roots: [hNode('fact')], edges: [edge('e1', 'fact', 'far')], chains: { far: NO_PLACE_FOUND } })
    expect(lost.offCanvasByNode.get('fact')).toMatchObject({ out: 0, unplaced: { in: 0, out: 1 } })
    expect(lost.unresolvedEdgeCount).toBe(0)

    // A real root is still outside.
    const root = run({ roots: [hNode('fact')], edges: [edge('e1', 'fact', 'far')], chains: { far: [] } })
    expect(root.offCanvasByNode.get('fact')).toMatchObject({ out: 1, unplaced: { in: 0, out: 0 } })
    expect(root.unresolvedEdgeCount).toBe(1)
  })
})

describe('useEdgeProjection — a view open to its whole data source', () => {
  it('never files an end outside: one whose chain reaches nothing drawn is in the view, column unknown', () => {
    const res = run({
      roots: [hNode('fact'), hNode('warehouse')],
      edges: [
        edge('e1', 'fact', 'feed-row-201'),
        edge('e2', 'a-root', 'fact'),
        edge('e3', 'fact', 'in-warehouse'),
      ],
      chains: { 'feed-row-201': ['unloaded-schema'], 'a-root': [], 'in-warehouse': ['warehouse'] },
      openScope: true,
    })
    const fact = res.offCanvasByNode.get('fact')!
    expect(fact.in + fact.out).toBe(0)
    expect(fact.unplaced).toEqual({ in: 1, out: 1 })
    // Named, for selecting the card to bring in.
    expect([...fact.unknownPartners!].sort()).toEqual(['a-root', 'feed-row-201'])
    expect(res.unresolvedEdgeCount).toBe(0)
    // An end a drawn container holds still rolls up to it.
    expect(res.lines.map(l => [l.source, l.target])).toEqual([['fact', 'warehouse']])
  })

  it('nor with no chain source at all', () => {
    const res = run({ roots: [hNode('fact')], edges: [edge('e1', 'fact', 'far')], openScope: true })
    expect(res.offCanvasByNode.get('fact')).toMatchObject({ out: 0, unplaced: { in: 0, out: 1 } })
    expect(res.unresolvedEdgeCount).toBe(0)
  })
})
