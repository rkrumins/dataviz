import { describe, expect, it } from 'vitest'
import { treeLeafToChange } from '../changeTreeModel'
import type { DiffTreeNode } from '@/services/versioningApiService'

const leaf = (over: Partial<DiffTreeNode>): DiffTreeNode => ({
  key: 'e1',
  kind: 'leaf',
  label: 'col',
  entityType: 'Column',
  status: 'modified',
  counts: { added: 0, modified: 1, removed: 0 },
  childTotal: 0,
  deleted: false,
  ...over,
})

const origin = { source: 'branch', branchId: 'br1' } as const

describe('treeLeafToChange', () => {
  it('maps an added leaf (no before, after payload, no field deltas)', () => {
    const c = treeLeafToChange(leaf({ status: 'added', before: null, after: { displayName: 'new' } }), origin)
    expect(c.status).toBe('added')
    expect(c.after).toEqual({ displayName: 'new' })
    expect(c.fields).toBeUndefined()
    expect(c.origin).toEqual(origin)
  })

  it('maps a modified leaf to field-level deltas', () => {
    const c = treeLeafToChange(
      leaf({ status: 'modified', before: { displayName: 'a' }, after: { displayName: 'b' } }),
      origin,
    )
    expect(c.status).toBe('modified')
    expect(c.fields).toEqual([{ field: 'displayName', before: 'a', after: 'b' }])
  })

  it('maps a removed leaf (before payload retained)', () => {
    const c = treeLeafToChange(leaf({ status: 'removed', before: { displayName: 'gone' }, after: null }), origin)
    expect(c.status).toBe('removed')
    expect(c.before).toEqual({ displayName: 'gone' })
  })

  it('infers edge kind from endpoint fields', () => {
    const c = treeLeafToChange(
      leaf({ after: { edgeType: 'FLOWS', sourceEntityId: 's', targetEntityId: 't' } }),
      origin,
    )
    expect(c.kind).toBe('edge')
  })

  it('treats an unchanged/structural status as modified for the detail view', () => {
    const c = treeLeafToChange(leaf({ status: 'unchanged' }), origin)
    expect(c.status).toBe('modified')
  })
})
