import { describe, it, expect } from 'vitest'
import { makeRow, reindexDepths, insertChildOf, insertSiblingAfter, outdent, removeRow, childrenOf, duplicateSubtree, type BuildRow } from '../buildRow'

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
  it('insertChildOf places the new child AFTER the parent\'s full subtree (valid outline order)', () => {
    // d is a child of a; must land after b AND b's child c, not between b and c
    const r = insertChildOf(rows(), 'a', makeRow({ id: 'd', name: 'D' }))
    expect(r.map(x => x.id)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('insertSiblingAfter places the new sibling AFTER the anchor\'s full subtree', () => {
    // d is a sibling of b (parent a); must land after b's subtree [b, c]
    const r = insertSiblingAfter(rows(), 'b', makeRow({ id: 'd', name: 'D' }))
    expect(r.map(x => x.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(r.find(x => x.id === 'd')!.parentId).toBe('a')
  })
  it('duplicateSubtree clones a 3-level subtree with fresh ids, re-threaded parentIds, inserted after the original subtree', () => {
    const base: BuildRow[] = [
      ...rows(), // a (root) -> b (parent a) -> c (parent b)
      makeRow({ id: 'd', name: 'D', parentId: null }), // sibling AFTER a's whole subtree
    ]
    let n = 0
    const mintId = () => `clone-${n++}`
    const result = duplicateSubtree(base, 'a', mintId)

    // clones land right after a's whole subtree [a, b, c], before d — not at the end
    expect(result.map(r => r.id)).toEqual(['a', 'b', 'c', 'clone-0', 'clone-1', 'clone-2', 'd'])

    const cloneA = result.find(r => r.id === 'clone-0')!
    const cloneB = result.find(r => r.id === 'clone-1')!
    const cloneC = result.find(r => r.id === 'clone-2')!
    expect(cloneA.parentId).toBeNull() // root clone is a SIBLING of the original (same parentId)
    expect(cloneB.parentId).toBe('clone-0') // re-threaded to the cloned parent, not the original
    expect(cloneC.parentId).toBe('clone-1')
    expect(cloneA.name).toBe('A')
    expect(cloneB.name).toBe('B')
    expect(cloneC.name).toBe('C')

    // originals untouched
    expect(base.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
    // every id (original + clone) is distinct
    expect(new Set(result.map(r => r.id)).size).toBe(result.length)
  })

  it('duplicateSubtree returns the rows unchanged when the id does not exist', () => {
    expect(duplicateSubtree(rows(), 'missing', () => 'x')).toEqual(rows())
  })

  it('reindexDepths does not hang on a parentId cycle', () => {
    const cyclic: BuildRow[] = [
      makeRow({ id: 'a', name: 'A', parentId: 'b' }),
      makeRow({ id: 'b', name: 'B', parentId: 'a' }),
    ]
    const r = reindexDepths(cyclic) // must terminate
    expect(r).toHaveLength(2)
    expect(r.every(x => Number.isFinite(x.depth))).toBe(true)
  })
})
