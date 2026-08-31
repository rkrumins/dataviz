import { describe, it, expect } from 'vitest'
import { stagedChangesToOps, unsavedNodeFields } from '../stagedChangesToOps'
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

/**
 * The drawer edits `description`, `qualifiedName` and `sourceSystem` as TOP-LEVEL node fields
 * (EntityDrawer's Description / Metadata inputs). They are real `GraphNode` fields — the backend
 * merges them onto the entity's current payload and the projector writes them onto the FalkorDB
 * node (`n.description` / `n.qualifiedName` / `n.sourceSystem`, and into `searchableText`), so they
 * round-trip. Until this mapping existed they were dropped here, which — because an edit to only
 * those fields maps to an EMPTY payload, and an empty payload was skipped entirely — meant the user
 * saw a green "saved" over a save that made no request at all.
 */
describe('stagedChangesToOps — the descriptive fields the entity drawer edits', () => {
  it('carries a description edit to the backend', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'update_entity', targetUrn: 'urn:d', before: { description: '' }, after: { description: 'What this table is for' } }),
    ])
    expect(ops).toEqual([
      { op: 'update', kind: 'node', id: 'urn:d', payload: { description: 'What this table is for' } },
    ])
  })

  it('carries qualifiedName and sourceSystem too', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'update_entity', targetUrn: 'urn:e', after: { qualifiedName: 'analytics.public.orders', sourceSystem: 'snowflake' } }),
    ])
    expect(ops[0].payload).toEqual({ qualifiedName: 'analytics.public.orders', sourceSystem: 'snowflake' })
  })

  it('carries a description alongside the fields it already mapped', () => {
    const ops = stagedChangesToOps([
      sc({ type: 'update_entity', targetUrn: 'urn:f', after: { label: 'Orders', description: 'd', properties: { x: 1 } } }),
    ])
    expect(ops[0].payload).toEqual({ displayName: 'Orders', description: 'd', properties: { x: 1 } })
  })
})

describe('unsavedNodeFields — what a staged entity edit CANNOT carry to the backend', () => {
  it('names a changed field the mapper does not send', () => {
    expect(unsavedNodeFields(sc({
      type: 'update_entity', targetUrn: 'urn:g',
      before: { label: 'A', retentionDays: 30 },
      after: { label: 'A', retentionDays: 90 },
    }))).toEqual(['retentionDays'])
  })

  it('names them even when the rest of the edit DOES map — the op is sent, that field is not', () => {
    expect(unsavedNodeFields(sc({
      type: 'update_entity', targetUrn: 'urn:h',
      before: { description: '', owner: 'ana' },
      after: { description: 'd', owner: 'bo' },
    }))).toEqual(['owner'])
  })

  it('names businessLabel — the payload carries it, but no backend field stores it', () => {
    // The drawer edits "Business Label" as a top-level node field and the payload still carries it
    // (so a mixed batch commits the rest), but nothing on the backend reads it: `businessLabel`
    // appears nowhere in the Python, `_node_item` never projects it, and the drawer reads it back
    // out of `n.properties`. Claiming it saved is exactly the lie this mechanism exists to end.
    const c = sc({
      type: 'update_entity', targetUrn: 'urn:bl',
      before: { businessLabel: 'Orders' },
      after: { businessLabel: 'Customer Orders' },
    })
    expect(stagedChangesToOps([c])[0].payload).toEqual({ businessLabel: 'Customer Orders' })
    expect(unsavedNodeFields(c)).toEqual(['businessLabel'])
  })

  it('says nothing about the descriptive fields now that they are carried', () => {
    expect(unsavedNodeFields(sc({
      type: 'update_entity', targetUrn: 'urn:i',
      before: { description: '', qualifiedName: '', sourceSystem: '' },
      after: { description: 'd', qualifiedName: 'q', sourceSystem: 's' },
    }))).toEqual([])
  })

  it('says nothing about backend-managed fields the mapper deliberately never sends', () => {
    expect(unsavedNodeFields(sc({
      type: 'update_entity', targetUrn: 'urn:j',
      before: { childCount: 1, lastSyncedAt: 'a', version: 'v1', layerAssignment: 'raw', urn: 'urn:j' },
      after: { childCount: 2, lastSyncedAt: 'b', version: 'v2', layerAssignment: 'gold', urn: 'urn:j' },
    }))).toEqual([])
  })

  it('says nothing about a field that did not change', () => {
    expect(unsavedNodeFields(sc({
      type: 'update_entity', targetUrn: 'urn:k',
      before: { owner: 'ana', label: 'A' },
      after: { owner: 'ana', label: 'B' },
    }))).toEqual([])
  })

  it('is empty for change types that are not node updates', () => {
    expect(unsavedNodeFields(sc({ type: 'assign_layer', targetId: 'n', after: { layerId: 'L1' } }))).toEqual([])
    expect(unsavedNodeFields(sc({ type: 'delete_entity', targetId: 'n' }))).toEqual([])
    expect(unsavedNodeFields(sc({ type: 'create_entity', targetUrn: 'urn:new', after: { owner: 'ana' } }))).toEqual([])
  })
})
