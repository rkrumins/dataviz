/**
 * useEdgeProjection — a deleted line.
 *
 * A line draws one or more links. It reads as deleted — rose, in short dashes — only when every
 * link it draws is a deletion, saved to the draft (a ghost) or not saved yet (`isPending`). One
 * live link among them keeps it live, and a two-way line is deleted only when both ways are.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'

import { useEdgeProjection } from '../useEdgeProjection'

const hNode = (id: string): HierarchyNode => ({
  id, typeId: 'entity', name: id, data: { urn: id, type: 'entity', label: id }, children: [],
  depth: 0, urn: id, entityTypeOption: 'entity', tags: [],
})

const link = (id: string, source: string, target: string, data: Record<string, unknown> = {}) =>
  ({ id, source, target, data: { edgeType: 'FLOWS_TO', ...data } })

function lines(edges: ReturnType<typeof link>[]) {
  const roots = { L1: [hNode('A')], L2: [hNode('B')] }
  const flat = [hNode('A'), hNode('B')]
  const { result } = renderHook(() => useEdgeProjection({
    edges,
    aggregatedEdges: new Map(),
    nodesByLayer: new Map(Object.entries(roots)),
    expandedNodes: new Set(),
    displayFlat: flat,
    displayMap: new Map(flat.map(n => [n.id, n])),
    urnToIdMap: new Map(flat.map(n => [n.urn!, n.id])),
    showLineageFlow: true,
    isTracing: false,
    traceContextSet: new Set(),
    isContainmentEdge: () => false,
  }))
  return result.current.visibleLineageEdges as Array<{ source: string; target: string; isDeleted?: boolean }>
}

describe('useEdgeProjection — deleted lines', () => {
  it('is deleted when every link it draws is a deletion, saved or not yet', () => {
    const [line] = lines([link('e1', 'A', 'B', { isGhost: true }), link('e2', 'A', 'B', { isPending: 'delete' })])
    expect(line.isDeleted).toBe(true)
  })

  it('stays live while one link it draws is live', () => {
    const [line] = lines([link('e1', 'A', 'B', { isGhost: true }), link('e2', 'A', 'B')])
    expect(line.isDeleted).toBe(false)
  })

  it('is deleted both ways only when both ways are', () => {
    const both = lines([link('e1', 'A', 'B', { isGhost: true }), link('e2', 'B', 'A', { isGhost: true })])
    expect(both).toHaveLength(1)
    expect(both[0].isDeleted).toBe(true)
    const one = lines([link('e1', 'A', 'B', { isGhost: true }), link('e2', 'B', 'A')])
    expect(one[0].isDeleted).toBe(false)
  })
})
