/**
 * The timeline's bars and the calendar's heat have to land on the same days the
 * date filter selects — the reader's local days — although the server can only
 * count in UTC. Expectations are built with local dates so this holds in any zone.
 */
import { describe, expect, it } from 'vitest'
import { daysBetween, foldHistogram, grainFor } from '../foldHistogram'
import { localDay } from '../dateFilter'

/** The UTC hour bucket a local moment falls in, as the server would spell it. */
function hourBucket(local: Date): string {
  return local.toISOString().slice(0, 13)
}

describe('foldHistogram', () => {
  it('puts each bucket on the local day it starts in', () => {
    const lateEvening = new Date(2026, 9, 11, 23, 15)
    const morning = new Date(2026, 9, 12, 9, 0)
    const days = foldHistogram([
      { t: hourBucket(lateEvening), n: 2 },
      { t: hourBucket(morning), n: 3 },
      { t: hourBucket(new Date(2026, 9, 12, 10, 0)), n: 1 },
    ])
    expect(days.get(localDay(lateEvening))).toBe(2)
    expect(days.get(localDay(morning))).toBe(4)
  })

  it('reads ten-minute buckets', () => {
    const d = new Date(Date.UTC(2026, 9, 12, 14, 30))
    expect(foldHistogram([{ t: '2026-10-12T14:3', n: 5 }]).get(localDay(d))).toBe(5)
  })

  it('skips a bucket it cannot read rather than misplacing it', () => {
    expect(foldHistogram([{ t: 'garbage', n: 9 }]).size).toBe(0)
  })
})

describe('grainFor', () => {
  it('uses hours for whole-hour zones and ten minutes otherwise', () => {
    const at = (offset: number) => ({ getTimezoneOffset: () => offset }) as Date
    expect(grainFor(at(0))).toBe('hour')
    expect(grainFor(at(-120))).toBe('hour')
    expect(grainFor(at(-330))).toBe('10min') // India, +5:30
  })
})

describe('daysBetween', () => {
  it('lists every day, both ends included, across a month end', () => {
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
  })
})
