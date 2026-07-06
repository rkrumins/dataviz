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

  it('maps a root create_entity to a node create op (ref=tempUrn, no urn — backend mints); excludes layer changes', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'create_entity', targetUrn: 'urn:staged:new', after: { entityType: 'Table', displayName: 'X', tags: ['pii'], properties: { p: 1 } } }),
      sc({ type: 'assign_layer', targetId: 'n3', after: { layerId: 'L1' } }),
      sc({ type: 'move_to_layer', targetId: 'n4', after: {} }),
    ])
    expect(ops).toEqual([
      { op: 'create', kind: 'node', ref: 'urn:staged:new', payload: { entityType: 'Table', displayName: 'X', tags: ['pii'], properties: { p: 1 } } },
    ])
  })

  it('carries an explicit urn + the ENTIRE node snapshot into the create payload (restore — no data loss)', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'create_entity', targetUrn: 'urn:synodic:manual:table:abc', after: {
        entityType: 'Table', displayName: 'X', urn: 'urn:synodic:manual:table:abc',
        qualifiedName: 'schema.X', sourceSystem: 'manual', layerAssignment: 'warehouse', description: 'd',
        childCount: 3, lastSyncedAt: '2026-07-05T20:46:13', tags: [], properties: {},
        // client-only containment hints must NOT reach the node payload
        parentUrn: 'urn:staged:p', containmentEdgeType: 'CONTAINS', parentLabel: 'P',
      } }),
    ])
    const nodeOp = ops.find((o) => o.kind === 'node')!
    // urn → resurrect; the WHOLE snapshot preserved (childCount + lastSyncedAt included now)…
    expect(nodeOp.payload).toEqual({
      entityType: 'Table', displayName: 'X', urn: 'urn:synodic:manual:table:abc',
      qualifiedName: 'schema.X', sourceSystem: 'manual', layerAssignment: 'warehouse', description: 'd',
      childCount: 3, lastSyncedAt: '2026-07-05T20:46:13', tags: [], properties: {},
    })
    // …and the containment hints stayed out of the node payload (they drive the edge instead).
    expect(nodeOp.payload).not.toHaveProperty('parentUrn')
    expect(nodeOp.payload).not.toHaveProperty('containmentEdgeType')
  })

  it('maps a nested create_entity to a node create op + a containment edge op (parent by ref — backend resolves)', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'create_entity', targetUrn: 'urn:staged:child', after: { entityType: 'Column', displayName: 'C', parentUrn: 'urn:staged:parent', containmentEdgeType: 'CONTAINS' } }),
    ])
    expect(ops).toEqual([
      { op: 'create', kind: 'node', ref: 'urn:staged:child', payload: { entityType: 'Column', displayName: 'C' } },
      { op: 'create', kind: 'edge', ref: 'contains-urn:staged:child', payload: { edgeType: 'CONTAINS', sourceEntityId: 'urn:staged:parent', targetEntityId: 'urn:staged:child' } },
    ])
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
