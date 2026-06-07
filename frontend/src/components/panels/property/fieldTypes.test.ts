import { describe, expect, it } from 'vitest'
import { inferFieldType, valueForType, coerceToType, isJsonSafe } from './fieldTypes'

describe('inferFieldType', () => {
  it('maps JSON shapes to friendly types', () => {
    expect(inferFieldType(true)).toBe('boolean')
    expect(inferFieldType(42)).toBe('number')
    expect(inferFieldType(['a', 'b'])).toBe('tags')
    expect(inferFieldType([1, { x: 1 }])).toBe('list')
    expect(inferFieldType({ a: 1 })).toBe('group')
    expect(inferFieldType('2026-05-28')).toBe('date')
    expect(inferFieldType('https://example.com/x')).toBe('url')
    expect(inferFieldType('just text')).toBe('text')
    expect(inferFieldType(null)).toBe('none')
  })
})

describe('valueForType + coerceToType emit JSON-safe values', () => {
  const types = ['text', 'number', 'boolean', 'date', 'url', 'tags', 'list', 'group', 'none'] as const
  it('valueForType is always JSON-safe', () => {
    for (const t of types) expect(isJsonSafe(valueForType(t))).toBe(true)
  })
  it('date default is an ISO YYYY-MM-DD string', () => {
    expect(valueForType('date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('coercion produces the right JSON kinds', () => {
    expect(coerceToType('5', 'number')).toBe(5)
    expect(coerceToType('a, b', 'tags')).toEqual(['a', 'b'])
    expect(coerceToType(['a', 'b'], 'text')).toBe('["a","b"]')
    expect(coerceToType('true', 'boolean')).toBe(true)
    expect(isJsonSafe(coerceToType(42, 'tags'))).toBe(true)
  })
})

describe('isJsonSafe', () => {
  it('accepts plain JSON', () => {
    expect(isJsonSafe({ a: 1, b: ['x'], c: true, d: null })).toBe(true)
  })
  it('rejects non-serializable values', () => {
    expect(isJsonSafe(undefined)).toBe(false)
    expect(isJsonSafe(NaN)).toBe(false)
    expect(isJsonSafe(new Date())).toBe(false)
    expect(isJsonSafe(() => {})).toBe(false)
    expect(isJsonSafe({ a: undefined })).toBe(false)
  })
})
