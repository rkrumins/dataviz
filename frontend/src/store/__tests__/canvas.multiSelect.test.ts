/**
 * canvas store — building a multi-selection.
 *
 * The store already toggled one node at a time under a `multi` flag, but
 * nothing could express "these N nodes", which is what a shift-range and
 * every bulk action need. `setSelection` is that verb.
 *
 * Two invariants carry the feature: a logical group is a visual container,
 * never a selectable entity (bulk trace would have nothing to walk from),
 * and a multi-selection must not hijack the sticky drawer — the drawer
 * shows ONE entity, and a selection of five is not one entity.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../canvas'

const state = () => useCanvasStore.getState()

beforeEach(() => {
  useCanvasStore.setState({
    selectedNodeIds: [],
    selectedEdgeIds: [],
    drawerNodeId: null,
  })
})

describe('setSelection', () => {
  it('replaces the whole selection', () => {
    state().selectNode('a')
    state().setSelection(['b', 'c', 'd'])
    expect(state().selectedNodeIds).toEqual(['b', 'c', 'd'])
  })

  it('drops duplicates so a count never overstates', () => {
    state().setSelection(['b', 'c', 'b'])
    expect(state().selectedNodeIds).toEqual(['b', 'c'])
  })

  it('refuses logical groups — a group is a container, not an entity', () => {
    state().setSelection(['a', 'logical:G', 'b'])
    expect(state().selectedNodeIds).toEqual(['a', 'b'])
  })

  it('clears an edge selection, which is mutually exclusive with nodes', () => {
    useCanvasStore.setState({ selectedEdgeIds: ['e1'] })
    state().setSelection(['a'])
    expect(state().selectedEdgeIds).toEqual([])
  })

  it('leaves the sticky drawer alone for a multi-selection', () => {
    state().selectNode('a')
    expect(state().drawerNodeId).toBe('a')
    state().setSelection(['b', 'c'])
    expect(state().drawerNodeId).toBe('a')
  })

  it('shows a single set node in the drawer, like a plain click', () => {
    state().setSelection(['b'])
    expect(state().drawerNodeId).toBe('b')
  })

  it('empties to nothing selected', () => {
    state().setSelection(['a', 'b'])
    state().setSelection([])
    expect(state().selectedNodeIds).toEqual([])
  })
})

describe('selectNode with multi', () => {
  it('adds and removes without disturbing the rest', () => {
    state().setSelection(['a', 'b'])
    state().selectNode('c', true)
    expect(state().selectedNodeIds).toEqual(['a', 'b', 'c'])
    state().selectNode('b', true)
    expect(state().selectedNodeIds).toEqual(['a', 'c'])
  })

  it('never puts a logical group into the selection', () => {
    state().setSelection(['a'])
    state().selectNode('logical:G', true)
    expect(state().selectedNodeIds).toEqual(['a'])
  })
})
