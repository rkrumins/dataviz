/**
 * The entity drawer's own back/forward trail.
 *
 * Following lineage from the drawer — click a consumer, then its consumer,
 * then back — is a WALK, and a walk you cannot retrace is a walk you stop
 * taking. Mirrors the Lens's history: a move truncates whatever was ahead,
 * and stepping back keeps the forward leg until a new move replaces it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore, type DrawerEdgeTarget } from '../canvas'

const s = () => useCanvasStore.getState()
const n = (id: string) => ({ kind: 'node' as const, id })
const rel = (id: string): DrawerEdgeTarget => ({ kind: 'relationship', id, source: 'a', target: 'b', edgeType: 'FLOWS_TO' })

beforeEach(() => {
  useCanvasStore.setState({
    drawerNodeId: null,
    drawerEdge: null,
    drawerEdgeEditRequest: false,
    drawerHistory: { entries: [], cursor: -1 },
    selectedNodeIds: [],
  })
})

describe('drawer history', () => {
  it('records each entity the drawer opens on', () => {
    s().openNodeDrawer('a')
    s().openNodeDrawer('b')
    expect(s().drawerHistory).toEqual({ entries: [n('a'), n('b')], cursor: 1 })
    expect(s().drawerNodeId).toBe('b')
  })

  it('does not record re-opening the entity already shown', () => {
    s().openNodeDrawer('a')
    s().openNodeDrawer('a')
    expect(s().drawerHistory.entries).toEqual([n('a')])
  })

  it('steps back to the previous entity', () => {
    s().openNodeDrawer('a')
    s().openNodeDrawer('b')
    s().drawerBack()
    expect(s().drawerNodeId).toBe('a')
    expect(s().drawerHistory.cursor).toBe(0)
  })

  it('steps forward again after going back', () => {
    s().openNodeDrawer('a')
    s().openNodeDrawer('b')
    s().drawerBack()
    s().drawerForward()
    expect(s().drawerNodeId).toBe('b')
  })

  it('refuses to step past either end', () => {
    s().openNodeDrawer('a')
    s().drawerBack()
    s().drawerBack()
    expect(s().drawerNodeId).toBe('a')
    s().drawerForward()
    expect(s().drawerNodeId).toBe('a')
  })

  it('a new move from the middle drops what was ahead', () => {
    s().openNodeDrawer('a')
    s().openNodeDrawer('b')
    s().openNodeDrawer('c')
    s().drawerBack()          // on 'b', 'c' ahead
    s().openNodeDrawer('d')
    expect(s().drawerHistory).toEqual({ entries: [n('a'), n('b'), n('d')], cursor: 2 })
  })

  it('a single-select click joins the same trail', () => {
    // Selecting one entity opens the drawer on it, so it is a move like any
    // other — otherwise Back would skip the steps taken on the canvas.
    s().selectNode('a')
    s().selectNode('b')
    expect(s().drawerHistory.entries).toEqual([n('a'), n('b')])
  })

  it('a multi-selection is not a move — the drawer did not go anywhere', () => {
    s().selectNode('a')
    s().setSelection(['b', 'c'])
    expect(s().drawerHistory.entries).toEqual([n('a')])
  })

  it('re-selecting where you just stepped back to does not append a step', () => {
    // Retracing selects the entity so the canvas highlight follows, and
    // selectNode records moves. Without the no-op guard, every Back would
    // push a new entry and Forward would be unreachable.
    s().openNodeDrawer('a')
    s().openNodeDrawer('b')
    s().drawerBack()
    s().selectNode('a')

    expect(s().drawerHistory).toEqual({ entries: [n('a'), n('b')], cursor: 0 })
    s().drawerForward()
    expect(s().drawerNodeId).toBe('b')
  })

  it('closing the drawer ends the trail', () => {
    s().openNodeDrawer('a')
    s().openNodeDrawer('b')
    s().closeNodeDrawer()
    expect(s().drawerNodeId).toBeNull()
    expect(s().drawerHistory).toEqual({ entries: [], cursor: -1 })
  })
  it('a relationship joins the same trail, and Back returns to the node', () => {
    s().openNodeDrawer('a')
    s().openEdgeDrawer(rel('e1'))
    expect(s().drawerNodeId).toBeNull()
    expect(s().drawerEdge).toEqual(rel('e1'))
    s().drawerBack()
    expect(s().drawerNodeId).toBe('a')
    expect(s().drawerEdge).toBeNull()
    s().drawerForward()
    expect(s().drawerEdge?.id).toBe('e1')
    expect(s().drawerNodeId).toBeNull()
  })

  it('does not record re-opening the relationship already shown', () => {
    s().openEdgeDrawer(rel('e1'))
    s().openEdgeDrawer(rel('e1'))
    expect(s().drawerHistory.entries).toHaveLength(1)
  })

  it('opening a node — by click or from the drawer — replaces the relationship', () => {
    s().openEdgeDrawer(rel('e1'))
    s().selectNode('a')
    expect(s().drawerEdge).toBeNull()
    s().openEdgeDrawer(rel('e1'))
    s().openNodeDrawer('b')
    expect(s().drawerEdge).toBeNull()
    expect(s().drawerNodeId).toBe('b')
  })

  it('a multi-select click leaves the relationship open', () => {
    s().openEdgeDrawer(rel('e1'))
    s().selectNode('x', true)
    expect(s().drawerEdge?.id).toBe('e1')
  })

  it('closing ends the relationship and the trail too', () => {
    s().openNodeDrawer('a')
    s().openEdgeDrawer(rel('e1'), { edit: true })
    s().closeNodeDrawer()
    expect(s().drawerEdge).toBeNull()
    expect(s().drawerEdgeEditRequest).toBe(false)
    expect(s().drawerHistory).toEqual({ entries: [], cursor: -1 })
  })

  it('an edit request is taken exactly once', () => {
    s().openEdgeDrawer(rel('e1'), { edit: true })
    expect(s().consumeDrawerEdgeEditRequest()).toBe(true)
    expect(s().consumeDrawerEdgeEditRequest()).toBe(false)
    s().openEdgeDrawer(rel('e2'))
    expect(s().consumeDrawerEdgeEditRequest()).toBe(false)
  })
})
