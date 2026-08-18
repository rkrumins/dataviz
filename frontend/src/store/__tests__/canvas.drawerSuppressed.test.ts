/**
 * Sticky-drawer suppression — the native canvas trace's "stay out of the
 * way" contract. Normally every single-select click opens (or swaps) the
 * sticky EntityDrawer; while a trace is active the canvas suppresses
 * that, so clicking flow nodes highlights them without a third of the
 * screen disappearing under the drawer. Explicit opens (openNodeDrawer)
 * are always honoured — suppression only stops the click side-effect.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../canvas'

beforeEach(() => {
  useCanvasStore.setState({
    selectedNodeIds: [], selectedEdgeIds: [], drawerNodeId: null, drawerSuppressed: false,
  })
})

describe('canvas store — drawer suppression', () => {
  it('a single-select click opens the sticky drawer by default', () => {
    useCanvasStore.getState().selectNode('urn:a')
    expect(useCanvasStore.getState().drawerNodeId).toBe('urn:a')
  })

  it('while suppressed, a click selects but never opens the drawer', () => {
    useCanvasStore.getState().setDrawerSuppressed(true)
    useCanvasStore.getState().selectNode('urn:a')
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['urn:a'])
    expect(useCanvasStore.getState().drawerNodeId).toBeNull()
  })

  it('an explicit openNodeDrawer is honoured even while suppressed', () => {
    useCanvasStore.getState().setDrawerSuppressed(true)
    useCanvasStore.getState().openNodeDrawer('urn:a')
    expect(useCanvasStore.getState().drawerNodeId).toBe('urn:a')
  })

  it('lifting suppression restores the click behaviour', () => {
    useCanvasStore.getState().setDrawerSuppressed(true)
    useCanvasStore.getState().selectNode('urn:a')
    useCanvasStore.getState().setDrawerSuppressed(false)
    useCanvasStore.getState().selectNode('urn:b')
    expect(useCanvasStore.getState().drawerNodeId).toBe('urn:b')
  })
})
