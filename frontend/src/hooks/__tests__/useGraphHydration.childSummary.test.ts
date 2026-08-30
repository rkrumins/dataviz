/**
 * `loadChildren` reports what a page delivered; it never announces it.
 *
 * The canvas used to raise "Child entities loaded" from a global
 * `loadingNodes.size > 0` boolean — three containers expanded, three identical
 * messages, none of which could name a subject. The facts live here, so the
 * hook hands them back and the CALLER decides. GraphCanvas and HierarchyCanvas
 * share this hook and must stay silent, which is exactly why the hook does not
 * notify.
 *
 * Pinned: page 1 (offset 0) vs a later page (offset > 0), the arrived count,
 * the distinct child types the noun is chosen from, and the cases with nothing
 * true to say — a page that returned nothing, and a call that never ran.
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
  useViewRootEntityTypes: () => ['database'],
  useViewEntityTypes: () => [
    { id: 'database', hierarchy: { canBeContainedBy: [], canContain: ['dataset'] } },
    { id: 'dataset', hierarchy: { canBeContainedBy: ['database'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v1',
    layout: { type: 'reference', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['database', 'dataset'] },
  }),
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string; relationship?: string } }) =>
    (e.data?.edgeType || e.data?.relationship || '').toUpperCase(),
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'

const PARENT = 'urn:demo:database:snowflake'

const childUrn = (i: number) => `urn:demo:dataset:d${i}`

function makeNode(id: string, data: Partial<LineageNode['data']> = {}): LineageNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: id, urn: id, type: 'dataset', ...data },
  } as LineageNode
}

function makeContainmentEdge(target: string): LineageEdge {
  return { id: `c:${PARENT}>${target}`, source: PARENT, target, data: { edgeType: 'CONTAINS' } } as LineageEdge
}

/** A container declaring `childCount` children, with `loaded` of them already in the store. */
function seedCanvas(childCount: number, loaded: number) {
  const kids = Array.from({ length: loaded }, (_, i) => makeNode(childUrn(i)))
  const nodes = [
    makeNode(PARENT, { label: 'Snowflake', type: 'database', childCount }),
    ...kids,
  ]
  const edges = kids.map((k) => makeContainmentEdge(k.id))
  useCanvasStore.setState({
    nodes,
    edges,
    _nodeIndex: new Set(nodes.map((n) => n.id)),
    _edgeIndex: new Set(edges.map((e) => e.id)),
    visibleEdges: [],
  })
}

function page(children: { urn: string; entityType: string }[]) {
  return {
    children: children.map((c) => ({ ...c, displayName: c.urn, properties: {} })),
    containmentEdges: children.map((c) => ({
      id: `c:${PARENT}>${c.urn}`, sourceUrn: PARENT, targetUrn: c.urn, edgeType: 'CONTAINS',
    })),
    lineageEdges: [],
    totalChildren: 41,
    hasMore: true,
    nextCursor: null,
  } as any
}

describe('loadChildren hands back what the page delivered', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports page 1 with offset 0, the container by name, and the child type', async () => {
    seedCanvas(41, 0)
    mockProvider.getChildrenWithEdges.mockResolvedValueOnce(
      page([0, 1, 2, 3, 4].map((i) => ({ urn: childUrn(i), entityType: 'dataset' }))),
    )
    const { result } = renderHook(() => useGraphHydration())

    let summary: Awaited<ReturnType<typeof result.current.loadChildren>>
    await act(async () => { summary = await result.current.loadChildren(PARENT) })

    expect(summary).toEqual({
      parentLabel: 'Snowflake',
      parentType: 'database',
      arrived: 5,
      offset: 0,
      total: 41,
      childTypes: ['dataset'],
    })
  })

  it('reports a later page with the offset it was fetched at', async () => {
    seedCanvas(41, 5)
    mockProvider.getChildrenWithEdges.mockResolvedValueOnce(
      page([5, 6, 7, 8, 9].map((i) => ({ urn: childUrn(i), entityType: 'dataset' }))),
    )
    const { result } = renderHook(() => useGraphHydration())

    let summary: Awaited<ReturnType<typeof result.current.loadChildren>>
    await act(async () => { summary = await result.current.loadChildren(PARENT) })

    expect(summary?.offset).toBe(5)
    expect(summary?.arrived).toBe(5)
    expect(summary?.total).toBe(41)
  })

  it('collapses duplicate child types, so a mixed page is visibly mixed', async () => {
    seedCanvas(41, 0)
    mockProvider.getChildrenWithEdges.mockResolvedValueOnce(page([
      { urn: childUrn(0), entityType: 'dataset' },
      { urn: childUrn(1), entityType: 'dataset' },
      { urn: 'urn:demo:view:v1', entityType: 'view' },
    ]))
    const { result } = renderHook(() => useGraphHydration())

    let summary: Awaited<ReturnType<typeof result.current.loadChildren>>
    await act(async () => { summary = await result.current.loadChildren(PARENT) })

    expect(summary?.childTypes).toEqual(['dataset', 'view'])
  })

  it('still reports a page that brought nothing back', async () => {
    seedCanvas(41, 5)
    mockProvider.getChildrenWithEdges.mockResolvedValueOnce(page([]))
    const { result } = renderHook(() => useGraphHydration())

    let summary: Awaited<ReturnType<typeof result.current.loadChildren>>
    await act(async () => { summary = await result.current.loadChildren(PARENT) })

    expect(summary?.arrived).toBe(0)
    expect(summary?.offset).toBe(5)
  })

  it('reports nothing when no fetch ran — every child is already loaded', async () => {
    seedCanvas(5, 5)
    const { result } = renderHook(() => useGraphHydration())

    let summary: Awaited<ReturnType<typeof result.current.loadChildren>>
    await act(async () => { summary = await result.current.loadChildren(PARENT) })

    expect(mockProvider.getChildrenWithEdges).not.toHaveBeenCalled()
    expect(summary).toBeUndefined()
  })
})
