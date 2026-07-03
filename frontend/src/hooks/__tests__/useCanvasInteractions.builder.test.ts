/**
 * useCanvasInteractions is the shared routing chokepoint for canvas creation
 * entry points (right-click "Add Child Entity", the 'N' key). This test
 * covers ONLY the reroute onto useHierarchyBuilderStore — createChild,
 * keyboardHandlers.onCreate, and the onCancel Escape cascade. The legacy
 * quickCreate machinery (openQuickCreate/closeQuickCreate/state.quickCreate)
 * stays intact for GraphCanvas/HierarchyCanvas until their own integration
 * tasks, so it is deliberately not exercised here.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// useCanvasInteractions calls useGraphProvider() unconditionally at the top
// of the hook body; none of the scenarios under test touch the provider, so
// a bare stub keeps the hook from throwing "must be used within a
// <GraphProvider>" without dragging in the real context tree.
vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({}),
}))

import { useCanvasInteractions } from '../useCanvasInteractions'
import { useCanvasStore } from '@/store/canvas'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'

const seedNode = (id: string, urn: string, type: string) => {
  useCanvasStore.getState().addNodes([
    { id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn, type } },
  ])
}

const resetStores = () => {
  useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
  useHierarchyBuilderStore.setState({
    isOpen: false, parentUrn: null, layerId: null, initialTypeId: null, initialMode: 'outline', initialTemplate: null,
  })
}

describe('useCanvasInteractions -> Hierarchy Builder routing', () => {
  beforeEach(resetStores)

  it('createChild(nodeId) opens the builder store scoped to the node urn', () => {
    seedNode('node-1', 'urn:real:node-1', 'dataset')
    const { result } = renderHook(() => useCanvasInteractions())

    act(() => result.current.createChild('node-1'))

    const s = useHierarchyBuilderStore.getState()
    expect(s.isOpen).toBe(true)
    expect(s.parentUrn).toBe('urn:real:node-1')
  })

  it("keyboardHandlers.onCreate() opens the builder store at root (no parentUrn)", () => {
    const { result } = renderHook(() => useCanvasInteractions())

    act(() => result.current.keyboardHandlers.onCreate())

    const s = useHierarchyBuilderStore.getState()
    expect(s.isOpen).toBe(true)
    expect(s.parentUrn).toBeNull()
  })

  it('keyboardHandlers.onCancel() closes the builder when open and no inline edit is active', () => {
    useHierarchyBuilderStore.getState().open()
    const { result } = renderHook(() => useCanvasInteractions())

    act(() => result.current.keyboardHandlers.onCancel())

    expect(useHierarchyBuilderStore.getState().isOpen).toBe(false)
  })

  it('createChild leaves the builder store untouched when the parent node is missing', () => {
    const { result } = renderHook(() => useCanvasInteractions())

    act(() => result.current.createChild('missing-node'))

    expect(useHierarchyBuilderStore.getState().isOpen).toBe(false)
  })
})
