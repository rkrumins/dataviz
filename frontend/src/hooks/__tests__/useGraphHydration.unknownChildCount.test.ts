/**
 * `loadChildren` when the child count is UNKNOWN.
 *
 * `childCount` is deliberately null on any read path that cannot count
 * containment edges live, and `/ancestors` — the path a deep reveal seeds its
 * chain from — is one of them. Folding that null into 0 meant every such
 * ancestor was treated as childless and its page never fetched: the reveal
 * stopped partway, the target never landed on the canvas, the drawer pointed
 * at an id the store did not hold, and the container rendered with no
 * children and no way to open it.
 *
 * Only a COUNTED zero means "nothing to load". Unknown means "ask".
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
import { useCanvasStore, type LineageNode } from '@/store/canvas'

const PARENT = 'urn:demo:table:P'

function makeNode(id: string, data: Partial<LineageNode['data']> = {}): LineageNode {
  return { id, position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'table', ...data } } as LineageNode
}

function seedWith(childCount: number | null | undefined) {
  const nodes = [makeNode(PARENT, { childCount } as never)]
  useCanvasStore.setState({
    nodes,
    edges: [],
    _nodeIndex: new Set(nodes.map((n) => n.id)),
    _edgeIndex: new Set(),
    visibleEdges: [],
  })
}

describe('loadChildren and an unknown child count', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() })
  })

  it('ASKS when the count is null — /ancestors cannot count, that is not "childless"', async () => {
    seedWith(null)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })

    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledWith(PARENT, expect.anything())
  })

  it('asks when the count is missing entirely', async () => {
    seedWith(undefined)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })

    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalled()
  })

  it('does NOT ask when the server counted zero', async () => {
    seedWith(0)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })

    expect(mockProvider.getChildrenWithEdges).not.toHaveBeenCalled()
  })

  it('still asks for a normal counted parent', async () => {
    seedWith(3)
    const { result } = renderHook(() => useGraphHydration())
    await act(async () => { await result.current.loadChildren(PARENT) })

    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalled()
  })
})
