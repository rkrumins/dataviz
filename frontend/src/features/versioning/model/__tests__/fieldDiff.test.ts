import { describe, expect, it } from 'vitest'
import { entityFieldChanges, fromFieldDeltas, fromRevisionChanges, fieldChangeCounts } from '../fieldDiff'

describe('entityFieldChanges', () => {
  it('lists each property that changed on its own row, not the properties object', () => {
    const rows = entityFieldChanges(
      { displayName: 'orders', version: 'v1', childCount: 3, properties: { owner: 'ana', 'Technical/Physical/format': 'csv', keep: 1 } },
      { displayName: 'Orders', version: 'v2', childCount: 4, properties: { owner: 'bo', 'Technical/Physical/format': 'csv', keep: 1, pii: true } },
    )
    expect(rows).toEqual([
      { label: 'Name', before: 'orders', after: 'Orders', kind: 'changed' },
      { label: 'owner', before: 'ana', after: 'bo', kind: 'changed' },
      { label: 'pii', before: undefined, after: true, kind: 'added' },
    ])
  })

  it('names a property in a folder by its name, in its folder', () => {
    const [row] = entityFieldChanges({ properties: {} }, { properties: { 'Technical/Physical/format': 'parquet' } })
    expect(row).toMatchObject({ label: 'format', folder: 'Technical/Physical', kind: 'added' })
  })

  it('reads the canvas shape as the stored one, and ignores a canvas mirror of a property', () => {
    const rows = entityFieldChanges(
      { label: 'A', type: 'Table', classifications: ['x'], businessLabel: 'Old', properties: { businessLabel: 'Old' } },
      { label: 'A', type: 'Table', classifications: ['x', 'y'], businessLabel: 'New', properties: { businessLabel: 'New' } },
    )
    expect(rows.map((r) => r.label)).toEqual(['Tags', 'Business label'])
  })

  it('treats a missing and an empty value as the same', () => {
    expect(entityFieldChanges({ description: null, tags: [] }, { description: '' })).toEqual([])
  })

  it('lists every field of an added or removed entity', () => {
    const added = entityFieldChanges(undefined, { urn: 'u', displayName: 'New', entityType: 'Table', properties: { owner: 'ana' } })
    expect(added.map((r) => [r.label, r.kind])).toEqual([['Name', 'added'], ['Type', 'added'], ['owner', 'added']])
    const removed = entityFieldChanges({ displayName: 'Gone' }, undefined)
    expect(removed).toEqual([{ label: 'Name', before: 'Gone', after: undefined, kind: 'removed' }])
  })

  it('reads an edge as a relationship, and a legacy flattened edge’s properties as properties', () => {
    const rows = entityFieldChanges(
      { edgeType: 'FEEDS', sourceEntityId: 'a', targetEntityId: 'b', confidence: 0.5, note: 'x' },
      { edgeType: 'FEEDS', sourceEntityId: 'a', targetEntityId: 'c', confidence: 0.9, properties: { note: 'y' } },
      'edge',
    )
    expect(rows.map((r) => r.label)).toEqual(['To', 'Confidence', 'note'])
  })

  it('stays fast for an entity with thousands of properties', () => {
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (let i = 0; i < 5000; i++) { before[`p${i}`] = i; after[`p${i}`] = i % 2 ? i : -i }
    const t = performance.now()
    const rows = entityFieldChanges({ properties: before }, { properties: after })
    expect(rows).toHaveLength(2499) // p0 is 0 both sides
    expect(performance.now() - t).toBeLessThan(500)
  })
})

describe('fromFieldDeltas', () => {
  it('expands a properties delta per property', () => {
    const rows = fromFieldDeltas([
      { field: 'properties', before: { a: 1, b: 2 }, after: { a: 1, b: 3 } },
      { field: 'description', before: 'x', after: 'y' },
    ])
    expect(rows.map((r) => r.label)).toEqual(['Description', 'b'])
  })
})

describe('fromRevisionChanges', () => {
  it('names a history path the way the drawer does', () => {
    const rows = fromRevisionChanges([
      { path: ['properties', 'Ops/owner'], kind: 'changed', before: 'ana', after: 'bo' },
      { path: ['displayName'], kind: 'changed', before: 'a', after: 'b' },
      { path: ['version'], kind: 'changed', before: '1', after: '2' },
    ])
    expect(rows).toEqual([
      { label: 'Name', before: 'a', after: 'b', kind: 'changed' },
      { label: 'owner', folder: 'Ops', before: 'ana', after: 'bo', kind: 'changed' },
    ])
    expect(fieldChangeCounts(rows)).toEqual({ added: 0, changed: 2, removed: 0 })
  })
})
