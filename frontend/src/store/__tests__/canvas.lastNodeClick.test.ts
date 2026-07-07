/**
 * lastNodeClick is the store's "a node was just clicked" signal: drawerNodeId
 * is sticky (re-clicking the same node doesn't change it), so observers that
 * react to clicks — the Hierarchy Builder's canvas-navigation — need a
 * monotonic seq that bumps on EVERY selectNode call, same node or not.
 * clearSelection must never touch it (a background deselect is not a click).
 */
import { describe, it, expect } from 'vitest'
import { useCanvasStore } from '../canvas'

describe('canvas store — lastNodeClick', () => {
  it('selectNode bumps seq and records the node id, same node included', () => {
    const seq0 = useCanvasStore.getState().lastNodeClick.seq
    useCanvasStore.getState().selectNode('n1')
    expect(useCanvasStore.getState().lastNodeClick).toEqual({ nodeId: 'n1', seq: seq0 + 1 })
    // Re-clicking the SAME node still bumps — that is the whole point.
    useCanvasStore.getState().selectNode('n1')
    expect(useCanvasStore.getState().lastNodeClick).toEqual({ nodeId: 'n1', seq: seq0 + 2 })
  })

  it('clearSelection leaves lastNodeClick untouched', () => {
    useCanvasStore.getState().selectNode('n2')
    const before = useCanvasStore.getState().lastNodeClick
    useCanvasStore.getState().clearSelection()
    expect(useCanvasStore.getState().lastNodeClick).toBe(before)
  })
})
