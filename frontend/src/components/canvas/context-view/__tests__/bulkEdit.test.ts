/**
 * bulkEdit — several entities read as one (each field the same on all, or
 * mixed), and one edit staged for all of them: an entity's own edit each, which
 * the save sends as one batch, which merges into an edit already staged, which
 * leaves alone an entity it doesn't change, and which Undo takes back whole.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { stagedChangesToOps } from '@/features/versioning/model/stagedChangesToOps'
import { stageNodeEdit } from '@/features/versioning/model/stageNodeEdit'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

import { sharedFields, stageBulkEdit } from '../bulkEdit'

const node = (id: string, data: Record<string, unknown>): LineageNode =>
  ({ id, type: 'generic', position: { x: 0, y: 0 }, data: { urn: id, label: id, type: 'dataset', ...data } }) as unknown as LineageNode

const ORDERS = node('orders', { description: 'Orders', properties: { owner: 'ana', sla: '1h', tier: 'gold' } })
const RETURNS = node('returns', { description: 'Returns', properties: { owner: 'ana', sla: '4h' } })
const REFUNDS = node('refunds', { properties: { owner: 'ana', sla: '1h' } })

const nodes = () => useCanvasStore.getState().nodes
const changes = () => useStagedChangesStore.getState().changes

beforeEach(() => {
  useCanvasStore.setState({
    nodes: structuredClone([ORDERS, RETURNS, REFUNDS]), edges: [],
    _nodeIndex: new Set(['orders', 'returns', 'refunds']), _edgeIndex: new Set(),
  } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [] })
})

describe('sharedFields', () => {
  it('reads each field as the same on all, or mixed — with how many have it', () => {
    const { description, properties } = sharedFields(nodes())
    expect(description).toMatchObject({ state: 'mixed', has: 2, total: 3 })
    const byKey = Object.fromEntries(properties.map((p) => [p.key, p]))
    expect(byKey.owner).toMatchObject({ state: 'same', value: 'ana', has: 3, total: 3 })
    expect(byKey.sla).toMatchObject({ state: 'mixed', has: 3, total: 3 })
    expect(byKey.tier).toMatchObject({ state: 'mixed', has: 1, total: 3 })
  })
})

describe('stageBulkEdit', () => {
  it('stages each entity\'s own edit, which the save sends as one update op each', () => {
    stageBulkEdit(nodes(), { description: 'Sales records', set: { steward: 'finance' }, unset: ['tier'] })
    expect(changes().map((c) => [c.type, c.targetId])).toEqual([
      ['update_entity', 'orders'], ['update_entity', 'returns'], ['update_entity', 'refunds'],
    ])
    const ops = stagedChangesToOps(changes()) as unknown as Array<Record<string, unknown>>
    expect(ops).toHaveLength(3)
    const orders = ops.find((o) => o.id === 'orders')!
    expect(orders).toMatchObject({ op: 'update', kind: 'node' })
    expect((orders.payload as Record<string, unknown>).description).toBe('Sales records')
    expect(orders.unsetProperties).toEqual(['tier'])
    // The canvas shows the edit at once.
    expect(nodes().find((n) => n.id === 'returns')!.data.properties).toMatchObject({ steward: 'finance', owner: 'ana' })
  })

  it('leaves alone an entity the edit doesn\'t change', () => {
    stageBulkEdit(nodes(), { set: { owner: 'ana' }, unset: [] })
    expect(changes()).toEqual([])
  })

  it('merges into an edit of the entity already staged', () => {
    const orders = nodes().find((n) => n.id === 'orders')!
    stageNodeEdit('orders', orders.data, { ...orders.data, label: 'Orders v2' })
    stageBulkEdit(nodes(), { set: { steward: 'finance' }, unset: [] })
    expect(changes().filter((c) => c.targetId === 'orders')).toHaveLength(1)
    expect(changes().find((c) => c.targetId === 'orders')!.after).toMatchObject({ label: 'Orders v2' })
  })

  it('Undo takes the whole edit back — the staged changes and the canvas', () => {
    const undo = stageBulkEdit(nodes(), { description: 'Sales records', set: {}, unset: [] })
    expect(changes()).toHaveLength(3)
    undo()
    expect(changes()).toEqual([])
    expect(nodes().find((n) => n.id === 'orders')!.data.description).toBe('Orders')
    expect(nodes().find((n) => n.id === 'refunds')!.data.description).toBeUndefined()
  })
})
