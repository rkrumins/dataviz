import { describe, it, expect } from 'vitest'
import {
  toRelationshipTypeId,
  toEntityTypeId,
  findCaseInsensitiveCollision,
} from './typeIds'

describe('toRelationshipTypeId (physical edge type → UPPER_SNAKE)', () => {
  it('turns a spaced display name into UPPER_SNAKE', () => {
    expect(toRelationshipTypeId('Flows To')).toBe('FLOWS_TO')
  })
  it('splits camelCase on the boundary', () => {
    expect(toRelationshipTypeId('flowsTo')).toBe('FLOWS_TO')
  })
  it('normalizes hyphens and mixed separators', () => {
    expect(toRelationshipTypeId('flows-to')).toBe('FLOWS_TO')
    expect(toRelationshipTypeId('flows / to')).toBe('FLOWS_TO')
  })
  it('trims and collapses redundant separators', () => {
    expect(toRelationshipTypeId('  has  ')).toBe('HAS')
    expect(toRelationshipTypeId('a!!b')).toBe('A_B')
  })
  it('is idempotent on an already-canonical id', () => {
    expect(toRelationshipTypeId('FLOWS_TO')).toBe('FLOWS_TO')
  })
  it('keeps digits', () => {
    expect(toRelationshipTypeId('v2 flow')).toBe('V2_FLOW')
  })
  it('returns empty for symbol-only / empty input', () => {
    expect(toRelationshipTypeId('')).toBe('')
    expect(toRelationshipTypeId('!!!')).toBe('')
  })
})

describe('toEntityTypeId (physical node label → PascalCase)', () => {
  it('turns a spaced display name into PascalCase', () => {
    expect(toEntityTypeId('data source')).toBe('DataSource')
  })
  it('splits camelCase then re-joins PascalCase', () => {
    expect(toEntityTypeId('dataSource')).toBe('DataSource')
  })
  it('preserves an existing acronym token', () => {
    expect(toEntityTypeId('API endpoint')).toBe('APIEndpoint')
  })
  it('handles a single word', () => {
    expect(toEntityTypeId('customer')).toBe('Customer')
  })
  it('is idempotent on an already-canonical id', () => {
    expect(toEntityTypeId('DataSource')).toBe('DataSource')
  })
  it('returns empty for empty input', () => {
    expect(toEntityTypeId('')).toBe('')
  })
})

describe('findCaseInsensitiveCollision (per-ontology, caller excludes self)', () => {
  it('flags an exact duplicate', () => {
    expect(findCaseInsensitiveCollision('FLOWS_TO', ['HAS', 'FLOWS_TO'])).toBe('FLOWS_TO')
  })
  it('flags a case-only collision (the reason opaque ids existed)', () => {
    expect(findCaseInsensitiveCollision('flows_to', ['HAS', 'FLOWS_TO'])).toBe('FLOWS_TO')
  })
  it('returns null when there is no collision — same name across ontologies is fine', () => {
    expect(findCaseInsensitiveCollision('DEPENDS_ON', ['HAS', 'FLOWS_TO'])).toBeNull()
  })
  it('returns null for an empty candidate', () => {
    expect(findCaseInsensitiveCollision('', ['HAS'])).toBeNull()
  })
})
