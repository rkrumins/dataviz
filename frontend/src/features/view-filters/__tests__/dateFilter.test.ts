/**
 * Date rules are what a bookmark or saved filter keeps, so their meaning has to be
 * exact: calendar days in the reader's own zone, ends included, and the same rule
 * resolving the same way on any machine. Expected instants are built with LOCAL
 * `new Date(y, m, d)` so these pass in whatever time zone the suite runs in.
 */
import { describe, expect, it } from 'vitest'
import {
  addDays, describeRule, isValidRule, localDay, rangeRule, ruleBounds, ruleDays, spanLength,
} from '../dateFilter'

const TODAY = '2026-10-12' // a Monday

describe('ruleDays — which calendar days a rule covers', () => {
  it.each([
    ['today', '2026-10-12', '2026-10-12'],
    ['yesterday', '2026-10-11', '2026-10-11'],
    ['7d', '2026-10-06', '2026-10-12'],
    ['1d', '2026-10-12', '2026-10-12'],
    ['this-month', '2026-10-01', '2026-10-12'],
    ['last-month', '2026-09-01', '2026-09-30'],
    ['this-quarter', '2026-10-01', '2026-10-12'],
    ['last-quarter', '2026-07-01', '2026-09-30'],
    ['this-year', '2026-01-01', '2026-10-12'],
    ['2025', '2025-01-01', '2025-12-31'],
    ['2026-02', '2026-02-01', '2026-02-28'],
    ['2024-02', '2024-02-01', '2024-02-29'],
    ['2026-09-15', '2026-09-15', '2026-09-15'],
    ['2026-09-01..2026-09-15', '2026-09-01', '2026-09-15'],
  ])('%s → %s … %s', (rule, from, to) => {
    expect(ruleDays(rule, TODAY)).toEqual({ from, to })
  })

  it('wraps "last month" and "last quarter" back across a new year', () => {
    expect(ruleDays('last-month', '2026-01-20')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(ruleDays('last-quarter', '2026-02-03')).toEqual({ from: '2025-10-01', to: '2025-12-31' })
  })

  it('leaves one side of a range open', () => {
    expect(ruleDays('2026-09-01..', TODAY)).toEqual({ from: '2026-09-01', to: null })
    expect(ruleDays('..2026-09-15', TODAY)).toEqual({ from: null, to: '2026-09-15' })
  })

  it.each(['', 'soon', '0d', '3651d', '2026-13', '2026-02-30', '2026-09-15..2026-09-01', '..', '7days'])(
    'rejects %j',
    rule => {
      expect(ruleDays(rule, TODAY)).toBeNull()
      expect(isValidRule(rule)).toBe(false)
    },
  )
})

describe('ruleBounds — the instants sent to the server', () => {
  it('runs from local midnight of the first day to local midnight after the last', () => {
    expect(ruleBounds('7d', TODAY)).toEqual({
      after: new Date(2026, 9, 6).toISOString(),
      before: new Date(2026, 9, 13).toISOString(),
    })
  })

  it('includes the end day of a range', () => {
    expect(ruleBounds('2026-09-01..2026-09-15', TODAY)).toEqual({
      after: new Date(2026, 8, 1).toISOString(),
      before: new Date(2026, 8, 16).toISOString(),
    })
  })

  it('leaves an open side unbounded', () => {
    expect(ruleBounds('..2026-09-15', TODAY)).toEqual({ after: null, before: new Date(2026, 8, 16).toISOString() })
  })

  it('is stable for the whole day — the query key must not change on every render', () => {
    expect(ruleBounds('30d', TODAY)).toEqual(ruleBounds('30d', TODAY))
  })
})

describe('calendar arithmetic', () => {
  it('shifts days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('counts both ends of a span', () => {
    expect(spanLength('2026-09-01', '2026-09-15')).toBe(15)
    expect(spanLength('2026-09-01', '2026-09-01')).toBe(1)
  })

  it('reads a date as the local calendar day', () => {
    expect(localDay(new Date(2026, 9, 12, 23, 59))).toBe('2026-10-12')
    expect(localDay(new Date(2026, 9, 13, 0, 1))).toBe('2026-10-13')
  })

  it('writes a one-day range as that day', () => {
    expect(rangeRule('2026-09-03', '2026-09-03')).toBe('2026-09-03')
    expect(rangeRule('2026-09-03', '2026-09-09')).toBe('2026-09-03..2026-09-09')
  })
})

describe('describeRule — the words on the trigger and the chips', () => {
  it.each([
    ['today', 'Today'],
    ['7d', 'Past 7 days'],
    ['14d', 'Past 14 days'],
    ['this-month', 'This month'],
    ['last-quarter', 'Last quarter'],
    ['2025', '2025'],
  ])('%s → %s', (rule, words) => {
    expect(describeRule(rule, TODAY)).toBe(words)
  })

  it('names the ends of a range, and an open side', () => {
    // Day-month order follows the reader's locale, so match the parts, not the order.
    const words = describeRule('2026-09-01..2026-09-15', TODAY)
    expect(words).toMatch(/^[^→]*\b1\b[^→]*Sep[^→]*→|^[^→]*Sep[^→]*\b1\b[^→]*→/)
    expect(words).toMatch(/→.*\b15\b/)
    expect(describeRule('2026-09-01..', TODAY)).toMatch(/^Since /)
    expect(describeRule('..2026-09-15', TODAY)).toMatch(/^Until /)
  })

  it('adds the year only when it isn\'t this one', () => {
    expect(describeRule('2025-12-24', TODAY)).toMatch(/2025/)
    expect(describeRule('2026-09-24', TODAY)).not.toMatch(/2026/)
  })
})
