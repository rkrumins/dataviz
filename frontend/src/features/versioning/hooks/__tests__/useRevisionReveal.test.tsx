/**
 * useRevisionReveal — "Open just before it was deleted" lands on the entity: once the canvas has read
 * the revision and drawn it, the entity is revealed by the canvas's own reveal, then selected with its
 * details open. Once. Never before the revision is drawn: Published, still on screen, doesn't have it.
 */
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useRevisionReveal } from '../useRevisionReveal'

const schema: ResolvedViewSchema = { entityTypes: [], relationshipTypes: [], containmentEdgeTypes: [], lineageEdgeTypes: [], rootEntityTypes: [] }
const card = (id: string, data: Record<string, unknown> = {}) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data })

const mount = (readAt: number | null, reveal = vi.fn()) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StaticViewSchemaProvider schema={schema} asOfSeq={readAt}>{children}</StaticViewSchemaProvider>
  )
  renderHook(() => useRevisionReveal(reveal), { wrapper })
  return reveal
}

beforeEach(() => {
  // Published, drawn: the entity was deleted there, so the canvas doesn't have it.
  useCanvasStore.getState().setNodesAndEdges([card('urn:revenue')] as never, [])
  useCanvasStore.setState({ hydrationPhase: 'complete', selectedNodeIds: [], drawerNodeId: null } as never)
  useBranchStore.setState({ revision: { seq: 41, headAtOpen: 50, reveal: 'urn:orders' } } as never)
})

describe('useRevisionReveal', () => {
  it('waits for the revision to draw, then reveals the entity, selected with its details open, once', async () => {
    const reveal = mount(41)
    expect(reveal).not.toHaveBeenCalled()                       // Published's drawing is still up
    act(() => useCanvasStore.setState({ hydrationPhase: 'roots' } as never))
    expect(reveal).not.toHaveBeenCalled()
    await act(async () => {
      useCanvasStore.getState().setNodesAndEdges([card('urn:revenue'), card('urn:orders')] as never, [])
      useCanvasStore.setState({ hydrationPhase: 'complete' } as never)
    })
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith('urn:orders')
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['urn:orders'])
    expect(useCanvasStore.getState().drawerNodeId).toBe('urn:orders')
    expect(useBranchStore.getState().revision?.reveal).toBeNull()
    act(() => useCanvasStore.setState({ hydrationPhase: 'roots' } as never))
    act(() => useCanvasStore.setState({ hydrationPhase: 'complete' } as never))
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it('reveals at once when the revision is already drawn with the entity in it', async () => {
    useCanvasStore.getState().setNodesAndEdges([card('urn:orders')] as never, [])
    const reveal = mount(41)
    await act(async () => {})
    expect(reveal).toHaveBeenCalledWith('urn:orders')
  })

  it('never reveals on a canvas still reading Published, nor on a tombstone of the entity', () => {
    useCanvasStore.getState().setNodesAndEdges([card('urn:orders', { isGhost: true })] as never, [])
    const reveal = mount(null)
    act(() => useCanvasStore.setState({ hydrationPhase: 'roots' } as never))
    act(() => useCanvasStore.setState({ hydrationPhase: 'complete' } as never))
    expect(reveal).not.toHaveBeenCalled()
    expect(useBranchStore.getState().revision?.reveal).toBe('urn:orders')
  })
})
