/**
 * Integration test for useDuplicateSubtree: seeds a real canvas store + a
 * real useStageEntityCreation/useStagedChangesStore, and exercises the full
 * duplicate flow end-to-end (minus the network — the subtree here is already
 * fully loaded, so loadChildren is never invoked).
 *
 * Fixture: p(domain) -CONTAINS-> r(domain, childCount 2) -CONTAINS-> c1, c2
 * (dataset), plus an internal lineage edge c1 -FLOWS_TO-> c2.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCanvasStore, type LineageNode, type LineageEdge } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({}),
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

import { useDuplicateSubtree } from '../useDuplicateSubtree'

const node = (id: string, label: string, type: string, childCount?: number): LineageNode => ({
  id, type: 'generic', position: { x: 0, y: 0 },
  data: { label, urn: id, type, ...(childCount !== undefined ? { childCount } : {}) },
})
const edge = (id: string, source: string, target: string, edgeType: string): LineageEdge => ({
  id, source, target, type: 'lineage', data: { edgeType },
})

const resetStores = () => {
  useCanvasStore.setState({
    nodes: [
      node('p', 'Parent', 'domain'),
      node('r', 'Root', 'domain', 2),
      node('c1', 'Child1', 'dataset', 0),
      node('c2', 'Child2', 'dataset', 0),
      node('x', 'Outside', 'dataset', 0),
    ],
    edges: [
      edge('p-r', 'p', 'r', 'CONTAINS'),
      edge('r-c1', 'r', 'c1', 'CONTAINS'),
      edge('r-c2', 'r', 'c2', 'CONTAINS'),
      edge('c1-c2', 'c1', 'c2', 'FLOWS_TO'),
      // Cross-boundary: one endpoint (x) is outside the duplicated subtree —
      // must NOT be recreated (left for the user to redraw against the copy).
      edge('c2-x', 'c2', 'x', 'FLOWS_TO'),
    ],
    _nodeIndex: new Set(['p', 'r', 'c1', 'c2', 'x']),
    _edgeIndex: new Set(['p-r', 'r-c1', 'r-c2', 'c1-c2', 'c2-x']),
  } as never)
  useStagedChangesStore.setState({ changes: [] } as never)
}

describe('useDuplicateSubtree', () => {
  beforeEach(resetStores)

  it('stages the whole subtree as fresh entities: distinct urns, provenance, containment, and internal lineage', async () => {
    const { result } = renderHook(() => useDuplicateSubtree())

    let rootCopyUrn: string | null = null
    await act(async () => {
      rootCopyUrn = await result.current.duplicateSubtree('r')
    })

    expect(rootCopyUrn).toBeTruthy()
    expect(rootCopyUrn).not.toContain('-copy-')
    expect(rootCopyUrn).toMatch(/^urn:staged:domain:/)

    const changes = useStagedChangesStore.getState().changes
    const createEntityChanges = changes.filter((c) => c.type === 'create_entity')
    expect(createEntityChanges).toHaveLength(3)

    // Distinct staged urns — never a `-copy-` string.
    const urns = createEntityChanges.map((c) => c.targetUrn)
    expect(new Set(urns).size).toBe(3)
    expect(urns.every((u) => !u!.includes('-copy-'))).toBe(true)

    const byDisplayName = new Map(
      createEntityChanges.map((c) => [(c.after as { displayName: string }).displayName, c]),
    )
    const rootChange = byDisplayName.get('Root (Copy)')!
    const child1Change = byDisplayName.get('Child1')!
    const child2Change = byDisplayName.get('Child2')!
    expect(rootChange).toBeTruthy()
    expect(child1Change).toBeTruthy()
    expect(child2Change).toBeTruthy()

    // Provenance: each copy points at ITS OWN original urn.
    expect((rootChange.after as { properties: Record<string, unknown> }).properties.duplicatedFrom).toBe('r')
    expect((child1Change.after as { properties: Record<string, unknown> }).properties.duplicatedFrom).toBe('c1')
    expect((child2Change.after as { properties: Record<string, unknown> }).properties.duplicatedFrom).toBe('c2')

    // Root copy is placed as a SIBLING of the original — same parent ('p').
    expect((rootChange.after as { parentUrn?: string }).parentUrn).toBe('p')

    // Descendant copies are parented under the ROOT COPY, not the originals.
    expect((child1Change.after as { parentUrn?: string }).parentUrn).toBe(rootCopyUrn)
    expect((child2Change.after as { parentUrn?: string }).parentUrn).toBe(rootCopyUrn)

    // 2 staged containment edges (optimistic, parent-copy -> child-copy).
    const canvasEdges = useCanvasStore.getState().edges
    const containmentCopies = canvasEdges.filter((e) => e.type === 'containment' && e.source === rootCopyUrn)
    expect(containmentCopies).toHaveLength(2)

    // 1 staged lineage edge, between the CHILD copies (not the originals).
    const lineageChanges = changes.filter((c) => c.type === 'create_edge')
    expect(lineageChanges).toHaveLength(1)
    const child1Urn = child1Change.targetUrn
    const child2Urn = child2Change.targetUrn
    expect(lineageChanges[0].after).toMatchObject({ edgeType: 'FLOWS_TO', source: child1Urn, target: child2Urn })
  })
})
