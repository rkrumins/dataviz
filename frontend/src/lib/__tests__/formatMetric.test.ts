import { describe, expect, it } from 'vitest'
import { compact, exact } from '../formatMetric'

describe('compact', () => {
  it('keeps small numbers whole', () => {
    expect(compact(0)).toBe('0')
    expect(compact(999)).toBe('999')
  })

  it('shows one decimal below ten thousand and whole thousands above', () => {
    expect(compact(1_500)).toBe('1.5k')
    expect(compact(12_345)).toBe('12k')
    expect(compact(999_499)).toBe('999k')
  })

  it('never says "1000k" — a thousand thousands is a million', () => {
    expect(compact(999_500)).toBe('1.0M')
    expect(compact(999_999)).toBe('1.0M')
    expect(compact(4_200_000)).toBe('4.2M')
  })

  it('renders an unknown value as a dash, not a zero', () => {
    expect(compact(null)).toBe('—')
    expect(compact(undefined)).toBe('—')
  })
})

describe('exact', () => {
  it('keeps full precision', () => {
    expect(exact(1_500)).toBe((1_500).toLocaleString())
  })
})
