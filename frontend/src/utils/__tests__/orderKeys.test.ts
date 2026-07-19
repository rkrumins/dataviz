import { describe, it, expect } from 'vitest'
import { compareOrderKeys, generateKeyBetween, generateNKeysBetween } from '../orderKeys'

describe('generateKeyBetween', () => {
  it('returns the canonical first key for (null, null)', () => {
    expect(generateKeyBetween(null, null)).toBe('a0')
  })

  it('generates strictly-between keys', () => {
    const a = generateKeyBetween(null, null)
    const b = generateKeyBetween(a, null)
    const mid = generateKeyBetween(a, b)
    expect(a < mid && mid < b).toBe(true)
  })

  it('appends monotonically', () => {
    let key = generateKeyBetween(null, null)
    for (let i = 0; i < 100; i++) {
      const next = generateKeyBetween(key, null)
      expect(next > key).toBe(true)
      key = next
    }
  })

  it('prepends monotonically', () => {
    let key = generateKeyBetween(null, null)
    for (let i = 0; i < 100; i++) {
      const prev = generateKeyBetween(null, key)
      expect(prev < key).toBe(true)
      key = prev
    }
  })

  it('survives repeated midpoint insertion (front-biased stress)', () => {
    let a = generateKeyBetween(null, null)
    let b = generateKeyBetween(a, null)
    for (let i = 0; i < 1000; i++) {
      const mid = generateKeyBetween(a, b)
      expect(a < mid && mid < b).toBe(true)
      b = mid
    }
  })

  it('survives repeated midpoint insertion (back-biased stress)', () => {
    let a = generateKeyBetween(null, null)
    const b = generateKeyBetween(a, null)
    let lower = a
    for (let i = 0; i < 1000; i++) {
      const mid = generateKeyBetween(lower, b)
      expect(lower < mid && mid < b).toBe(true)
      lower = mid
    }
  })

  it('rejects a >= b', () => {
    expect(() => generateKeyBetween('a1', 'a1')).toThrow()
    expect(() => generateKeyBetween('a2', 'a1')).toThrow()
  })

  it('rejects malformed keys', () => {
    expect(() => generateKeyBetween('', null)).toThrow()
    expect(() => generateKeyBetween('a10', null)).toThrow() // trailing-zero fraction
    expect(() => generateKeyBetween('!', null)).toThrow()
  })
})

describe('generateNKeysBetween', () => {
  it('returns n strictly increasing keys for every bound combination', () => {
    const cases: Array<[string | null, string | null]> = [
      [null, null],
      ['a0', null],
      [null, 'a0'],
      ['a0', 'a1'],
    ]
    for (const [a, b] of cases) {
      const keys = generateNKeysBetween(a, b, 25)
      expect(keys).toHaveLength(25)
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i - 1] < keys[i]).toBe(true)
      }
      if (a !== null) expect(a < keys[0]).toBe(true)
      if (b !== null) expect(keys[keys.length - 1] < b).toBe(true)
    }
  })

  it('handles n = 0 and n = 1', () => {
    expect(generateNKeysBetween(null, null, 0)).toEqual([])
    expect(generateNKeysBetween(null, null, 1)).toEqual(['a0'])
  })
})

describe('compareOrderKeys', () => {
  it('sorts ordinally, not by locale', () => {
    const keys = generateNKeysBetween(null, null, 50)
    const shuffled = [...keys].reverse()
    expect(shuffled.sort(compareOrderKeys)).toEqual(keys)
  })
})
