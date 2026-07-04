import { describe, it, expect } from 'vitest'
import { computeRangeIds, computeDownIds, descendantIds } from '../buildGridSelection'
import { makeRow, type BuildRow } from '../buildRow'

const rows = (): BuildRow[] => [
  makeRow({ id: 'a', name: 'A', parentId: null }),
  makeRow({ id: 'b', name: 'B', parentId: 'a' }),
  makeRow({ id: 'c', name: 'C', parentId: 'b' }),
  makeRow({ id: 'd', name: 'D', parentId: 'a' }),
  makeRow({ id: 'e', name: 'E', parentId: null }),
]

describe('computeRangeIds (shift-click range selection)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']

  it('selects forward from anchor to target', () => {
    expect(computeRangeIds(ids, 'b', 'd')).toEqual(['b', 'c', 'd'])
  })

  it('selects backward from anchor to target', () => {
    expect(computeRangeIds(ids, 'd', 'b')).toEqual(['b', 'c', 'd'])
  })

  it('collapses to a single id when anchor === target', () => {
    expect(computeRangeIds(ids, 'c', 'c')).toEqual(['c'])
  })

  it('falls back to just the target when the anchor is missing', () => {
    expect(computeRangeIds(ids, 'missing', 'c')).toEqual(['c'])
  })

  it('falls back to just the target when the target is missing', () => {
    expect(computeRangeIds(ids, 'a', 'missing')).toEqual(['missing'])
  })
})

describe('computeDownIds (paste-into-cell alignment)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']

  it('returns count ids starting at startId', () => {
    expect(computeDownIds(ids, 'b', 3)).toEqual(['b', 'c', 'd'])
  })

  it('clamps at the end of the list', () => {
    expect(computeDownIds(ids, 'd', 10)).toEqual(['d', 'e'])
  })

  it('returns an empty array when startId is missing', () => {
    expect(computeDownIds(ids, 'missing', 3)).toEqual([])
  })

  it('returns an empty array for a zero count', () => {
    expect(computeDownIds(ids, 'a', 0)).toEqual([])
  })
})

describe('descendantIds (Parent typeahead cycle guard)', () => {
  it('finds children and grandchildren, not siblings or the row itself', () => {
    expect(descendantIds(rows(), 'a')).toEqual(new Set(['b', 'c', 'd']))
  })

  it('finds only direct descendants of a leaf-ward node', () => {
    expect(descendantIds(rows(), 'b')).toEqual(new Set(['c']))
  })

  it('returns an empty set for a leaf row', () => {
    expect(descendantIds(rows(), 'c')).toEqual(new Set())
  })

  it('returns an empty set for a root with no children', () => {
    expect(descendantIds(rows(), 'e')).toEqual(new Set())
  })
})
