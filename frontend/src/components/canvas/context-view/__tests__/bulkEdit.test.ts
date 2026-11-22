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

import { missingNodeIds, patchFor, previewBulkEdit, sharedFields, stageBulkEdit } from '../bulkEdit'

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

  it('says how they differ: same, differs, or held by only some — and which entities hold each value', () => {
    const { properties } = sharedFields(nodes())
    const byKey = Object.fromEntries(properties.map((p) => [p.key, p]))
    expect(byKey.owner).toMatchObject({ kind: 'same', type: 'text' })
    expect(byKey.sla.kind).toBe('differs')
    // Most held first.
    expect(byKey.sla.groups.map((g) => [g.value, g.nodeIds])).toEqual([['1h', ['orders', 'refunds']], ['4h', ['returns']]])
    expect(byKey.tier.kind).toBe('partial')
    expect(missingNodeIds(byKey.tier, ['orders', 'returns', 'refunds'])).toEqual(['returns', 'refunds'])
    expect(missingNodeIds(byKey.owner, ['orders', 'returns', 'refunds'])).toEqual([])
  })

  it('tells a number from the same digits as text, and reads the type most of the values have', () => {
    const fields = sharedFields([
      node('a', { properties: { rows: 10 } }), node('b', { properties: { rows: '10' } }), node('c', { properties: { rows: 12 } }),
    ]).properties[0]!
    expect(fields.kind).toBe('differs')
    expect(fields.groups).toHaveLength(3)
    expect(fields.type).toBe('number')
  })

  it('compares 5,000 entities with 50 properties each within budget', () => {
    const many = Array.from({ length: 5000 }, (_, i) => node(`n${i}`, {
      properties: Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`p${k}`, k % 3 === 0 ? 'same' : `${k}-${i % 7}`])),
    }))
    const t = performance.now()
    const { properties } = sharedFields(many)
    expect(performance.now() - t).toBeLessThan(250)
    expect(properties).toHaveLength(50)
    expect(properties.find((p) => p.key === 'p0')!.kind).toBe('same')
    expect(properties.find((p) => p.key === 'p1')!.groups).toHaveLength(7)
  })
})

describe('patchFor', () => {
  const props = { owner: 'ana', sla: '1h', steward: 'ops' }

  it('sets only what changes, and counts the values it replaces', () => {
    expect(patchFor(props, { set: { owner: 'ana', sla: '2h' }, unset: [] })).toEqual({ set: { sla: '2h' }, unset: [], overwritten: 1, skipped: 0 })
  })

  it('fills only where there is no value', () => {
    expect(patchFor(props, { set: {}, fill: { owner: 'bo', tier: 'gold' }, unset: [] }).set).toEqual({ tier: 'gold' })
  })

  it('renames — leaving alone an entity that already holds the new name, unless told to replace it', () => {
    expect(patchFor(props, { set: {}, moves: [{ from: 'owner', to: 'lead' }], unset: [] })).toMatchObject({ set: { lead: 'ana' }, unset: ['owner'] })
    expect(patchFor(props, { set: {}, moves: [{ from: 'owner', to: 'steward' }], unset: [] })).toEqual({ set: {}, unset: [], overwritten: 0, skipped: 1 })
    expect(patchFor(props, { set: {}, moves: [{ from: 'owner', to: 'steward', overwrite: true }], unset: [] }))
      .toEqual({ set: { steward: 'ana' }, unset: ['owner'], overwritten: 1, skipped: 0 })
  })

  it('copies, keeping the original; a property it does not hold moves nothing', () => {
    expect(patchFor(props, { set: {}, moves: [{ from: 'owner', to: 'lead', keep: true }], unset: [] })).toMatchObject({ set: { lead: 'ana' }, unset: [] })
    expect(patchFor(props, { set: {}, moves: [{ from: 'tier', to: 'level' }], unset: [] }).set).toEqual({})
  })

  it('removes only what it holds', () => {
    expect(patchFor(props, { set: {}, unset: ['sla', 'tier'] }).unset).toEqual(['sla'])
  })
})

describe('previewBulkEdit', () => {
  it('says how many entities change, and how many values are replaced or left alone', () => {
    expect(previewBulkEdit(nodes(), { set: { sla: '1h' }, moves: [{ from: 'tier', to: 'owner' }], unset: [] }))
      .toEqual({ entities: 1, changes: 2, overwritten: 1, skipped: 1 })
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

  it('stages a fill and a rename as each entity\'s own edit', () => {
    stageBulkEdit(nodes(), { set: {}, fill: { tier: 'silver' }, moves: [{ from: 'sla', to: 'target' }], unset: [] })
    const ops = stagedChangesToOps(changes()) as unknown as Array<Record<string, unknown>>
    const returns = ops.find((o) => o.id === 'returns')!
    expect((returns.payload as Record<string, unknown>).properties).toEqual({ tier: 'silver', target: '4h' })
    expect(returns.unsetProperties).toEqual(['sla'])
    expect(((ops.find((o) => o.id === 'orders')!.payload as Record<string, unknown>).properties)).toEqual({ target: '1h' })
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

  it('stages 5,000 entities in one write and one Undo step — and Undo takes it back in one', () => {
    const many = Array.from({ length: 5000 }, (_, i) => node(`n${i}`, { properties: { owner: 'ana' } }))
    useCanvasStore.setState({ nodes: structuredClone(many), _nodeIndex: new Set(many.map((n) => n.id)) } as never)
    useStagedChangesStore.setState({ changes: [], past: [], redoStack: [] } as never)
    let writes = 0
    const unsub = useStagedChangesStore.subscribe(() => { writes++ })
    const t = performance.now()
    const undo = stageBulkEdit(nodes(), { set: { steward: 'finance' }, unset: [] })
    expect(performance.now() - t).toBeLessThan(2000)
    expect(writes).toBe(1)
    expect(changes()).toHaveLength(5000)
    expect(useStagedChangesStore.getState().past).toHaveLength(1)
    expect(nodes()[4999].data.properties).toMatchObject({ steward: 'finance' })
    undo()
    unsub()
    expect(changes()).toEqual([])
    expect(nodes()[4999].data.properties).toEqual({ owner: 'ana' })
  })

  it('Undo does nothing once something else was done since', () => {
    const undo = stageBulkEdit(nodes(), { description: 'Sales records', set: {}, unset: [] })
    stageNodeEdit('orders', nodes()[0].data, { ...nodes()[0].data, label: 'Orders v2' })
    undo()
    expect(changes()).toHaveLength(3)
  })
})
