/**
 * A staged move saves as ONE server-resolved `move` op, and after the save the canvas holds the
 * real parent link in place of the pending one — never both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({ applyGraphChanges: vi.fn() }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges } from '@/services/versioningApiService'
import { useCanvasStore } from '@/store/canvas'
import type { StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)
const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as never }
const moveChange: StagedChange = {
  id: 'm1', type: 'move_entity', targetId: 'X', summary: 'Move under P2', timestamp: 0,
  after: { childId: 'X', parentId: 'P2', edgeId: 'staged-edge-1', edgeType: 'HAS', containmentTypes: ['HAS'] },
}

describe('saving a move', () => {
  beforeEach(() => {
    mockApply.mockReset()
    mockApply.mockResolvedValue({ commitId: 'c1', assigned: { 'staged-edge-1': 'ent_real' } } as never)
    const pending = { id: 'staged-edge-1', source: 'P2', target: 'X', type: 'containment',
                      data: { edgeType: 'HAS', isPending: 'create' } }
    useCanvasStore.setState({ edges: [pending], _edgeIndex: new Set([pending.id]) } as never)
  })

  it('sends one move op carrying the pending link as its ref', async () => {
    await saveStagedChangesToDraft([moveChange], target)
    expect(mockApply.mock.calls[0][3]).toEqual([
      { op: 'move', kind: 'node', id: 'X', ref: 'staged-edge-1',
        payload: { parentEntityId: 'P2', edgeType: 'HAS' } },
    ])
  })

  it('swaps the pending link for the real one', async () => {
    await saveStagedChangesToDraft([moveChange], target)
    const links = useCanvasStore.getState().edges.filter((e) => e.target === 'X')
    expect(links.map((e) => [e.id, e.source, e.data?.isPending])).toEqual([['ent_real', 'P2', undefined]])
  })
})
