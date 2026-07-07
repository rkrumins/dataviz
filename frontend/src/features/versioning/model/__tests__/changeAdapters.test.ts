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
      removed: [{ entityId: 'urn:gone', kind: 'node', before: { displayName: 'Gone' } }],
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
