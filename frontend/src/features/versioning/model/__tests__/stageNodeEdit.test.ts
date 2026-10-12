/**
 * stageNodeEdit keeps ONE staged edit per node, whichever surface made it: the node as first read
 * stays the diff base and the discard target, a rename joins a drawer edit, and an edit put back
 * the way it was leaves nothing to save.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { stageNodeEdit } from '../stageNodeEdit'
import { stagedChangesToOps } from '../stagedChangesToOps'

const read: LineageNode['data'] = {
  urn: 'urn:n', label: 'Orders', type: 'Table', version: 'v1', properties: { owner: 'ana', sla: '1h' },
}

const node = () => useCanvasStore.getState().nodes.find((n) => n.id === 'urn:n')!
const changes = () => useStagedChangesStore.getState().changes

beforeEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })
  useCanvasStore.getState().addNodes([{ id: 'urn:n', type: 'generic', position: { x: 0, y: 0 }, data: { ...read } }])
})

describe('stageNodeEdit', () => {
  it('stages an edit, shows it on the canvas, and saves it as a patch', () => {
    stageNodeEdit('urn:n', node().data, { ...read, properties: { owner: 'bo' } })
    expect(node().data.properties).toEqual({ owner: 'bo' })
    expect(changes()).toHaveLength(1)
    expect(changes()[0].type).toBe('update_entity')
    expect(stagedChangesToOps(changes())).toEqual([{
      op: 'update', kind: 'node', id: 'urn:n', baseVersion: 'v1',
      payload: { properties: { owner: 'bo' } }, unsetProperties: ['sla'],
    }])
  })

  it('a name-only edit is a rename', () => {
    stageNodeEdit('urn:n', node().data, { ...read, label: 'Orders v2' })
    expect(changes()[0].type).toBe('rename_entity')
    expect(changes()[0].summary).toBe("Rename 'Orders' → 'Orders v2'")
  })

  it('a rename after a drawer edit joins it — one change, the first read kept as its base', () => {
    stageNodeEdit('urn:n', node().data, { ...read, properties: { owner: 'ana' } })
    stageNodeEdit('urn:n', node().data, { ...node().data, label: 'Renamed' })
    expect(changes()).toHaveLength(1)
    expect(changes()[0].before).toEqual(read)
    const [op] = stagedChangesToOps(changes())
    expect(op.payload).toEqual({ displayName: 'Renamed' })
    expect(op.unsetProperties).toEqual(['sla'])
  })

  it('completes an older partial snapshot from the node as read now', () => {
    useStagedChangesStore.getState().stage({
      type: 'rename_entity', targetId: 'urn:n', targetUrn: 'urn:n',
      before: { label: 'Orders' }, after: { label: 'Renamed' }, summary: '',
    })
    useCanvasStore.getState().updateNode('urn:n', { label: 'Renamed' })
    stageNodeEdit('urn:n', node().data, { ...node().data, properties: { owner: 'ana' } })
    expect(changes()).toHaveLength(1)
    expect(changes()[0].before).toEqual(read)
    const [op] = stagedChangesToOps(changes())
    expect(op.payload).toEqual({ displayName: 'Renamed' })
    expect(op.unsetProperties).toEqual(['sla'])
  })

  it('an edit put back the way it was leaves nothing staged', () => {
    stageNodeEdit('urn:n', node().data, { ...read, label: 'Other' })
    stageNodeEdit('urn:n', node().data, { ...node().data, label: 'Orders' })
    expect(changes()).toEqual([])
    expect(node().data.label).toBe('Orders')
  })

  it('discard restores the node as first read', () => {
    stageNodeEdit('urn:n', node().data, { ...read, label: 'A', properties: {} })
    stageNodeEdit('urn:n', node().data, { ...node().data, label: 'B' })
    useStagedChangesStore.getState().discard(changes()[0].id)
    expect(node().data.label).toBe('Orders')
    expect(node().data.properties).toEqual({ owner: 'ana', sla: '1h' })
  })
})
