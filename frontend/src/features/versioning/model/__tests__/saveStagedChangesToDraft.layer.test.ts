/**
 * One Review & Save = ONE atomic commit. These tests pin that saveStagedChangesToDraft folds every
 * GRAPH-DATA edit type into a SINGLE /graph/changes call, that the commit is atomic (a failure
 * throws; nothing is half-saved), and that layer placement (assign_layer / move_to_layer) is VIEW
 * config — it produces ZERO graph ops (it persists to referenceLayout.assignments via the canvas).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({ applyGraphChanges: vi.fn() }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges } from '@/services/versioningApiService'
import { useCanvasStore } from '@/store/canvas'
import type { StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)

const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as any }
const sc = (over: Partial<StagedChange>): StagedChange => ({
  id: 'c', type: 'assign_layer', targetId: 't', after: {}, summary: '', timestamp: 0, ...over,
})

describe('saveStagedChangesToDraft — one atomic commit (creates + edges + updates + layers)', () => {
  beforeEach(() => {
    mockApply.mockReset()
    mockApply.mockResolvedValue({ commitId: 'x', assigned: {} } as any)
  })

  it('produces ZERO graph ops for an assign_layer change (view config, not graph data)', async () => {
    await saveStagedChangesToDraft(
      [sc({ type: 'assign_layer', targetId: 'urn:x', targetUrn: 'urn:x', after: { layerId: 'warehouse' } })],
      target,
    )
    expect(mockApply).not.toHaveBeenCalled() // no graph ops → no commit
  })

  it('produces ZERO graph ops for a move_to_layer change (view config, not graph data)', async () => {
    await saveStagedChangesToDraft(
      [sc({ type: 'move_to_layer', targetId: 'urn:x', targetUrn: 'urn:x', after: { layerId: 'warehouse' } })],
      target,
    )
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('sends structural edits in ONE commit and DROPS layer moves from the graph batch', async () => {
    await saveStagedChangesToDraft(
      [
        sc({ type: 'rename_entity', targetId: 'urn:a', targetUrn: 'urn:a', after: { label: 'A' } }),
        sc({ type: 'assign_layer', targetId: 'urn:x', targetUrn: 'urn:x', after: { layerId: 'warehouse' } }),
      ],
      target,
    )
    expect(mockApply).toHaveBeenCalledTimes(1) // ONE atomic commit
    expect(mockApply.mock.calls[0][3]).toEqual([
      { op: 'update', kind: 'node', id: 'urn:a', payload: { displayName: 'A' } },
      // no layerAssignment op — the assign_layer is view config, persisted separately
    ])
  })

  it('is ATOMIC — a failure throws (nothing half-saved), so the caller can retry the whole set', async () => {
    mockApply.mockRejectedValueOnce(new Error('boom'))
    await expect(
      saveStagedChangesToDraft(
        [
          sc({ type: 'rename_entity', targetId: 'urn:a', targetUrn: 'urn:a', after: { label: 'A' } }),
          sc({ type: 'assign_layer', targetId: 'urn:x', targetUrn: 'urn:x', after: { layerId: 'warehouse' } }),
        ],
        target,
      ),
    ).rejects.toThrow('boom')
    expect(mockApply).toHaveBeenCalledTimes(1)
  })

  it('a lone layer move produces no commit (no graph ops at all)', async () => {
    await saveStagedChangesToDraft(
      [sc({ type: 'assign_layer', targetId: 'logical:group-1', after: { layerId: 'warehouse' } })],
      target,
    )
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('collapses a nested create + its containment edge into ONE call, WITHOUT any layer op', async () => {
    await saveStagedChangesToDraft(
      [
        sc({ id: 'p', type: 'create_entity', targetId: 'urn:staged:p', targetUrn: 'urn:staged:p', after: { entityType: 'Layer', displayName: 'P' } }),
        sc({ id: 'c', type: 'create_entity', targetId: 'urn:staged:c', targetUrn: 'urn:staged:c', after: { entityType: 'Object', displayName: 'C', parentUrn: 'urn:staged:p', containmentEdgeType: 'CONTAINS' } }),
        sc({ id: 'l', type: 'assign_layer', targetId: 'urn:staged:c', targetUrn: 'urn:staged:c', after: { layerId: 'L1' } }),
      ],
      target,
    )
    expect(mockApply).toHaveBeenCalledTimes(1) // ONE atomic commit for creates + edge only
    expect(mockApply.mock.calls[0][3]).toEqual([
      { op: 'create', kind: 'node', ref: 'urn:staged:p', payload: { entityType: 'Layer', displayName: 'P' } },
      { op: 'create', kind: 'node', ref: 'urn:staged:c', payload: { entityType: 'Object', displayName: 'C' } },
      { op: 'create', kind: 'edge', ref: 'contains-urn:staged:c', payload: { edgeType: 'CONTAINS', sourceEntityId: 'urn:staged:p', targetEntityId: 'urn:staged:c' } },
      // the assign_layer for urn:staged:c does NOT appear — it's view config, remapped temp→real via remapEntityId
    ])
  })

  it('reconciles the optimistic canvas: temp→real swap, orphan-safe childCount, rebuilt containment edge', async () => {
    // Seed the optimistic canvas as staging would: parent + child + their pending containment edge.
    useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as any)
    const canvas = useCanvasStore.getState()
    canvas.addNodes([
      { id: 'urn:staged:p', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'P', urn: 'urn:staged:p', isPending: 'create' } } as any,
      { id: 'urn:staged:c', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'C', urn: 'urn:staged:c', isPending: 'create' } } as any,
    ])
    canvas.addEdges([
      { id: 'contains-urn:staged:p-urn:staged:c', source: 'urn:staged:p', target: 'urn:staged:c', type: 'containment', data: { edgeType: 'CONTAINS', isPending: 'create' } } as any,
    ])
    mockApply.mockResolvedValueOnce({
      commitId: 'x',
      assigned: { 'urn:staged:p': 'urn:real:p', 'urn:staged:c': 'urn:real:c', 'contains-urn:staged:c': 'edge_real' },
    } as any)

    await saveStagedChangesToDraft(
      [
        sc({ id: 'p', type: 'create_entity', targetId: 'urn:staged:p', targetUrn: 'urn:staged:p', after: { entityType: 'Layer', displayName: 'P' } }),
        sc({ id: 'c', type: 'create_entity', targetId: 'urn:staged:c', targetUrn: 'urn:staged:c', after: { entityType: 'Object', displayName: 'C', parentUrn: 'urn:staged:p', containmentEdgeType: 'CONTAINS' } }),
      ],
      target,
    )

    const st = useCanvasStore.getState()
    // temp nodes swapped out for real ids, pending cleared
    expect(st.nodes.find((n) => n.id === 'urn:staged:p')).toBeUndefined()
    expect(st.nodes.find((n) => n.id === 'urn:staged:c')).toBeUndefined()
    const p = st.nodes.find((n) => n.id === 'urn:real:p')
    expect(p?.data.isPending).toBeUndefined()
    expect(p?.data.childCount).toBe(1) // orphan-prevention: parent knows it has one child
    // containment edge rebuilt with the real id + real endpoints
    const edge = st.edges.find((e) => e.source === 'urn:real:p' && e.target === 'urn:real:c')
    expect(edge?.id).toBe('edge_real')
  })
})
