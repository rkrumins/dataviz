/**
 * Details on demand: in a view whose details don't open on a click (the
 * Business view, by default), selecting an entity picks it out and leaves the
 * drawer alone — until the details are asked for. Once they are open, they
 * follow the selection the way an inspector does, and the unsaved-edit gate
 * holds only a click that would move them. Where clicks open details (the
 * Technical view, by default), nothing about selection changes.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { useCanvasStore } from '../canvas'
import { usePersonaStore } from '../persona'
import { usePreferencesStore } from '../preferences'

const s = () => useCanvasStore.getState()
const tick = () => new Promise<void>((r) => queueMicrotask(r))

beforeEach(async () => {
  useCanvasStore.setState({
    drawerNodeId: null, drawerEdge: null, drawerEdgeEditRequest: false,
    drawerHistory: { entries: [], cursor: -1 }, selectedNodeIds: [], selectedEdgeIds: [],
    drawerDirty: false, pendingDrawerMove: null,
  })
  usePreferencesStore.setState({ openDetailsOnSelect: { business: false, technical: true } })
  await tick()
})

describe('in the Business view (details on demand)', () => {
  beforeEach(() => usePersonaStore.setState({ mode: 'business' }))

  it('a click selects without opening the details', () => {
    s().selectNode('a')
    expect(s().selectedNodeIds).toEqual(['a'])
    expect(s().drawerNodeId).toBeNull()
    expect(s().drawerHistory.entries).toEqual([])
  })

  it('a selection of one set at once does not open them either', () => {
    s().setSelection(['a'])
    expect(s().selectedNodeIds).toEqual(['a'])
    expect(s().drawerNodeId).toBeNull()
  })

  it('opened, the details follow the selection — with Back retracing the steps', () => {
    s().selectNode('a')
    s().openNodeDrawer('a')
    s().selectNode('b')
    expect(s().drawerNodeId).toBe('b')
    expect(s().drawerHistory.entries.map((e) => e.kind === 'node' && e.id)).toEqual(['a', 'b'])
  })

  it('closed again, a click goes back to selecting only', () => {
    s().openNodeDrawer('a')
    s().closeNodeDrawer()
    s().selectNode('b')
    expect(s().drawerNodeId).toBeNull()
    expect(s().selectedNodeIds).toEqual(['b'])
  })

  it('holds nothing while the details are closed — there is no edit to lose', () => {
    s().setDrawerDirty(true)
    s().selectNode('b')
    expect(s().pendingDrawerMove).toBeNull()
    expect(s().selectedNodeIds).toEqual(['b'])
  })

  it('holds a click that would move open details with unsaved edits', () => {
    s().openNodeDrawer('a')
    s().setDrawerDirty(true)
    s().selectNode('b')
    expect(s().drawerNodeId).toBe('a')
    expect(s().pendingDrawerMove?.steps).toHaveLength(1)
  })

  it('a multi-selection never opens them', () => {
    s().selectNode('a', true)
    s().selectNode('b', true)
    expect(s().drawerNodeId).toBeNull()
  })

  it('opens on a click where the reader has asked for that', () => {
    usePreferencesStore.setState({ openDetailsOnSelect: { business: true, technical: true } })
    s().selectNode('a')
    expect(s().drawerNodeId).toBe('a')
  })
})

describe('in the Technical view (details on a click)', () => {
  it('a click opens the details, as it always has', () => {
    s().selectNode('a')
    expect(s().drawerNodeId).toBe('a')
    s().setSelection(['b'])
    expect(s().drawerNodeId).toBe('b')
  })

  it('stays closed on a click where the reader has asked for that', () => {
    usePreferencesStore.setState({ openDetailsOnSelect: { business: false, technical: false } })
    s().selectNode('a')
    expect(s().drawerNodeId).toBeNull()
    expect(s().selectedNodeIds).toEqual(['a'])
  })
})
