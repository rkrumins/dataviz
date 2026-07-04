import { describe, it, expect } from 'vitest'
import { stagedChangesToOps } from '../stagedChangesToOps'
import type { StagedChange } from '@/store/stagedChangesStore'

const sc = (over: Partial<StagedChange>): StagedChange => ({
  id: 'c', type: 'rename_entity', targetId: 't', after: {}, summary: '', timestamp: 0, ...over,
})

describe('stagedChangesToOps', () => {
  it('maps a rename to a partial node update (label → displayName)', () => {
    const ops = stagedChangesToOps([sc({ type: 'rename_entity', targetId: 'n1', targetUrn: 'urn:a', after: { label: 'New' } })])
    expect(ops).toEqual([{ op: 'update', kind: 'node', id: 'urn:a', payload: { displayName: 'New' } }])
  })

  it('maps an update_entity, normalizing canvas fields to backend fields', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'update_entity', targetUrn: 'urn:b', after: { label: 'B', type: 'Table', classifications: ['pii'], properties: { x: 1 } } }),
    ])
    expect(ops[0]).toEqual({
      op: 'update', kind: 'node', id: 'urn:b',
      payload: { displayName: 'B', entityType: 'Table', tags: ['pii'], properties: { x: 1 } },
    })
  })

  it('maps delete_entity / delete_edge to delete ops', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'delete_entity', targetId: 'n2', targetUrn: 'urn:c' }),
      sc({ type: 'delete_edge', targetId: 'e1' }),
    ])
    expect(ops).toEqual([
      { op: 'delete', kind: 'node', id: 'urn:c' },
      { op: 'delete', kind: 'edge', id: 'e1' },
    ])
  })

  it('maps edit_edge to a partial edge update, dropping immutable/client-only keys', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'edit_edge', targetId: 'e2', after: { confidence: 0.9, edgeType: 'LINEAGE', isAggregated: true, animated: false } }),
    ])
    expect(ops).toEqual([{ op: 'update', kind: 'edge', id: 'e2', payload: { confidence: 0.9 } }])
  })

  it('excludes create_entity (provider path) and layer changes carrying no layerId', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'create_entity', targetUrn: 'urn:new', after: { entityType: 'Table', displayName: 'X' } }),
      sc({ type: 'move_to_layer', targetId: 'n4', after: {} }),
    ])
    expect(ops).toEqual([])
  })

  it('persists a layer move as a node update of top-level layerAssignment', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'assign_layer', targetId: 'urn:x', after: { layerId: 'warehouse' } }),
      sc({ type: 'move_to_layer', targetId: 'n5', targetUrn: 'urn:y', after: { layerId: 'transform' } }),
    ])
    expect(ops).toEqual([
      { op: 'update', kind: 'node', id: 'urn:x', payload: { layerAssignment: 'warehouse' } },
      { op: 'update', kind: 'node', id: 'urn:y', payload: { layerAssignment: 'transform' } },
    ])
  })

  it('resolves a just-created entity temp urn before persisting its layer move', () => {
    const resolve = (id: string) => (id === 'urn:staged:z' ? 'urn:real:z' : id)
    const ops = stagedChangesToOps(
      [sc({ type: 'assign_layer', targetId: 'urn:staged:z', after: { layerId: 'warehouse' } })],
      resolve,
    )
    expect(ops).toEqual([{ op: 'update', kind: 'node', id: 'urn:real:z', payload: { layerAssignment: 'warehouse' } }])
  })

  it('maps create_edge to a create edge op (endpoints as sourceEntityId/targetEntityId)', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'create_edge', targetId: 'staged-edge-1', after: { edgeType: 'FLOWS_TO', source: 'urn:a', target: 'urn:b' } }),
    ])
    expect(ops).toEqual([
      { op: 'create', kind: 'edge', ref: 'staged-edge-1', payload: { edgeType: 'FLOWS_TO', sourceEntityId: 'urn:a', targetEntityId: 'urn:b' } },
    ])
  })

  it('resolves create_edge endpoints through the temp-id resolver (edge between two new nodes)', () => {
    const resolve = (id: string) => ({ 'urn:staged:a': 'urn:real:a', 'urn:staged:b': 'urn:real:b' }[id] ?? id)
    const ops = stagedChangesToOps(
      [sc({ type: 'create_edge', targetId: 'staged-edge-2', after: { edgeType: 'PRODUCES', source: 'urn:staged:a', target: 'urn:staged:b' } })],
      resolve,
    )
    expect(ops[0].payload).toEqual({ edgeType: 'PRODUCES', sourceEntityId: 'urn:real:a', targetEntityId: 'urn:real:b' })
  })

  it('resolves reverse_edge endpoints through the temp-id resolver too', () => {
    const resolve = (id: string) => (id === 'urn:staged:a' ? 'urn:real:a' : id)
    const ops = stagedChangesToOps(
      [sc({ type: 'reverse_edge', targetId: 'staged-edge-3', before: { edge: { id: 'e9' } }, after: { edge: { edgeType: 'FLOWS_TO', source: 'urn:staged:a', target: 'urn:b' } } })],
      resolve,
    )
    expect(ops).toEqual([
      { op: 'delete', kind: 'edge', id: 'e9' },
      { op: 'create', kind: 'edge', id: 'staged-edge-3', payload: { edgeType: 'FLOWS_TO', sourceEntityId: 'urn:real:a', targetEntityId: 'urn:b' } },
    ])
  })
})
