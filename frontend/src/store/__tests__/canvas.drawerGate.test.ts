/**
 * The drawer move gate: while the drawer has unsaved edits, a move of it is held — whole —
 * until the reader chooses. Before it, a click on another node swapped the drawer's target
 * mid-edit (the edits reverted by an effect, after the selection had already moved: Backspace
 * then deleted the node just clicked), and a step to the other kind of drawer unmounted it
 * without asking.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DRAWER_TRAIL_MAX, useCanvasStore, type DrawerEdgeTarget } from '../canvas'

const s = () => useCanvasStore.getState()
const rel = (id: string): DrawerEdgeTarget => ({ kind: 'relationship', id, source: 'a', target: 'b', edgeType: 'FLOWS_TO' })
const tick = () => new Promise<void>((r) => queueMicrotask(r))

beforeEach(async () => {
  useCanvasStore.setState({
    drawerNodeId: null, drawerEdge: null, drawerEdgeEditRequest: false,
    drawerHistory: { entries: [], cursor: -1 }, selectedNodeIds: [], selectedEdgeIds: [],
    drawerDirty: false, pendingDrawerMove: null,
  })
  await tick()
  s().openNodeDrawer('a')
})

describe('a clean drawer', () => {
  it('moves at once', () => {
    s().selectNode('b')
    expect(s().drawerNodeId).toBe('b')
    expect(s().pendingDrawerMove).toBeNull()
  })
})

describe('a dirty drawer', () => {
  beforeEach(() => s().setDrawerDirty(true))

  it('holds a click on another node — neither the drawer nor the selection moves', () => {
    s().selectNode('b')
    expect(s().drawerNodeId).toBe('a')
    expect(s().selectedNodeIds).toEqual([])
    expect(s().pendingDrawerMove?.steps).toHaveLength(1)
  })

  it('does not hold what is not a move of the drawer', () => {
    s().openNodeDrawer('a')                         // the same entity
    s().selectNode('x', true)                        // multi-select never touches the drawer
    s().selectNode('logical:g')                      // a grouping never opens it
    expect(s().pendingDrawerMove).toBeNull()
    expect(s().drawerNodeId).toBe('a')
    expect(s().selectedNodeIds).toEqual(['logical:g'])
  })

  it('holds every kind of move: another relationship, the trail, a close, a selection of one', () => {
    s().openEdgeDrawer(rel('r1'))
    expect(s().drawerEdge).toBeNull()
    s().resolveDrawerMove('keep')
    s().closeNodeDrawer()
    expect(s().drawerNodeId).toBe('a')
    s().resolveDrawerMove('keep')
    s().setSelection(['z'])
    expect(s().drawerNodeId).toBe('a')
    s().resolveDrawerMove('keep')
    s().selectEdge('e1')
    expect(s().drawerNodeId).toBe('a')
  })

  it('"proceed" replays the whole move, in order, and the drawer is clean', () => {
    s().selectNode('b')
    s().resolveDrawerMove('proceed')
    expect(s().drawerNodeId).toBe('b')
    expect(s().selectedNodeIds).toEqual(['b'])
    expect(s().drawerDirty).toBe(false)
    expect(s().pendingDrawerMove).toBeNull()
  })

  it('"keep" drops it and stays dirty', () => {
    s().selectNode('b')
    s().resolveDrawerMove('keep')
    expect(s().drawerNodeId).toBe('a')
    expect(s().drawerDirty).toBe(true)
    expect(s().pendingDrawerMove).toBeNull()
  })

  it('batches the calls of one tick into one move, and a later move replaces it', async () => {
    s().openNodeDrawer('b')
    s().selectNode('b')                              // same tick: joins
    expect(s().pendingDrawerMove?.steps).toHaveLength(2)
    await tick()
    s().openNodeDrawer('c')                          // a later click: the latest wins
    expect(s().pendingDrawerMove?.steps).toHaveLength(1)
    s().resolveDrawerMove('proceed')
    expect(s().drawerNodeId).toBe('c')
  })

  it('requestDrawerMove holds a multi-step move whole, and runs it on proceed', () => {
    const ran: string[] = []
    s().requestDrawerMove(() => { ran.push('reveal'); s().openNodeDrawer('d') })
    expect(ran).toEqual([])
    s().resolveDrawerMove('proceed')
    expect(ran).toEqual(['reveal'])
    expect(s().drawerNodeId).toBe('d')
  })

  it('a drawer that is no longer dirty leaves nothing to ask about', () => {
    s().selectNode('b')
    s().setDrawerDirty(false)
    expect(s().pendingDrawerMove).toBeNull()
  })

  it('forceCloseDrawer closes whatever it holds', () => {
    s().selectNode('b')
    s().forceCloseDrawer()
    expect(s().drawerNodeId).toBeNull()
    expect(s().drawerDirty).toBe(false)
    expect(s().pendingDrawerMove).toBeNull()
  })
})

describe('the trail', () => {
  it('keeps the latest DRAWER_TRAIL_MAX steps', () => {
    for (let i = 0; i < DRAWER_TRAIL_MAX + 10; i++) s().openNodeDrawer(`n${i}`)
    const h = s().drawerHistory
    expect(h.entries).toHaveLength(DRAWER_TRAIL_MAX)
    expect(h.cursor).toBe(DRAWER_TRAIL_MAX - 1)
    expect(h.entries[h.cursor]).toEqual({ kind: 'node', id: `n${DRAWER_TRAIL_MAX + 9}` })
  })
})
