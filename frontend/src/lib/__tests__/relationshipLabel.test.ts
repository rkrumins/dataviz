import { describe, it, expect } from 'vitest'
import { relationshipLabel, parentPlacementPhrase } from '../relationshipLabel'

describe('relationshipLabel', () => {
  it('humanizes camelCase ids', () => {
    expect(relationshipLabel('partOf')).toBe('Part of')
    expect(relationshipLabel('belongsTo')).toBe('Belongs to')
  })

  it('humanizes snake/kebab and SHOUTY ids', () => {
    expect(relationshipLabel('BELONGS_TO')).toBe('Belongs to')
    expect(relationshipLabel('is-part-of')).toBe('Is part of')
    expect(relationshipLabel('CONTAINS')).toBe('Contains')
  })
})

describe('parentPlacementPhrase', () => {
  it('reads contains/partOf from the child as "Part of"', () => {
    expect(parentPlacementPhrase('CONTAINS')).toBe('Part of')
    expect(parentPlacementPhrase('partOf')).toBe('Part of')
  })

  it('keeps "belongs to" distinct', () => {
    expect(parentPlacementPhrase('BELONGS_TO')).toBe('Belongs to')
    expect(parentPlacementPhrase('belongsTo')).toBe('Belongs to')
  })

  it('defaults to "Part of" for unknown/empty', () => {
    expect(parentPlacementPhrase(undefined)).toBe('Part of')
    expect(parentPlacementPhrase('')).toBe('Part of')
  })
})
