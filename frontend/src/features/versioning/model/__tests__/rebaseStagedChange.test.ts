/**
 * Settling a conflict rebases only what the user changed onto the entity as it is now: "mine"
 * keeps the user's value, "theirs" drops it, and everything else anyone changed is kept. An edit
 * left with nothing to change goes away.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { rebaseStagedChange, resolveConflict } from '../rebaseStagedChange'
import { stagedChangesToOps } from '../stagedChangesToOps'

const read = { urn: 'urn:n', label: 'Orders', type: 'dataset', version: 'v1', properties: { owner: 'ana', sla: '1h', tier: 'bronze' } }
// The user: owner ana→bo, removed sla, renamed. Someone else meanwhile: owner→cy, added region.
const change: StagedChange = {
  id: 'c1', type: 'update_entity', targetId: 'urn:n', targetUrn: 'urn:n', summary: '', timestamp: 0,
  before: read,
  after: { ...read, label: 'Orders v2', properties: { owner: 'bo', tier: 'bronze' } },
  conflict: {
    fields: [{ key: 'properties.owner', path: ['properties', 'owner'], base: 'ana', mine: 'bo', theirs: 'cy' }],
    current: { kind: 'node', version: 'v7', node: {
      urn: 'urn:n', entityType: 'dataset', displayName: 'Orders', version: 'v7',
      properties: { owner: 'cy', sla: '1h', tier: 'bronze', region: 'eu' } } as never },
  },
  error: 'conflict',
}

const opOf = (c: StagedChange | null) => stagedChangesToOps(c ? [c] : [])[0]

describe('rebaseStagedChange', () => {
  it('"mine" keeps the user’s value on top of the current value, with the current token', () => {
    const out = rebaseStagedChange(change, { 'properties.owner': 'mine' })!
    expect(out.conflict).toBeUndefined()
    expect(out.error).toBeUndefined()
    const op = opOf(out)
    expect(op.baseVersion).toBe('v7')
    expect(op.payload).toEqual({ displayName: 'Orders v2', properties: { owner: 'bo' } })
    expect(op.unsetProperties).toEqual(['sla'])
    expect((out.after as { properties: object }).properties).toEqual({ owner: 'bo', tier: 'bronze', region: 'eu' })
  })

  it('"theirs" gives up the user’s value for that field only', () => {
    const op = opOf(rebaseStagedChange(change, { 'properties.owner': 'theirs' }))
    expect(op.payload).toEqual({ displayName: 'Orders v2' })
    expect(op.unsetProperties).toEqual(['sla'])
  })

  it('drops the change when "theirs" leaves nothing of it', () => {
    const only: StagedChange = {
      ...change,
      after: { ...read, properties: { ...read.properties, owner: 'bo' } },
    }
    expect(rebaseStagedChange(only, { 'properties.owner': 'theirs' })).toBeNull()
  })

  it('drops the change when the entity was deleted meanwhile', () => {
    expect(rebaseStagedChange({ ...change, conflict: { ...change.conflict!, current: { kind: 'node', version: null, deleted: true } } }, {})).toBeNull()
  })

  it('rebases a relationship edit onto its current properties and token', () => {
    const edge: StagedChange = {
      id: 'c2', type: 'edit_edge', targetId: 'e1', summary: '', timestamp: 0,
      before: { properties: { sla: '1h', owner: 'ana' } },
      after: { properties: { sla: '2h' } },
      conflict: {
        fields: [{ key: 'properties.sla', path: ['properties', 'sla'], base: '1h', mine: '2h', theirs: '4h' }],
        current: { kind: 'edge', version: 'e7', edge: { id: 'e1', sourceUrn: 'a', targetUrn: 'b', edgeType: 'T', properties: { sla: '4h', owner: 'ana', note: 'n' } } },
      },
    }
    const op = opOf(rebaseStagedChange(edge, { 'properties.sla': 'mine' }))
    expect(op).toEqual({ op: 'update', kind: 'edge', id: 'e1', baseVersion: 'e7',
      payload: { properties: { sla: '2h' } }, unsetProperties: ['owner'] })
  })
})

describe('resolveConflict', () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [{ id: 'urn:n', type: 'generic', position: { x: 0, y: 0 }, data: { ...change.after as object } } as LineageNode], edges: [] } as never)
    useStagedChangesStore.setState({ changes: [change], redoStack: [] })
  })

  it('rebases the change in the store and shows the outcome on the canvas', () => {
    resolveConflict('c1', { 'properties.owner': 'theirs' })
    const [c] = useStagedChangesStore.getState().changes
    expect(c.conflict).toBeUndefined()
    const n = useCanvasStore.getState().nodes[0]
    expect(n.data.properties).toEqual({ owner: 'cy', tier: 'bronze', region: 'eu' })
    expect(n.data.label).toBe('Orders v2')
    c.discard?.()
    expect(useCanvasStore.getState().nodes[0].data.label).toBe('Orders')     // the current value, not the stale read
  })

  it('removes a change with nothing left and shows the current value', () => {
    useStagedChangesStore.setState({ changes: [{ ...change, after: { ...read, properties: { ...read.properties, owner: 'bo' } } }] })
    resolveConflict('c1', { 'properties.owner': 'theirs' })
    expect(useStagedChangesStore.getState().changes).toEqual([])
    expect(useCanvasStore.getState().nodes[0].data.properties).toEqual({ owner: 'cy', sla: '1h', tier: 'bronze', region: 'eu' })
  })
})
