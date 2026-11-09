/**
 * `loadChildren` vs. tombstones — deleted entities a draft or comparison draws where they were, each
 * with its old containment edge, so it nests under its parent.
 *
 * They are not children the graph still has. Counted as loaded, a parent whose tombstones fill its
 * childCount never loads its live children: the "all loaded" short-circuit fires. And a tombstone
 * itself has no page to fetch — the graph no longer has it, and what it held is drawn with it.
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(async () => ({
      children: [],
      containmentEdges: [],
      lineageEdges: [],
      totalChildren: 0,
      hasMore: false,
      nextCursor: null,
    })),
  },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['table'],
  useViewEntityTypes: () => [
    { id: 'table', hierarchy: { canBeContainedBy: [], canContain: ['column'] } },
    { id: 'column', hierarchy: { canBeContainedBy: ['table'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v1',
    layout: { type: 'reference', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['table', 'column'] },
  }),
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string; relationship?: string } }) =>
    (e.data?.edgeType || e.data?.relationship || '').toUpperCase(),
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'

const PARENT = 'urn:demo:table:P'

function makeNode(id: string, data: Partial<LineageNode['data']> = {}): LineageNode {
  return { id, position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'column', ...data } } as LineageNode
}

function contains(source: string, target: string, data: Record<string, unknown> = {}): LineageEdge {
  return { id: `c:${source}>${target}`, source, target, data: { edgeType: 'CONTAINS', ...data } } as LineageEdge
}

function seed(nodes: LineageNode[], edges: LineageEdge[]) {
  useCanvasStore.setState({
    nodes,
    edges,
    _nodeIndex: new Set(nodes.map((n) => n.id)),
    _edgeIndex: new Set(edges.map((e) => e.id)),
    childPaging: {},
    visibleEdges: [],
  })
}

describe('loadChildren with tombstones', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('still loads the live children of a parent whose tombstones fill its childCount', async () => {
    // Two columns live, two deleted in the draft and drawn: four rows, none of them a page.
    const gone = ['urn:demo:column:gone-1', 'urn:demo:column:gone-2']
    seed(
      [makeNode(PARENT, { type: 'table', childCount: 2 }), ...gone.map((id) => makeNode(id, { isGhost: true }))],
      gone.map((id) => contains(PARENT, id, { isGhost: true })),
    )
    const { result } = renderHook(() => useGraphHydration())

    await act(async () => {
      await result.current.loadChildren(PARENT)
    })

    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledWith(PARENT, expect.objectContaining({ offset: 0 }))
  })

  it('asks nothing for a tombstone', async () => {
    const GONE = 'urn:demo:table:gone'
    seed(
      [makeNode(GONE, { type: 'table', childCount: 3, isGhost: true })],
      [],
    )
    const { result } = renderHook(() => useGraphHydration())

    await act(async () => {
      await result.current.loadChildren(GONE)
    })

    expect(mockProvider.getChildrenWithEdges).not.toHaveBeenCalled()
  })
})
