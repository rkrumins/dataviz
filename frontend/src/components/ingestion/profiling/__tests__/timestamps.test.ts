/**
 * Timestamps — the rules that stop a label being misread.
 */
import { describe, expect, it } from 'vitest'

import { axisLabels, formatBucket } from '../shared'

describe('formatBucket', () => {
    it('renders an hour as a clock, never as a bare number', () => {
        // "23 Aug, 21" reads as "23 August 2021" long before it reads as nine
        // in the evening: a bare number after a comma is a year to almost
        // everyone. An explicit 21:00 cannot be misread.
        const label = formatBucket('2026-08-23T21')
        expect(label).toMatch(/21:00/)
        expect(label).not.toMatch(/,\s*21$/)
    })

    it('keeps a day bucket a day, with no invented time', () => {
        // A label must never claim a precision the data does not have.
        expect(formatBucket('2026-08-23')).not.toMatch(/\d{2}:\d{2}/)
        expect(formatBucket('2026-08-23')).toMatch(/23/)
    })

    it('carries minutes for a raw observation', () => {
        expect(formatBucket('2026-08-23T21:32:03.923007+00:00')).toMatch(/21:32/)
    })

    it('reads instants in UTC, because the buckets are UTC', () => {
        // A day bucket IS a UTC day. Rendering its hours in the reader's zone
        // would put an observation on a different date from the bucket that
        // contains it.
        expect(formatBucket('2026-08-23T23')).toMatch(/23:00/)
        expect(formatBucket('2026-08-23T23')).toMatch(/23 Aug|Aug 23/)
    })

    it('returns an unparseable key rather than throwing', () => {
        expect(formatBucket('not-a-date')).toBe('not-a-date')
        expect(formatBucket('')).toBe('')
    })
})

describe('axisLabels', () => {
    it('carries the date only where it changes', () => {
        // Six ticks over two days printed the date six times. Repetition that
        // dense stops being information and starts being texture.
        const labels = axisLabels([
            '2026-08-23T21', '2026-08-23T23',
            '2026-08-24T01', '2026-08-24T07', '2026-08-24T09',
        ])
        expect(labels[0]).toMatch(/Aug/)
        expect(labels[1]).toBe('23:00')
        expect(labels[2]).toMatch(/Aug/)
        expect(labels[3]).toBe('07:00')
        expect(labels[4]).toBe('09:00')
    })

    it('makes the day boundary the only tick carrying a date', () => {
        const labels = axisLabels([
            '2026-08-23T22', '2026-08-23T23', '2026-08-24T00', '2026-08-24T01',
        ])
        const dated = labels.filter((l) => /Aug/.test(l))
        expect(dated).toHaveLength(2)
        expect(labels[2]).toMatch(/Aug/)
    })

    it('leaves day buckets as dates — there is nothing to elide', () => {
        const labels = axisLabels(['2026-08-22', '2026-08-23', '2026-08-24'])
        expect(labels.every((l) => /Aug/.test(l))).toBe(true)
        expect(labels.every((l) => !/\d{2}:\d{2}/.test(l))).toBe(true)
    })

    it('is index-aligned with its input', () => {
        // The chart pairs labels to points by index; a filtered array would
        // silently shift every tick.
        const buckets = ['2026-08-23T21', 'rubbish', '2026-08-24T01']
        expect(axisLabels(buckets)).toHaveLength(3)
        expect(axisLabels(buckets)[1]).toBe('rubbish')
    })
})

describe('naming the zone', () => {
    it('marks an isolated reading with UTC', async () => {
        // A tooltip or an alert timestamp gets copied into a ticket and
        // compared against another system's log. That reading has to survive
        // leaving the page.
        const { formatBucketUtc, formatInstant } = await import('../shared')
        expect(formatBucketUtc('2026-08-23T21')).toMatch(/21:00 UTC$/)
        expect(formatInstant('2026-08-23T21:32:03+00:00')).toMatch(/21:32 UTC$/)
    })

    it('leaves list rows unmarked, because their header carries it', async () => {
        // Forty consecutive rows ending in "UTC" is texture, not information.
        const { formatBucket } = await import('../shared')
        expect(formatBucket('2026-08-23T21')).not.toMatch(/UTC/)
    })

    it('renders an instant in UTC regardless of the reader zone', async () => {
        // The leak this closes: alert timestamps went through
        // toLocaleString(), so the same event read 22:32 in the findings band
        // and 21:32 in the ledger one card below.
        const { formatInstant } = await import('../shared')
        expect(formatInstant('2026-08-23T21:32:00Z')).toMatch(/21:32/)
    })

    it('degrades rather than throwing on a bad instant', async () => {
        const { formatInstant, formatDay } = await import('../shared')
        expect(formatInstant('rubbish')).toBe('rubbish')
        expect(formatInstant(null)).toBe('')
        expect(formatDay(undefined)).toBe('')
    })
})
