/**
 * A read-only canvas (a past revision) edits nothing through the shared
 * interactions: every action that would stage a change does nothing, and the
 * keys for them are inert, while the keys that only read still work.
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({}),
}))
// The builder would open: a draft is to hand.
vi.mock('@/features/versioning/model/ensureDraftOpen', () => ({
  ensureDraftOpen: async () => 'branch-1',
}))
const settle = () => new Promise((r) => setTimeout(r, 0))

import { useCanvasInteractions } from '../useCanvasInteractions'
import { useCanvasStore, type LineageEdge, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'

const node = (id: string) => ({
  id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'dataset' },
}) as unknown as LineageNode
const EDGE = {
  id: 'e1', source: 'orders', target: 'report', type: 'lineage', data: { edgeType: 'TRANSFORMS' },
} as unknown as LineageEdge

const staged = () => useStagedChangesStore.getState().changes

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [node('orders'), node('report')], edges: [EDGE],
    selectedNodeIds: [], selectedEdgeIds: [], drawerNodeId: null,
  } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [] } as never)
  useHierarchyBuilderStore.setState({ isOpen: false, parentUrn: null } as never)
})

describe('useCanvasInteractions — read-only', () => {
  it('stages nothing, whatever it is asked to do', async () => {
    const { result } = renderHook(() => useCanvasInteractions({ readOnly: true }))
    act(() => result.current.startInlineEdit('orders', 'orders', { x: 0, y: 0 }))
    expect(result.current.state.inlineEdit.nodeId).toBeNull()

    act(() => {
      result.current.saveInlineEdit('orders', 'orders_v2')
      result.current.deleteNode('orders')
      result.current.duplicateNode('orders')
      result.current.createChild('orders')
      result.current.deleteEdge('e1')
      result.current.reverseEdge('e1')
    })
    expect(result.current.stageEdgeCreate('report', 'orders', 'TRANSFORMS')).toBeNull()
    expect(result.current.stageEdgeCreateMany([{ source: 'report', target: 'orders' }], 'TRANSFORMS'))
      .toEqual({ staged: 0, rejected: [] })
    await act(settle)

    expect(staged()).toEqual([])
    expect(useCanvasStore.getState().nodes.map((n) => [n.id, n.data.isPending])).toEqual([
      ['orders', undefined], ['report', undefined],
    ])
    expect(useCanvasStore.getState().edges.map((e) => e.id)).toEqual(['e1'])
    expect(useHierarchyBuilderStore.getState().isOpen).toBe(false)
  })

  it('makes the keys that edit inert, and keeps the keys that read', async () => {
    act(() => useCanvasStore.getState().selectNode('orders'))
    const { result } = renderHook(() => useCanvasInteractions({ readOnly: true }))
    const keys = result.current.keyboardHandlers
    act(() => {
      keys.onDelete()
      keys.onDuplicate()
      keys.onDuplicateWithOptions()
      keys.onCreate()
      keys.onConnectMode()
    })
    await act(settle)
    expect(staged()).toEqual([])
    expect(useCanvasStore.getState().nodes).toHaveLength(2)
    expect(useHierarchyBuilderStore.getState().isOpen).toBe(false)

    // Enter still opens the selected entity's details.
    act(() => result.current.keyboardHandlers.onEdit())
    expect(useCanvasStore.getState().drawerNodeId).toBe('orders')
  })

  it('stages the same Delete where the canvas can be edited', () => {
    act(() => useCanvasStore.getState().selectNode('orders'))
    const { result } = renderHook(() => useCanvasInteractions())
    act(() => result.current.keyboardHandlers.onDelete())
    expect(staged().map((c) => c.type)).toEqual(['delete_entity'])
  })
})
