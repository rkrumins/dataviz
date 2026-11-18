/**
 * A moment is stored one way — UTC, `…Z`, as the server stores it — and picked in the reader's
 * time: read into the picker and put back, it is the same text; no zone reads as UTC; two writings
 * of one moment are the same moment.
 */
import { describe, expect, it } from 'vitest'
import { canonicalInstant, fromLocalInput, isIsoInstant, nowInstant, sameInstant, toLocalInput } from '../dateTime'
import { detectValue } from '../composerModel'
import { coerceToType, inferFieldType } from '../fieldTypes'

describe('dateTime', () => {
  it('knows a moment from a date and from text', () => {
    for (const v of ['2026-11-18T05:42:00Z', '2026-11-18T05:42Z', '2026-11-18 05:42:00', '2026-11-18T05:42:00.123+02:00', '2026-11-18T05:42:00+0530']) {
      expect(isIsoInstant(v)).toBe(true)
    }
    for (const v of ['2026-11-18', 'tomorrow', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', 42, null]) expect(isIsoInstant(v)).toBe(false)
  })

  it('stores one form, as the server does', () => {
    expect(canonicalInstant('2026-11-18 07:42:00+02:00')).toBe('2026-11-18T05:42:00Z')
    expect(canonicalInstant('2026-11-18T05:42')).toBe('2026-11-18T05:42:00Z')          // no zone: UTC
    expect(canonicalInstant('2026-11-18T05:42:07.120+00:00')).toBe('2026-11-18T05:42:07.120Z')
    expect(canonicalInstant('2026-11-18T05:42:07.000Z')).toBe('2026-11-18T05:42:07Z')
    expect(canonicalInstant('2026-11-18T00:30:00-0130')).toBe('2026-11-18T02:00:00Z')
    expect(canonicalInstant('Finance')).toBe('Finance')
    expect(nowInstant()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('round-trips through the picker unchanged', () => {
    for (const v of ['2026-11-18T05:42:07Z', '2026-11-18T05:42:07.120Z', '2026-01-01T00:00:00Z']) {
      expect(fromLocalInput(toLocalInput(v))).toBe(v)
    }
    // Another writing comes back in the stored form.
    expect(fromLocalInput(toLocalInput('2026-11-18T23:30:00+02:00'))).toBe('2026-11-18T21:30:00Z')
    expect(fromLocalInput('not a time')).toBeNull()
  })

  it('an edit in the reader’s time is stored in UTC', () => {
    const later = new Date(Date.parse('2026-11-18T05:42:00Z') + 3600_000)
    const pick = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}T${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`
    expect(fromLocalInput(pick)).toBe('2026-11-18T06:42:00Z')
  })

  it('says two writings of one moment are the same', () => {
    expect(sameInstant('2026-11-18T05:42:00Z', '2026-11-18 05:42:00.000+00:00')).toBe(true)
    expect(sameInstant('2026-11-18T07:42:00+02:00', '2026-11-18T05:42')).toBe(true)
    expect(sameInstant('2026-11-18T05:42:00Z', '2026-11-18T05:43:00Z')).toBe(false)
  })

  it('a moment typed or retyped is stored in the one form', () => {
    expect(detectValue('2026-11-18 07:42+02:00')).toEqual({ type: 'datetime', value: '2026-11-18T05:42:00Z' })
    expect(inferFieldType('2026-11-18T05:42:00Z')).toBe('datetime')
    expect(inferFieldType('2026-11-18')).toBe('date')
    expect(coerceToType('2026-11-18T07:42:00+02:00', 'datetime')).toBe('2026-11-18T05:42:00Z')
    expect(coerceToType(Date.UTC(2026, 10, 18, 5, 42), 'datetime')).toBe('2026-11-18T05:42:00Z')
  })
})
