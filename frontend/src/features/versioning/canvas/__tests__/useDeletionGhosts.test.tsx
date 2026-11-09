/**
 * useDeletionGhosts — a deletion saved to the draft is drawn under its parent, so it waits for that
 * parent: once the parent is loaded (the canvas gains nodes), its deleted children come in, and a
 * collapse that dropped them from the store brings them back.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'
import { useDeletionGhosts } from '../useDeletionGhosts'

const origin = { source: 'branch', branchId: 'b' } as const
const changes: GraphChange[] = [
  { entityId: 'urn:col', kind: 'node', status: 'removed', label: 'col', origin,
    before: { displayName: 'col', entityType: 'Column' } },
  { entityId: 'k1', kind: 'edge', status: 'removed', label: 'k1', origin,
    before: { sourceEntityId: 'urn:table', targetEntityId: 'urn:col', edgeType: 'CONTAINS' } },
]
const table = { id: 'urn:table', type: 'generic', position: { x: 0, y: 0 }, data: { urn: 'urn:table' } }
const ids = () => useCanvasStore.getState().nodes.map((n) => n.id).sort()

beforeEach(() => {
  // The ontology says which links nest: here, CONTAINS.
  useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'] } } as never)
  useCanvasStore.getState().setNodesAndEdges([], [])
  useCanvasStore.setState({ hydrationPhase: 'complete' } as never)
  useBranchStore.setState({ activeChangeSet: buildChangeSet(changes), committedDiffHidden: false })
})

describe('useDeletionGhosts', () => {
  it('draws a deleted child once its parent is on the canvas', () => {
    renderHook(() => useDeletionGhosts(true))
    expect(ids()).toEqual([])                                          // its parent isn't loaded
    act(() => useCanvasStore.getState().addNodes([table as never]))
    expect(ids()).toEqual(['urn:col', 'urn:table'])
    expect(useCanvasStore.getState().edges.map((e) => e.id)).toEqual(['k1'])
  })

  it('brings it back after a collapse drops it from the store', () => {
    act(() => useCanvasStore.getState().addNodes([table as never]))
    renderHook(() => useDeletionGhosts(true))
    expect(ids()).toEqual(['urn:col', 'urn:table'])
    act(() => useCanvasStore.getState().removeNodes(['urn:col']))
    expect(ids()).toEqual(['urn:col', 'urn:table'])
  })
})
