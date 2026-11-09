/**
 * View & Edit — the context menu's item, and Enter on the selected entity —
 * asks for an entity's details. It opens them in every view, whatever a click
 * does there, and it never deselects the entity it was asked about (a second
 * select of the sole selection toggles it off).
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => ({}),
}))

import { useCanvasInteractions } from '../useCanvasInteractions'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'

const s = () => useCanvasStore.getState()

beforeEach(() => {
  useCanvasStore.setState({
    drawerNodeId: null, drawerEdge: null, drawerHistory: { entries: [], cursor: -1 },
    selectedNodeIds: [], selectedEdgeIds: [], drawerDirty: false, pendingDrawerMove: null,
  })
})

describe('View & Edit', () => {
  it('opens the details where a click does not (the Business view)', () => {
    usePersonaStore.setState({ mode: 'business' })
    const { result } = renderHook(() => useCanvasInteractions())
    act(() => result.current.editNode('a'))
    expect(s().selectedNodeIds).toEqual(['a'])
    expect(s().drawerNodeId).toBe('a')
  })

  it('keeps the entity selected when it already is the selection', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    act(() => s().selectNode('a'))
    act(() => result.current.editNode('a'))
    expect(s().selectedNodeIds).toEqual(['a'])
    expect(s().drawerNodeId).toBe('a')
  })
})
