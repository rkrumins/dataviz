/**
 * Locate — a change found on the Context View: an entity that exists through its containment chain
 * (one read) and the search's reveal walk; a deletion through its deleted chain, pinned so it's drawn
 * past the cap, its anchor revealed, its tombstone waited for and its chain opened; a relationship by
 * both ends. It says when it falls short, and stops when the review has moved on.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChangeListRow } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'
import { TOMBSTONE_WAIT_MS, useLocateChange } from '../useLocateChange'

const branch = { source: 'branch', branchId: 'd1' } as const
const removedNode = (urn: string): GraphChange =>
  ({ entityId: urn, kind: 'node', status: 'removed', label: urn, origin: branch, before: { displayName: urn, entityType: 'T' } })
const contains = (id: string, parent: string, child: string): GraphChange =>
  ({ entityId: id, kind: 'edge', status: 'removed', label: id, origin: branch,
     before: { sourceEntityId: parent, targetEntityId: child, edgeType: 'CONTAINS' } })
// urn:db is live; deleted under it, urn:t1, and under that urn:c2.
const deletions = [removedNode('urn:t1'), contains('k1', 'urn:db', 'urn:t1'), removedNode('urn:c2'), contains('k2', 'urn:t1', 'urn:c2')]
const row = (over: Partial<ChangeListRow>): ChangeListRow =>
  ({ entityId: 'urn:x', kind: 'node', status: 'modified', structural: false, ...over })
const node = (id: string) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn: id } }) as never

const deps = {
  provider: { getAncestorChains: vi.fn(async (urns: string[]) => ({ [urns[0]]: ['urn:schema', 'urn:wh'] })) },
  reveal: vi.fn(async (urn: string) => ({ landedOn: 'hit' as const, urn, displayName: urn })),
  expand: vi.fn(),
  scrollIntoView: vi.fn(),
  isContainmentEdgeType: (t: string) => t === 'CONTAINS',
}
const locate = () => renderHook(() => useLocateChange(deps as never)).result.current

beforeEach(() => {
  Object.values(deps).forEach((d) => typeof d === 'function' && 'mockClear' in d && d.mockClear())
  deps.provider.getAncestorChains.mockClear()
  useCanvasStore.getState().setNodesAndEdges([], [])
  useCanvasStore.setState({ ghostPins: [], ghostPinsOrigin: null, selectedNodeIds: [] })
  useBranchStore.setState({ activeChangeSet: buildChangeSet(deletions) } as never)
})
afterEach(() => { vi.useRealTimers() })

describe('useLocateChange — an entity that exists', () => {
  it('walks the reveal down its chain, root first', async () => {
    expect(await locate()(row({ entityId: 'e1', urn: 'urn:orders' }))).toBe('found')
    expect(deps.provider.getAncestorChains).toHaveBeenCalledWith(['urn:orders'])
    expect(deps.reveal).toHaveBeenCalledWith('urn:orders', [
      { urn: 'urn:wh', displayName: '', entityType: '' }, { urn: 'urn:schema', displayName: '', entityType: '' },
    ])
  })

  it('says where it fell short: near it, or not on this canvas at all', async () => {
    deps.reveal.mockResolvedValueOnce({ landedOn: 'ancestor', urn: 'urn:schema', displayName: 'schema' } as never)
    expect(await locate()(row({ urn: 'urn:orders' }))).toBe('nearby')
    deps.reveal.mockResolvedValueOnce({ landedOn: 'ancestor', urn: '', displayName: '' } as never)
    expect(await locate()(row({ urn: 'urn:orders' }))).toBe('missing')
  })

  it('stops before revealing anything once the review has moved on', async () => {
    expect(await locate()(row({ urn: 'urn:orders' }), () => false)).toBe('missing')
    expect(deps.reveal).not.toHaveBeenCalled()
  })
})

describe('useLocateChange — a deletion', () => {
  it('draws it past the cap, opens what it sat in, and selects it', async () => {
    const find = locate()(row({ entityId: 'urn:c2', status: 'removed' }))
    // The ghost pass draws it once it's pinned and its anchor is on the canvas.
    await act(async () => { useCanvasStore.getState().addNodes([node('urn:db'), node('urn:c2')]) })

    expect(await find).toBe('found')
    expect(useCanvasStore.getState().ghostPins).toEqual(['urn:c2'])
    expect(deps.reveal).toHaveBeenCalledWith('urn:db', expect.any(Array))           // its anchor, still there
    expect(deps.expand).toHaveBeenCalledWith(['urn:db', 'urn:t1'])                  // the anchor, and the deleted table
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['urn:c2'])
    expect(deps.scrollIntoView).toHaveBeenCalledWith('urn:c2')
  })

  it('settles for its anchor when its tombstone is not drawn in time', async () => {
    vi.useFakeTimers()
    const find = locate()(row({ entityId: 'urn:c2', status: 'removed' }))
    await vi.advanceTimersByTimeAsync(TOMBSTONE_WAIT_MS)
    expect(await find).toBe('nearby')
    expect(deps.expand).not.toHaveBeenCalled()
  })

  it('waits for the change set the canvas draws, and says so when the deletion is not in it', async () => {
    vi.useFakeTimers()
    const find = locate()(row({ entityId: 'urn:elsewhere', status: 'removed' }))
    await vi.advanceTimersByTimeAsync(TOMBSTONE_WAIT_MS)
    expect(await find).toBe('missing')
    expect(deps.reveal).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().ghostPins).toEqual([])
  })
})

describe('useLocateChange — a relationship', () => {
  it('finds both ends, the target last, and a deleted end as a deletion', async () => {
    useCanvasStore.getState().addNodes([node('urn:t1')])                          // already drawn
    const outcome = await locate()(row({ entityId: 'f1', kind: 'edge', status: 'removed', sourceEntityId: 'urn:a', targetEntityId: 'urn:t1' }))
    expect(outcome).toBe('found')
    expect(deps.reveal.mock.calls.map((c) => c[0])).toEqual(['urn:a', 'urn:db'])
    expect(useCanvasStore.getState().ghostPins).toEqual(['urn:t1'])
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['urn:t1'])
  })
})
