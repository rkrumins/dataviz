/**
 * useEdgeProjection — virtual hops.
 *
 * The lineage-bridges walk says, at member grain, which entities of a curated
 * view reach which through steps the view leaves out. The projection's final
 * pass turns those links into lines between the rows the reader can see —
 * and only where no line already runs that way.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'

import { isBridgeLineId, useEdgeProjection, type BridgeLink } from '../useEdgeProjection'

const hNode = (id: string, children: HierarchyNode[] = []): HierarchyNode => ({
  id, typeId: 'entity', name: id, data: { urn: id, type: 'entity', label: id }, children,
  depth: 0, urn: id, entityTypeOption: 'entity', tags: [],
})

const edge = (id: string, source: string, target: string) =>
  ({ id, source, target, data: { edgeType: 'FLOWS_TO' } })

function run(opts: {
  roots: HierarchyNode[]
  visible?: string[]
  edges?: ReturnType<typeof edge>[]
  bridges?: BridgeLink[]
  tracing?: boolean
  layers?: Record<string, number>
}) {
  const all: HierarchyNode[] = []
  const stack = [...opts.roots]
  while (stack.length > 0) {
    const n = stack.pop()!
    all.push(n)
    stack.push(...n.children)
  }
  const flat = opts.visible ? all.filter(n => opts.visible!.includes(n.id)) : all
  const { result } = renderHook(() => useEdgeProjection({
    edges: opts.edges ?? [],
    aggregatedEdges: new Map(),
    nodesByLayer: new Map([['L1', opts.roots]]),
    expandedNodes: new Set(),
    displayFlat: flat,
    displayMap: new Map(flat.map(n => [n.id, n])),
    urnToIdMap: new Map(all.map(n => [n.urn!, n.id])),
    showLineageFlow: true,
    isTracing: opts.tracing ?? false,
    traceContextSet: new Set(),
    isContainmentEdge: () => false,
    nodeLayerIndexMap: opts.layers ? new Map(Object.entries(opts.layers)) : undefined,
    bridgeLinks: opts.bridges,
  }))
  return result.current.visibleLineageEdges.filter((e: { id: string }) => isBridgeLineId(e.id))
}

describe('useEdgeProjection — virtual hops', () => {
  it('draws a virtual hop between two entities no line joins', () => {
    const [line, ...rest] = run({
      roots: [hNode('A'), hNode('C')],
      bridges: [{ source: 'A', target: 'C', hops: 2 }],
    })
    expect(rest).toEqual([])
    expect(line).toMatchObject({ source: 'A', target: 'C', bridgeHops: 2, isGhost: false, types: [] })
    expect(line.data.bridgeLinks).toEqual([{ source: 'A', target: 'C', hops: 2 }])
  })

  it('stands aside for a real line running the same way', () => {
    expect(run({
      roots: [hNode('A'), hNode('C')],
      edges: [edge('e1', 'A', 'C')],
      bridges: [{ source: 'A', target: 'C', hops: 3 }],
    })).toEqual([])
  })

  it('still draws the other direction of a one-way real line', () => {
    const lines = run({
      roots: [hNode('A'), hNode('C')],
      edges: [edge('e1', 'A', 'C')],
      bridges: [{ source: 'C', target: 'A', hops: 3 }],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ source: 'C', target: 'A', bridgeHops: 3, isBidirectional: false })
  })

  it('merges both directions into one two-way line, shortest first', () => {
    const lines = run({
      roots: [hNode('A'), hNode('C')],
      bridges: [
        { source: 'A', target: 'C', hops: 4 },
        { source: 'C', target: 'A', hops: 2 },
      ],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ isBidirectional: true, bridgeHops: 2, edgeCount: 2 })
  })

  it('draws a direct link the canvas holds no line for as a roll-up', () => {
    const [line] = run({
      roots: [hNode('A'), hNode('B')],
      bridges: [{ source: 'A', target: 'B', hops: 1 }],
    })
    expect(line.isGhost).toBe(true)
    expect(line.bridgeHops).toBeUndefined()
  })

  it('lands a member folded into a closed group on the group', () => {
    const lines = run({
      roots: [hNode('G', [hNode('C')]), hNode('A')],
      visible: ['G', 'A'],
      bridges: [{ source: 'A', target: 'C', hops: 2 }],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ source: 'A', target: 'G' })
  })

  it('drops a link whose two ends land on the same row', () => {
    expect(run({
      roots: [hNode('G', [hNode('A'), hNode('C')])],
      visible: ['G'],
      bridges: [{ source: 'A', target: 'C', hops: 2 }],
    })).toEqual([])
  })

  it('drops a link to an entity that is not on the canvas', () => {
    expect(run({ roots: [hNode('A')], bridges: [{ source: 'A', target: 'nowhere', hops: 2 }] })).toEqual([])
  })

  it('marks a hop that points back upstream across the layers', () => {
    const [line] = run({
      roots: [hNode('A'), hNode('C')],
      layers: { A: 2, C: 0 },
      bridges: [{ source: 'A', target: 'C', hops: 2 }],
    })
    expect(line.isReverseFlow).toBe(true)
  })

  it('stays out of the way of a trace', () => {
    expect(run({
      roots: [hNode('A'), hNode('C')],
      tracing: true,
      bridges: [{ source: 'A', target: 'C', hops: 2 }],
    })).toEqual([])
  })
})
