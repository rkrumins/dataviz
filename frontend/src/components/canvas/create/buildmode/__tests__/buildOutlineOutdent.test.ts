import { describe, it, expect } from 'vitest'
import { grandparentIdOf } from '../buildOutlineOutdent'
import { makeRow, type BuildRow } from '../buildRow'

const rows = (): BuildRow[] => [
  makeRow({ id: 'a', name: 'A', parentId: null }),
  makeRow({ id: 'b', name: 'B', parentId: 'a' }),
  makeRow({ id: 'c', name: 'C', parentId: 'b' }),
]

describe('grandparentIdOf (Shift+Tab outdent target)', () => {
  it('resolves a depth-2 row to its grandparent', () => {
    expect(grandparentIdOf(rows(), 'c')).toBe('a')
  })

  it('resolves a depth-1 row to root (null)', () => {
    expect(grandparentIdOf(rows(), 'b')).toBeNull()
  })

  it('is a no-op (undefined) for an already-root row', () => {
    expect(grandparentIdOf(rows(), 'a')).toBeUndefined()
  })

  it('is a no-op (undefined) for an unknown row id', () => {
    expect(grandparentIdOf(rows(), 'missing')).toBeUndefined()
  })
})
