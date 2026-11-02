/**
 * useDuplicateSubtree — the Duplicate… dialog's choices.
 *
 * `prepareDuplicate` reads the subtree's relationships across its boundary from
 * the SERVER (not only what the canvas has drawn) and answers `count(choice)`
 * for any choice; `commitDuplicate` stages exactly that choice. A boundary edge
 * keeps its original partner at the far end. Description and source system
 * land as node fields, so the copy describes itself.
 *
 * Fixture: p -CONTAINS-> r -CONTAINS-> c1, c2; c1 -FLOWS_TO-> c2 inside;
 * the server also knows up -FLOWS_TO-> r (incoming) and c2 -FLOWS_TO-> x
 * (outgoing, also drawn on the canvas), and a rollup it must never copy.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

const getEdges = vi.fn(async (q: { sourceUrns?: string[]; targetUrns?: string[] }) => {
  const all = [
    { id: 'e1', sourceUrn: 'up', targetUrn: 'r', edgeType: 'FLOWS_TO' },
    { id: 'e2', sourceUrn: 'c2', targetUrn: 'x', edgeType: 'FLOWS_TO' },
    { id: 'e3', sourceUrn: 'c1', targetUrn: 'c2', edgeType: 'FLOWS_TO' },
    { id: 'e4', sourceUrn: 'agg', targetUrn: 'r', edgeType: 'AGGREGATED' },
    { id: 'e5', sourceUrn: 'p', targetUrn: 'r', edgeType: 'CONTAINS' },
  ]
  return all.filter((e) => (q.targetUrns ? q.targetUrns.includes(e.targetUrn) : q.sourceUrns!.includes(e.sourceUrn)))
})

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({ getEdges }),
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['domain'],
  useViewEntityTypes: () => [],
  useViewSchemaIsReady: () => true,
  useViewIsContainmentEdge: () => (edgeType: string) => edgeType.toUpperCase() === 'CONTAINS',
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v1',
    layout: { type: 'graph', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: [] },
  }),
  useContainmentEdgeTypes: () => ['CONTAINS'],
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (edge: { data?: { edgeType?: string; relationship?: string } }) =>
    (edge.data?.edgeType || edge.data?.relationship || '').toUpperCase(),
}))
vi.mock('@/features/versioning/model/ensureDraftOpen', () => ({
  ensureDraftOpen: async () => 'branch-1',
}))

import { QUICK_DUPLICATE, useDuplicateSubtree } from '../useDuplicateSubtree'

const node = (id: string, label: string, type: string, childCount?: number, extra: Record<string, unknown> = {}): LineageNode => ({
  id, type: 'generic', position: { x: 0, y: 0 },
  data: { label, urn: id, type, ...(childCount !== undefined ? { childCount } : {}), ...extra },
})
const edge = (id: string, source: string, target: string, edgeType: string): LineageEdge => ({
  id, source, target, type: 'lineage', data: { edgeType },
})

beforeEach(() => {
  getEdges.mockClear()
  useCanvasStore.setState({
    nodes: [
      node('p', 'Parent', 'domain'),
      node('r', 'Orders', 'domain', 2, { description: 'All orders', sourceSystem: 'snowflake' }),
      node('c1', 'Child1', 'dataset', 0),
      node('c2', 'Child2', 'dataset', 0),
      node('x', 'Report', 'dataset', 0),
    ],
    edges: [
      edge('p-r', 'p', 'r', 'CONTAINS'),
      edge('r-c1', 'r', 'c1', 'CONTAINS'),
      edge('r-c2', 'r', 'c2', 'CONTAINS'),
      edge('c1-c2', 'c1', 'c2', 'FLOWS_TO'),
      edge('c2-x', 'c2', 'x', 'FLOWS_TO'),
    ],
    _nodeIndex: new Set(['p', 'r', 'c1', 'c2', 'x']),
    _edgeIndex: new Set(['p-r', 'r-c1', 'r-c2', 'c1-c2', 'c2-x']),
  } as never)
  useStagedChangesStore.setState({ changes: [] } as never)
})

const createdEdges = () => useStagedChangesStore.getState().changes
  .filter((c) => c.type === 'create_edge')
  .map((c) => c.after as { source: string; target: string; edgeType: string })

describe('useDuplicateSubtree — prepare and commit', () => {
  it('counts every choice before anything is staged, from the server boundary', async () => {
    const { result } = renderHook(() => useDuplicateSubtree())
    const prepared = await act(async () => result.current.prepareDuplicate('r', { boundary: true }))
    expect(prepared).not.toBeNull()
    expect(prepared!.descendants).toBe(2)
    expect(getEdges).toHaveBeenCalledTimes(2)
    expect(prepared!.count({ ...QUICK_DUPLICATE, incoming: true, outgoing: true }))
      .toEqual({ entities: 3, internal: 1, incoming: 1, outgoing: 1 })
    expect(prepared!.count({ includeDescendants: false, internal: true, incoming: true, outgoing: true }))
      .toEqual({ entities: 1, internal: 0, incoming: 1, outgoing: 0 })
    expect(useStagedChangesStore.getState().changes).toHaveLength(0)
  })

  it('stages boundary edges to the original partners, never a rollup or containment edge', async () => {
    const { result } = renderHook(() => useDuplicateSubtree())
    const prepared = await act(async () => result.current.prepareDuplicate('r', { boundary: true }))
    const rootCopy = await act(async () =>
      result.current.commitDuplicate(prepared!, { ...QUICK_DUPLICATE, incoming: true, outgoing: true }))
    expect(rootCopy).toMatch(/^urn:staged:/)
    const edges = createdEdges()
    expect(edges).toHaveLength(3)
    expect(edges).toContainEqual({ edgeType: 'FLOWS_TO', source: 'up', target: rootCopy })
    expect(edges.some((e) => e.source.startsWith('urn:staged:') && e.target === 'x')).toBe(true)
    expect(edges.some((e) => e.edgeType === 'AGGREGATED' || e.edgeType === 'CONTAINS')).toBe(false)
  })

  it('the entity alone: one copy, under the same parent, with the chosen name', async () => {
    const { result } = renderHook(() => useDuplicateSubtree())
    const prepared = await act(async () => result.current.prepareDuplicate('r'))
    await act(async () => result.current.commitDuplicate(prepared!, {
      includeDescendants: false, internal: true, incoming: false, outgoing: false, name: 'Orders — EU',
    }))
    const creates = useStagedChangesStore.getState().changes.filter((c) => c.type === 'create_entity')
    expect(creates).toHaveLength(1)
    expect(creates[0].after).toMatchObject({ displayName: 'Orders — EU', parentUrn: 'p' })
  })

  it('keeps description and source system as node fields, not user properties', async () => {
    const { result } = renderHook(() => useDuplicateSubtree())
    await act(async () => result.current.duplicateSubtree('r'))
    const root = useStagedChangesStore.getState().changes.find((c) => c.type === 'create_entity')!
    const after = root.after as { description?: string; sourceSystem?: string; properties: Record<string, unknown> }
    expect(after.description).toBe('All orders')
    expect(after.sourceSystem).toBe('snowflake')
    expect(after.properties).not.toHaveProperty('description')
    expect(after.properties.duplicatedFrom).toBe('r')
  })

  it('⌘D reads nothing from the server and copies only what is inside', async () => {
    const { result } = renderHook(() => useDuplicateSubtree())
    await act(async () => result.current.duplicateSubtree('r'))
    expect(getEdges).not.toHaveBeenCalled()
    expect(createdEdges()).toHaveLength(1)
  })
})
