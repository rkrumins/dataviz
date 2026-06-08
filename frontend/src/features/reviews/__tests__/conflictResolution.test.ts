import { describe, it, expect } from 'vitest'
import {
  setIn, groupByEntity, buildResolutions, normalizeConflict, conflictKey, type Conflict,
} from '../conflictResolution'

describe('setIn', () => {
  it('sets a top-level field immutably', () => {
    const src = { a: 1, b: 2 }
    const out = setIn(src, ['b'], 9)
    expect(out).toEqual({ a: 1, b: 9 })
    expect(src).toEqual({ a: 1, b: 2 }) // original untouched
  })

  it('sets a nested field, creating missing parents', () => {
    expect(setIn({ meta: { x: 1 } }, ['meta', 'y'], 2)).toEqual({ meta: { x: 1, y: 2 } })
    expect(setIn({}, ['a', 'b'], 'v')).toEqual({ a: { b: 'v' } })
  })

  it('sets an array index', () => {
    expect(setIn({ tags: ['a', 'b'] }, ['tags', 1], 'z')).toEqual({ tags: ['a', 'z'] })
  })

  it('empty path replaces the whole entity', () => {
    expect(setIn({ a: 1 }, [], { b: 2 })).toEqual({ b: 2 })
  })
})

describe('buildResolutions', () => {
  const seeds = { n1: { displayName: 'merged', kept: true }, n2: { displayName: 'x' } }

  it('overlays the picked side onto the merged seed (default = ours)', () => {
    const conflicts: Conflict[] = [{ entity_id: 'n1', path: ['displayName'], base: 'b', ours: 'OURS', theirs: 'THEIRS' }]
    const byEntity = groupByEntity(conflicts)
    // default pick is "ours"
    const def = buildResolutions(byEntity, {}, {}, seeds)
    expect(def.n1).toEqual({ displayName: 'OURS', kept: true }) // non-conflicting field preserved from seed

    // explicit "theirs"
    const picks = { [conflictKey(conflicts[0])]: 'theirs' as const }
    expect(buildResolutions(byEntity, picks, {}, seeds).n1).toEqual({ displayName: 'THEIRS', kept: true })
  })

  it('applies multiple field picks on one entity', () => {
    const conflicts: Conflict[] = [
      { entity_id: 'n1', path: ['displayName'], ours: 'O', theirs: 'T' },
      { entity_id: 'n1', path: ['meta', 'owner'], ours: 'alice', theirs: 'bob' },
    ]
    const byEntity = groupByEntity(conflicts)
    const picks = { [conflictKey(conflicts[0])]: 'ours' as const, [conflictKey(conflicts[1])]: 'theirs' as const }
    expect(buildResolutions(byEntity, picks, {}, seeds).n1).toEqual({
      displayName: 'O', kept: true, meta: { owner: 'bob' },
    })
  })

  it('resolves a deleted entity to null (skips field picks)', () => {
    const conflicts: Conflict[] = [{ entity_id: 'n1', path: ['displayName'], ours: 'O', theirs: 'T' }]
    const out = buildResolutions(groupByEntity(conflicts), {}, { n1: true }, seeds)
    expect(out.n1).toBeNull()
  })

  it('seeds from {} when no merged payload is available', () => {
    const conflicts: Conflict[] = [{ entity_id: 'ghost', path: ['name'], ours: 'O', theirs: 'T' }]
    expect(buildResolutions(groupByEntity(conflicts), {}, {}, {}).ghost).toEqual({ name: 'O' })
  })
})

describe('normalizeConflict', () => {
  it('reads snake_case and camelCase entity ids', () => {
    expect(normalizeConflict({ entity_id: 'a', path: ['x'] }).entity_id).toBe('a')
    expect(normalizeConflict({ entityId: 'b', path: [] }).entity_id).toBe('b')
  })
})
