/**
 * A staged move saves as ONE server-resolved `move` op, and after the save the canvas holds the
 * real parent link in place of the pending one — never both. An entity created in the same draft
 * and then moved saves as its create under the new parent: one parent link, no move.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({ applyGraphChanges: vi.fn() }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { act, renderHook } from '@testing-library/react'
import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges } from '@/services/versioningApiService'
import { useCanvasStore } from '@/store/canvas'
import { useBranchStore } from '@/store/branchStore'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useReparentNode } from '@/components/canvas/context-view/useReparentNode'
import { useStageEntityCreation } from '@/components/canvas/create/useStageEntityCreation'

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

describe('saving an entity created in this draft, then moved', () => {
  const ENTITY_TYPES = [
    { id: 'system', name: 'System', hierarchy: { canContain: ['dataset'], canBeContainedBy: [] } },
    { id: 'dataset', name: 'Dataset', hierarchy: { canContain: [], canBeContainedBy: ['system'] } },
  ]
  const sys = (id: string) => ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { label: id, urn: id, type: 'system' } })

  beforeEach(() => {
    mockApply.mockReset()
    useStagedChangesStore.setState({ changes: [], redoStack: [], past: [], _scopeKey: null, _byScope: {} })
    useBranchStore.setState({ currentBranchId: 'b' } as never)
    useSchemaStore.setState({ schema: {
      entityTypes: ENTITY_TYPES, rootEntityTypes: ['system'], containmentEdgeTypes: ['CONTAINS'],
      relationshipTypes: [{ id: 'CONTAINS', name: 'Contains', sourceTypes: ['system'], targetTypes: ['dataset'], isContainment: true }],
    } } as never)
    const nodes = [sys('P1'), sys('P2')]
    useCanvasStore.setState({ nodes, edges: [], _nodeIndex: new Set(nodes.map((n) => n.id)), _edgeIndex: new Set() } as never)
  })

  it('creates it under its new parent with exactly one parent link — no move op', async () => {
    const { result } = renderHook(() => ({ move: useReparentNode(), create: useStageEntityCreation() }))
    let temp = ''
    act(() => { temp = result.current.create.stageEntity({ entityType: 'dataset', displayName: 'orders', parentUrn: 'P1', containmentEdgeType: 'CONTAINS' }) })
    act(() => result.current.move.reparent(temp, 'P2'))
    mockApply.mockResolvedValue({ commitId: 'c2', assigned: { [temp]: 'urn:orders', [`contains-${temp}`]: 'edge_real' } } as never)

    await saveStagedChangesToDraft(useStagedChangesStore.getState().changes, target)

    const ops = mockApply.mock.calls[0][3]
    expect(ops.map((o) => o.op)).toEqual(['create', 'create'])
    expect(ops[1]).toMatchObject({ kind: 'edge', payload: { edgeType: 'CONTAINS', sourceEntityId: 'P2', targetEntityId: temp } })
    const links = useCanvasStore.getState().edges.filter((e) => e.target === 'urn:orders')
    expect(links.map((e) => [e.id, e.source])).toEqual([['edge_real', 'P2']])
  })
})
