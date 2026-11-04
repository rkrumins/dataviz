import { describe, it, expect } from 'vitest'
import { buildChangeSet, deriveFieldDeltas } from '../changeModel'
import { fromStagedChanges, fromDiffVsMain } from '../changeAdapters'
import type { StagedChange } from '@/store/stagedChangesStore'
import type { DiffVsMainResponse } from '@/services/versioningApiService'

const staged = (over: Partial<StagedChange>): StagedChange => ({
  id: 'c1',
  type: 'create_entity',
  targetId: 'staged-1',
  after: {},
  summary: '',
  timestamp: 0,
  ...over,
})

describe('changeModel', () => {
  it('buildChangeSet indexes by entityId (last write wins) and counts by status', () => {
    const cs = buildChangeSet([
      { entityId: 'a', kind: 'node', status: 'added', label: 'A', origin: { source: 'branch', branchId: 'b' } },
      { entityId: 'b', kind: 'node', status: 'modified', label: 'B', origin: { source: 'branch', branchId: 'b' } },
      { entityId: 'a', kind: 'node', status: 'removed', label: 'A2', origin: { source: 'branch', branchId: 'b' } },
    ])
    expect(cs.byEntityId.get('a')?.status).toBe('removed') // last write wins
    expect(cs.counts).toEqual({ added: 1, modified: 1, removed: 1 })
    expect(cs.origin).toBe('branch')
  })

  it('deriveFieldDeltas reports only changed, non-internal fields', () => {
    const deltas = deriveFieldDeltas(
      { displayName: 'Orders', _internal: 1, kept: 'x' },
      { displayName: 'Orders v2', _internal: 2, kept: 'x' },
    )
    expect(deltas).toEqual([{ field: 'displayName', before: 'Orders', after: 'Orders v2' }])
  })
})

describe('fromStagedChanges', () => {
  it('maps create/update/delete to added/modified/removed and keeps the staged id for discard', () => {
    const cs = fromStagedChanges([
      staged({ id: 'c1', type: 'create_entity', targetUrn: 'urn:a', summary: 'New A' }),
      staged({ id: 'c2', type: 'rename_entity', targetUrn: 'urn:b', before: { displayName: 'B' }, after: { displayName: 'B2' } }),
      staged({ id: 'c3', type: 'delete_edge', targetId: 'e1' }),
    ])
    expect(cs.counts).toEqual({ added: 1, modified: 1, removed: 1 })
    const added = cs.byEntityId.get('urn:a')!
    expect(added.status).toBe('added')
    expect(added.kind).toBe('node')
    const modified = cs.byEntityId.get('urn:b')!
    expect(modified.status).toBe('modified')
    expect(modified.fields).toEqual([{ field: 'displayName', before: 'B', after: 'B2' }])
    const removed = cs.byEntityId.get('e1')!
    expect(removed.status).toBe('removed')
    expect(removed.kind).toBe('edge')
    expect(removed.origin).toEqual({ source: 'staged', stagedChangeId: 'c3' })
  })
})

describe('fromDiffVsMain', () => {
  it('maps the UI-shaped backend diff into a ChangeSet with payloads + before/after', () => {
    const resp: DiffVsMainResponse = {
      added: [{ entityId: 'urn:new', kind: 'node', after: { displayName: 'New', urn: 'urn:new' } }],
      removed: [{ entityId: 'urn:gone', kind: 'node', before: { displayName: 'Gone', urn: 'urn:gone' } }],
      modified: [
        { entityId: 'e9', kind: 'edge', before: { edgeType: 'LINEAGE', confidence: 0.5 }, after: { edgeType: 'LINEAGE', confidence: 0.9 } },
      ],
    }
    const cs = fromDiffVsMain(resp, 'br_x')
    expect(cs.counts).toEqual({ added: 1, modified: 1, removed: 1 })
    expect(cs.byEntityId.get('urn:new')?.label).toBe('New')
    expect(cs.byEntityId.get('e9')?.fields).toEqual([{ field: 'confidence', before: 0.5, after: 0.9 }])
    expect(cs.byEntityId.get('urn:gone')?.origin).toEqual({ source: 'branch', branchId: 'br_x' })
  })
})

describe('fromDiffVsMain, slim', () => {
  it('counts and indexes modified entities that come by id alone', () => {
    const resp: DiffVsMainResponse = {
      added: [{ entityId: 'urn:new', kind: 'node', after: { displayName: 'New', urn: 'urn:new' } }],
      removed: [],
      modified: [{ entityId: 'urn:m', kind: 'node', urn: 'urn:m' }, { entityId: 'e9', kind: 'edge' }],
    }
    const cs = fromDiffVsMain(resp, 'br_x')
    expect(cs.counts).toEqual({ added: 1, modified: 2, removed: 0 })
    expect(cs.byEntityId.get('urn:m')).toMatchObject({ status: 'modified', label: 'urn:m', fields: [] })
    expect(cs.byEntityId.get('urn:new')?.after).toEqual({ displayName: 'New', urn: 'urn:new' })
  })
})

describe('fromDiffVsMain, entity ids that are not urns', () => {
  // An import names its entities by id (`ent_A`), while the canvas names a node by its urn and an
  // edge's ends by urn. The overlay is looked up by the canvas's names.
  const resp: DiffVsMainResponse = {
    added: [
      { entityId: 'ent_A', kind: 'node', urn: 'urn:A' },                                   // slim: the urn alone
      { entityId: 'ent_B', kind: 'node', after: { urn: 'urn:B', displayName: 'B' } },      // from its payload
      { entityId: 'ent_C', kind: 'node' },                                                 // neither: the reader's stand-in
      { entityId: 'edge_1', kind: 'edge', sourceUrn: 'urn:A', targetUrn: 'urn:B',
        after: { edgeType: 'CONTAINS', sourceEntityId: 'ent_A', targetEntityId: 'ent_B' } },
      { entityId: 'edge_2', kind: 'edge', after: { edgeType: 'FLOWS_TO', sourceEntityId: 'urn:A', targetEntityId: 'urn:B' } },
    ],
    removed: [],
    modified: [],
  }

  it('keys a node by its urn, never by its entity id', () => {
    const cs = fromDiffVsMain(resp, 'br_x')
    expect(cs.byEntityId.get('urn:A')).toMatchObject({ entityId: 'ent_A', urn: 'urn:A', status: 'added' })
    expect(cs.byEntityId.get('urn:B')).toMatchObject({ entityId: 'ent_B', urn: 'urn:B' })
    expect(cs.byEntityId.get('gv:ent_C')).toMatchObject({ entityId: 'ent_C', urn: 'gv:ent_C' })
    expect(cs.byEntityId.has('ent_A')).toBe(false)
  })

  it('names an edge’s ends by urn, from the entry or else its payload', () => {
    const cs = fromDiffVsMain(resp, 'br_x')
    expect(cs.byEntityId.get('edge_1')).toMatchObject({ sourceUrn: 'urn:A', targetUrn: 'urn:B' })
    expect(cs.byEntityId.get('edge_2')).toMatchObject({ sourceUrn: 'urn:A', targetUrn: 'urn:B' })
    expect(cs.byEntityId.get('edge_1')?.urn).toBeUndefined()
  })
})
