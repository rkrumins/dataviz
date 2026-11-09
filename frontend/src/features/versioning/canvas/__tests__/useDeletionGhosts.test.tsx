/**
 * useDeletionGhosts — a deletion saved to the draft is drawn under its parent, so it waits for that
 * parent: once the parent is loaded (the canvas gains nodes), its deleted children come in, and a
 * collapse that dropped them from the store brings them back. A compact change list (two revisions
 * compared, a draft past the tree's cap) has no payloads: what the drawn ones were is asked for in
 * one request, never for a full diff, and two revisions compared are drawn whatever the draft toggle.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getChangeEntriesBatch = vi.hoisted(() => vi.fn())
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  getChangeEntriesBatch,
}))

import { queryClient } from '@/lib/queryClient'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'
import { useDeletionGhosts } from '../useDeletionGhosts'

const branch = { source: 'branch', branchId: 'b' } as const
const compare = { source: 'compare', fromSeq: 3, toSeq: 9 } as const
const changes: GraphChange[] = [
  { entityId: 'urn:col', kind: 'node', status: 'removed', label: 'col', origin: branch,
    before: { displayName: 'col', entityType: 'Column' } },
  { entityId: 'k1', kind: 'edge', status: 'removed', label: 'k1', origin: branch,
    before: { sourceEntityId: 'urn:table', targetEntityId: 'urn:col', edgeType: 'CONTAINS' } },
]
const table = { id: 'urn:table', type: 'generic', position: { x: 0, y: 0 }, data: { urn: 'urn:table' } }
const ids = () => useCanvasStore.getState().nodes.map((n) => n.id).sort()
const mount = (enabled = true) => renderHook(() => useDeletionGhosts(enabled))

beforeEach(() => {
  queryClient.clear()
  getChangeEntriesBatch.mockReset()
  // The ontology says which links nest: here, CONTAINS.
  useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'] } } as never)
  useCanvasStore.getState().setNodesAndEdges([], [])
  useCanvasStore.setState({ hydrationPhase: 'complete' } as never)
  useBranchStore.setState({ activeChangeSet: buildChangeSet(changes), committedDiffHidden: false, workspaceId: 'ws', graphId: 'g' } as never)
})

describe('useDeletionGhosts', () => {
  it('draws a deleted child once its parent is on the canvas', () => {
    mount()
    expect(ids()).toEqual([])                                          // its parent isn't loaded
    act(() => useCanvasStore.getState().addNodes([table as never]))
    expect(ids()).toEqual(['urn:col', 'urn:table'])
    expect(useCanvasStore.getState().edges.map((e) => e.id)).toEqual(['k1'])
    expect(useCanvasStore.getState().deletedDrawn).toEqual({ drawn: 1, total: 1 })
    expect(getChangeEntriesBatch).not.toHaveBeenCalled()                // a full diff has its payloads
  })

  it('brings it back after a collapse drops it from the store', () => {
    act(() => useCanvasStore.getState().addNodes([table as never]))
    mount()
    expect(ids()).toEqual(['urn:col', 'urn:table'])
    act(() => useCanvasStore.getState().removeNodes(['urn:col']))
    expect(ids()).toEqual(['urn:col', 'urn:table'])
  })

  it('asks once for what the drawn deletions of a comparison were, then draws them', async () => {
    const bare: GraphChange[] = [
      { entityId: 'urn:col', urn: 'urn:col', kind: 'node', status: 'removed', label: 'urn:col', origin: compare },
      { entityId: 'k1', kind: 'edge', status: 'removed', label: 'CONTAINS', origin: compare,
        before: { sourceEntityId: 'urn:table', targetEntityId: 'urn:col', edgeType: 'CONTAINS' } },
      { entityId: 'urn:far', urn: 'urn:far', kind: 'node', status: 'removed', label: 'urn:far', origin: compare },
      { entityId: 'k2', kind: 'edge', status: 'removed', label: 'CONTAINS', origin: compare,
        before: { sourceEntityId: 'urn:not-loaded', targetEntityId: 'urn:far', edgeType: 'CONTAINS' } },
    ]
    getChangeEntriesBatch.mockResolvedValue({ entries: [
      { entityId: 'urn:col', kind: 'node', status: 'removed', before: { displayName: 'col', entityType: 'Column' }, after: null },
    ] })
    // A comparison draws on any canvas, and a draft's "hide saved changes" doesn't hide it.
    act(() => {
      useBranchStore.setState({ activeChangeSet: buildChangeSet(bare), committedDiffHidden: true })
      useCanvasStore.getState().addNodes([table as never])
    })
    mount(false)
    await waitFor(() => expect(ids()).toEqual(['urn:col', 'urn:table']))
    expect(getChangeEntriesBatch).toHaveBeenCalledTimes(1)
    expect(getChangeEntriesBatch).toHaveBeenCalledWith('ws', 'g', { fromSeq: 3, toSeq: 9 }, ['urn:col'])  // not urn:far
    expect(useCanvasStore.getState().deletedDrawn).toEqual({ drawn: 1, total: 2 })
  })

  it('counts the ones on their way as drawn, and takes them off if the ask fails', async () => {
    const bare: GraphChange[] = [
      { entityId: 'urn:col', urn: 'urn:col', kind: 'node', status: 'removed', label: 'urn:col', origin: compare },
      { entityId: 'k1', kind: 'edge', status: 'removed', label: 'CONTAINS', origin: compare,
        before: { sourceEntityId: 'urn:table', targetEntityId: 'urn:col', edgeType: 'CONTAINS' } },
    ]
    let fail!: (e: unknown) => void
    getChangeEntriesBatch.mockReturnValue(new Promise((_, reject) => { fail = reject }))
    act(() => {
      useBranchStore.setState({ activeChangeSet: buildChangeSet(bare) })
      useCanvasStore.getState().addNodes([table as never])
    })
    mount(false)
    expect(useCanvasStore.getState().deletedDrawn).toEqual({ drawn: 1, total: 1 })   // no flicker
    await act(async () => fail(Object.assign(new Error('gone'), { status: 404 })))
    await waitFor(() => expect(useCanvasStore.getState().deletedDrawn).toEqual({ drawn: 0, total: 1 }))
    expect(ids()).toEqual(['urn:table'])
  })
})
