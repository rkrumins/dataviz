/**
 * `loadChildren` pagination vs. children primed by a search reveal.
 *
 * `useRevealSearchHit` attaches a hit that lives beyond page 1 directly —
 * node + containment edge — so the row renders without paging through every
 * sibling before it. That child is NOT part of any loaded page: counting it
 * in `currentChildrenCount` shifts the next page's offset by one and a real
 * sibling is skipped forever. It carries `data.viaReveal` for exactly this
 * reason (same rule as an optimistic `isPending: 'create'` child).
 *
 * Pinned here:
 *  - 100 loaded children + 1 revealed → the next page asks for offset 100.
 *  - when a page actually delivers the revealed child it becomes a normal
 *    loaded child: the flag is cleared so it counts from then on.
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
const REVEALED = 'urn:demo:column:beyond-page-1'

function childUrn(i: number): string {
  return `urn:demo:column:c${i}`
}

function makeNode(id: string, data: Partial<LineageNode['data']> = {}): LineageNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: id, urn: id, type: 'column', ...data },
  } as LineageNode
}

function makeContainmentEdge(target: string): LineageEdge {
  return {
    id: `c:${PARENT}>${target}`,
    source: PARENT,
    target,
    data: { edgeType: 'CONTAINS' },
  } as LineageEdge
}

/** Parent with 150 children: page 1 (100) loaded, plus one revealed child. */
function seedCanvas() {
  const loaded = Array.from({ length: 100 }, (_, i) => makeNode(childUrn(i)))
  const nodes: LineageNode[] = [
    makeNode(PARENT, { type: 'table', childCount: 150 }),
    ...loaded,
    makeNode(REVEALED, { viaReveal: true }),
  ]
  const edges: LineageEdge[] = [
    ...loaded.map((n) => makeContainmentEdge(n.id)),
    makeContainmentEdge(REVEALED),
  ]
  useCanvasStore.setState({
    nodes,
    edges,
    _nodeIndex: new Set(nodes.map((n) => n.id)),
    _edgeIndex: new Set(edges.map((e) => e.id)),
    visibleEdges: [],
  })
}

describe('loadChildren with a search-revealed child', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedCanvas()
  })

  it('excludes the revealed child from the page offset', async () => {
    const { result } = renderHook(() => useGraphHydration())

    await act(async () => {
      await result.current.loadChildren(PARENT)
    })

    expect(mockProvider.getChildrenWithEdges).toHaveBeenCalledWith(
      PARENT,
      expect.objectContaining({ offset: 100 }),
    )
  })

  it('clears the flag when a real page delivers the revealed child', async () => {
    mockProvider.getChildrenWithEdges.mockResolvedValueOnce({
      children: [
        { urn: REVEALED, entityType: 'column', displayName: 'beyond', properties: {} },
        { urn: childUrn(100), entityType: 'column', displayName: 'c100', properties: {} },
      ],
      containmentEdges: [
        { id: `c:${PARENT}>${REVEALED}`, sourceUrn: PARENT, targetUrn: REVEALED, edgeType: 'CONTAINS' },
        { id: `c:${PARENT}>${childUrn(100)}`, sourceUrn: PARENT, targetUrn: childUrn(100), edgeType: 'CONTAINS' },
      ],
      lineageEdges: [],
      totalChildren: 150,
      hasMore: true,
      nextCursor: null,
    } as any)

    const { result } = renderHook(() => useGraphHydration())

    await act(async () => {
      await result.current.loadChildren(PARENT)
    })

    const revealed = useCanvasStore.getState().nodes.find((n) => n.id === REVEALED)
    expect(revealed?.data.viaReveal).toBe(false)
  })
})
