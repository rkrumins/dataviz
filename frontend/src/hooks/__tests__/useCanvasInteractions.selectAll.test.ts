/**
 * ⌘A selects in ONE write, however many: a write per entity re-rendered the canvas that many times,
 * and toggled off the entities already selected. Only what the canvas shows, when it says what
 * that is.
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => ({}) }))

import { useCanvasInteractions } from '../useCanvasInteractions'
import { useCanvasStore, type LineageNode } from '@/store/canvas'

const node = (id: string): LineageNode => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn: id, label: id } }) as unknown as LineageNode

beforeEach(() => {
  const nodes = [...Array.from({ length: 500 }, (_, i) => node(`n${i}`)), node('logical:group')]
  useCanvasStore.setState({ nodes, edges: [], _nodeIndex: new Set(nodes.map((n) => n.id)), selectedNodeIds: ['n1', 'n2'], selectedEdgeIds: [] } as never)
})

function writesDuring(run: () => void): number {
  let n = 0
  const off = useCanvasStore.subscribe((s, prev) => { if (s.selectedNodeIds !== prev.selectedNodeIds) n += 1 })
  act(run)
  off()
  return n
}

describe('select all', () => {
  it('selects every entity the canvas holds in one write — keeping those already selected', () => {
    const { result } = renderHook(() => useCanvasInteractions())
    expect(writesDuring(() => result.current.keyboardHandlers.onSelectAll())).toBe(1)
    const ids = useCanvasStore.getState().selectedNodeIds
    expect(ids).toHaveLength(500)
    expect(ids).toContain('n1')
    // A grouping is a container, not an entity: never part of a selection.
    expect(ids).not.toContain('logical:group')
  })

  it('selects only what the canvas shows, when it says what that is', () => {
    const { result } = renderHook(() => useCanvasInteractions({ selectableIds: () => ['n7', 'n8', 'n9'] }))
    expect(writesDuring(() => result.current.selectAll())).toBe(1)
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['n7', 'n8', 'n9'])
  })
})
