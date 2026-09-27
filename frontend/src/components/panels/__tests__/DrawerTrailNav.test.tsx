/**
 * DrawerTrailNav — the back/forward trail both drawers share. A step lands on
 * a node or a relationship and the canvas selection follows; the owning
 * drawer's guard can hold a step while there are unsaved edits.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore, type DrawerEdgeTarget } from '@/store/canvas'
import { DrawerTrailNav } from '../DrawerTrailNav'

const rel: DrawerEdgeTarget = { kind: 'relationship', id: 'e1', source: 'a', target: 'b', edgeType: 'FLOWS_TO', lineId: 'bundle-a->b' }

beforeEach(() => {
  useCanvasStore.setState({
    drawerNodeId: null,
    drawerEdge: null,
    drawerEdgeEditRequest: false,
    drawerHistory: { entries: [], cursor: -1 },
    selectedNodeIds: [],
    selectedEdgeIds: [],
  })
})

describe('DrawerTrailNav', () => {
  it('shows nothing until there is somewhere to go', () => {
    useCanvasStore.getState().openNodeDrawer('a')
    render(<DrawerTrailNav />)
    expect(screen.queryByRole('button', { name: /Back/ })).not.toBeInTheDocument()
  })

  it('steps back to a node and selects it, revealing it on the canvas', async () => {
    const user = userEvent.setup()
    const onFocusNode = vi.fn()
    useCanvasStore.getState().openNodeDrawer('a')
    useCanvasStore.getState().openEdgeDrawer(rel)
    render(<DrawerTrailNav onFocusNode={onFocusNode} />)
    await user.click(screen.getByRole('button', { name: 'Back to the previous entity' }))
    expect(useCanvasStore.getState().drawerNodeId).toBe('a')
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['a'])
    expect(onFocusNode).toHaveBeenCalledWith('a')
  })

  it('steps forward onto a relationship and selects the line it was opened from', async () => {
    const user = userEvent.setup()
    useCanvasStore.getState().openNodeDrawer('a')
    useCanvasStore.getState().openEdgeDrawer(rel)
    useCanvasStore.getState().drawerBack()
    render(<DrawerTrailNav />)
    await user.click(screen.getByRole('button', { name: 'Forward to the next entity' }))
    expect(useCanvasStore.getState().drawerEdge?.id).toBe('e1')
    expect(useCanvasStore.getState().selectedEdgeIds).toEqual(['bundle-a->b'])
  })

  it('a guard holds the step until the drawer lets it go', async () => {
    const user = userEvent.setup()
    let held: (() => void) | null = null
    useCanvasStore.getState().openEdgeDrawer(rel)
    useCanvasStore.getState().openNodeDrawer('a')
    render(<DrawerTrailNav guard={(step) => { held = step }} />)
    await user.click(screen.getByRole('button', { name: 'Back to the previous entity' }))
    expect(useCanvasStore.getState().drawerNodeId).toBe('a')
    held!()
    expect(useCanvasStore.getState().drawerEdge?.id).toBe('e1')
  })
})
