import { describe, it, expect } from 'vitest'
import { makeRow, reindexDepths, insertChildOf, insertSiblingAfter, outdent, removeRow, childrenOf, type BuildRow } from '../buildRow'

const rows = (): BuildRow[] => [
  makeRow({ id: 'a', name: 'A', parentId: null }),
  makeRow({ id: 'b', name: 'B', parentId: 'a' }),
  makeRow({ id: 'c', name: 'C', parentId: 'b' }),
]
describe('buildRow', () => {
  it('reindexDepths derives depth from the parent chain', () => {
    const r = reindexDepths(rows())
    expect(r.map(x => x.depth)).toEqual([0, 1, 2])
  })
  it('insertChildOf adds a child and depth reindexes', () => {
    const r = reindexDepths(insertChildOf(rows(), 'a', makeRow({ id: 'd', name: 'D' })))
    expect(r.find(x => x.id === 'd')!.parentId).toBe('a')
    expect(r.find(x => x.id === 'd')!.depth).toBe(1)
  })
  it('insertSiblingAfter shares the parent of the anchor', () => {
    const r = insertSiblingAfter(rows(), 'b', makeRow({ id: 'd', name: 'D' }))
    expect(r.find(x => x.id === 'd')!.parentId).toBe('a')
  })
  it('outdent reparents to the grandparent', () => {
    const r = reindexDepths(outdent(rows(), 'c'))
    expect(r.find(x => x.id === 'c')!.parentId).toBe('a')
    expect(r.find(x => x.id === 'c')!.depth).toBe(1)
  })
  it('removeRow removes the row and its descendants', () => {
    const r = removeRow(rows(), 'b')
    expect(r.map(x => x.id)).toEqual(['a'])
  })
  it('childrenOf returns direct children in order', () => {
    expect(childrenOf(rows(), 'a').map(x => x.id)).toEqual(['b'])
    expect(childrenOf(rows(), null).map(x => x.id)).toEqual(['a'])
  })
})
