/**
 * Review & Save says what each change does in words a business reader uses — and lists only the
 * fields the save will send, never the whole node twice.
 */
import { describe, expect, it } from 'vitest'
import type { StagedChange } from '@/store/stagedChangesStore'
import { buildReviewGroups, describeScope, fieldChanges, sentenceFor, suggestTitle, type Sentence } from '../reviewModel'

const names: Record<string, string> = { 'urn:orders': 'Orders', 'urn:sales': 'Sales', 'urn:db': 'Warehouse' }
const lookup = { nameOf: (id: string) => names[id] ?? id, typeOf: () => 'dataset' }
const text = (s: Sentence) => s.map((p) => (typeof p === 'string' ? p : p.name)).join('')

let seq = 0
const change = (over: Partial<StagedChange>): StagedChange => ({
  id: `c${++seq}`, type: 'update_entity', targetId: 'urn:orders', targetUrn: 'urn:orders',
  after: {}, summary: 'a summary', timestamp: seq, ...over,
})

const node = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ label: 'Orders', urn: 'urn:orders', type: 'dataset', description: 'old', properties: props, ...extra })

describe('fieldChanges', () => {
  it('lists only what the save sends, named as the drawer names it', () => {
    const c = change({
      before: node({ owner: 'ana', 'Technical/Path': '/a', legacy: true, childCount: 3 }),
      after: node({ owner: 'bea', 'Technical/Path': '/a', tier: 'gold', businessLabel: 'Customer orders', childCount: 3 }, { description: 'new' }),
    })
    expect(fieldChanges(c)).toEqual([
      { label: 'Description', before: 'old', after: 'new', kind: 'changed' },
      { label: 'owner', before: 'ana', after: 'bea', kind: 'changed' },
      { label: 'tier', before: undefined, after: 'gold', kind: 'added' },
      { label: 'Business label', before: undefined, after: 'Customer orders', kind: 'added' },
      { label: 'legacy', before: true, after: undefined, kind: 'removed' },
    ])
  })

  it('names a property in a folder by its own name, with the folder beside it', () => {
    const c = change({ before: node({ 'Technical/Path': '/a' }), after: node({ 'Technical/Path': '/b' }) })
    expect(fieldChanges(c)).toEqual([{ label: 'Path', folder: 'Technical', before: '/a', after: '/b', kind: 'changed' }])
  })
})

describe('sentenceFor', () => {
  it('says each kind of change in words', () => {
    expect(text(sentenceFor(change({ type: 'rename_entity', before: { label: 'orders' }, after: { label: 'Orders v2' } }), lookup)))
      .toBe('Renamed orders to Orders v2')
    expect(text(sentenceFor(change({ type: 'create_entity', after: { displayName: 'Refunds', parentUrn: 'urn:db' } }), lookup)))
      .toBe('Added Refunds inside Warehouse')
    expect(text(sentenceFor(change({ type: 'create_edge', after: { source: 'urn:orders', target: 'urn:sales', edgeType: 'FEEDS' } }), lookup)))
      .toBe('Connected Orders → Sales as FEEDS')
    expect(text(sentenceFor(change({ type: 'delete_edge', before: { edge: { source: 'urn:orders', target: 'urn:sales' } } }), lookup)))
      .toBe('Disconnected Orders → Sales')
    expect(text(sentenceFor(change({
      type: 'delete_entity', before: { node: { id: 'urn:orders', data: { label: 'Orders' } }, cascade: { nodeTotal: 4, edgeTotal: 2 } },
    }), lookup))).toBe('Deleted Orders — with 3 items inside it and 2 relationships')
    expect(text(sentenceFor(change({ type: 'move_entity', after: { childId: 'urn:orders', parentId: 'urn:db' } }), lookup)))
      .toBe('Moved Orders inside Warehouse')
  })

  it('falls back to the change’s own summary when it carries too little to say more', () => {
    expect(sentenceFor(change({ type: 'create_entity', after: {} }), lookup)).toEqual(['a summary'])
    expect(sentenceFor(change({ type: 'layer_config', after: { layers: [] } }), lookup)).toEqual(['a summary'])
  })
})

describe('buildReviewGroups', () => {
  it('groups changes by what they change; a create outranks an edit made to it too', () => {
    const groups = buildReviewGroups([
      change({ type: 'create_entity', targetId: 'tmp', targetUrn: 'urn:new', after: { displayName: 'New one', entityType: 'table' } }),
      change({ type: 'update_entity', targetId: 'urn:orders', before: node({ a: 1 }), after: node({ a: 2 }) }),
      change({ type: 'rename_entity', targetId: 'tmp', targetUrn: 'urn:new', before: { label: 'New one' }, after: { label: 'Newer' } }),
      change({ type: 'create_edge', targetId: 'e1', targetUrn: undefined, after: { source: 'urn:orders', target: 'urn:sales' } }),
      change({ type: 'layer_config', targetId: 'l', targetUrn: undefined, after: {} }),
    ], lookup)
    expect(groups.map((g) => [g.kind, g.name, g.status, g.changes.length])).toEqual([
      ['node', 'New one', 'added', 2],
      ['node', 'Orders', 'modified', 1],
      ['edge', 'Orders → Sales', 'added', 1],
      ['layout', 'a summary', 'modified', 1],
    ])
    expect(groups[0].typeId).toBe('table')
    expect(describeScope(groups)).toBe('2 entities, 1 relationship and 1 layout change')
  })

  it('suggests a publish title from the first change', () => {
    const one = buildReviewGroups([change({ before: node({ owner: 'ana' }), after: node({ owner: 'bea' }) })], lookup)
    expect(suggestTitle(one)).toBe('Update owner on Orders')
    const two = buildReviewGroups([
      change({ before: node({ owner: 'ana' }), after: node({ owner: 'bea', sla: '1h' }) }),
      change({ type: 'create_edge', targetId: 'e1', targetUrn: undefined, after: { source: 'urn:orders', target: 'urn:sales' } }),
    ], lookup)
    expect(suggestTitle(two)).toBe('Update Orders and 1 more')
  })
})
