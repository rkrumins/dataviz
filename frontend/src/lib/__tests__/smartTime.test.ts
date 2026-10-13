/**
 * Times as a reader wants them: how recently while that is the question,
 * then the clock time, the weekday, the date — and every instant spelled out
 * exactly. Built from local-time dates so the assertions hold in any zone.
 */
import { describe, expect, it } from 'vitest'

import { calendarTime, clockTime, describeInstant, formatSpan, relativeLong, smartTime } from '@/lib/smartTime'

const MIN = 60_000
const HOUR = 60 * MIN
const clock = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d)

// Mid-afternoon on a Wednesday, local time: room for "earlier today".
const NOW = new Date(2026, 9, 14, 15, 30, 0).getTime()

describe('smartTime', () => {
    it('says how recently while that is the question', () => {
        expect(smartTime(new Date(NOW - 10_000), NOW)).toBe('just now')
        expect(smartTime(new Date(NOW - 12 * MIN), NOW)).toBe('12 min ago')
        expect(smartTime(new Date(NOW - 3 * HOUR - 5 * MIN), NOW)).toBe('3 h ago')
    })

    it('gives the clock time for today and yesterday, the weekday this week', () => {
        const earlier = new Date(2026, 9, 14, 7, 5)
        expect(smartTime(earlier, NOW)).toBe(`Today ${clock(earlier)}`)
        const yesterday = new Date(2026, 9, 13, 18, 2)
        expect(smartTime(yesterday, NOW)).toBe(`Yesterday ${clock(yesterday)}`)
        const monday = new Date(2026, 9, 12, 9, 41)
        const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(monday)
        expect(smartTime(monday, NOW)).toBe(`${weekday} ${clock(monday)}`)
    })

    it('gives the date once older, with the year only when it is not this one', () => {
        const lastMonth = new Date(2026, 8, 2, 12, 0)
        expect(smartTime(lastMonth, NOW))
            .toBe(new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(lastMonth))
        const lastYear = new Date(2025, 9, 2, 12, 0)
        expect(smartTime(lastYear, NOW)).toBe(
            new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(lastYear),
        )
    })

    it('reads a clock slightly ahead of ours as now, and the near future as such', () => {
        expect(smartTime(new Date(NOW + 20_000), NOW)).toBe('just now')
        expect(smartTime(new Date(NOW + 20 * MIN), NOW)).toBe('in 20 min')
    })
})

describe('clockTime', () => {
    it('is relative within the hour, and the clock time alone after', () => {
        expect(clockTime(new Date(NOW - 5 * MIN), NOW)).toBe('5 min ago')
        const morning = new Date(2026, 9, 14, 9, 41)
        expect(clockTime(morning, NOW)).toBe(clock(morning))
    })
})

describe('calendarTime', () => {
    it('is never relative: the day and the clock time, for a sequence of moments', () => {
        const recent = new Date(NOW - 12 * MIN)
        expect(calendarTime(recent, NOW)).toBe(`Today ${clock(recent)}`)
        const yesterday = new Date(2026, 9, 13, 18, 2)
        expect(calendarTime(yesterday, NOW)).toBe(`Yesterday ${clock(yesterday)}`)
        const lastMonth = new Date(2026, 8, 2, 12, 0)
        const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(lastMonth)
        expect(calendarTime(lastMonth, NOW)).toBe(`${date} ${clock(lastMonth)}`)
    })
})

describe('relativeLong', () => {
    it('words the distance at the scale that fits it', () => {
        expect(relativeLong(new Date(NOW - 10_000), NOW)).toBe('just now')
        const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
        expect(relativeLong(new Date(NOW - 12 * MIN), NOW)).toBe(rtf.format(-12, 'minute'))
        expect(relativeLong(new Date(NOW - 5 * HOUR), NOW)).toBe(rtf.format(-5, 'hour'))
        expect(relativeLong(new Date(NOW - 3 * 24 * HOUR), NOW)).toBe(rtf.format(-3, 'day'))
        expect(relativeLong(new Date(NOW + 2 * HOUR), NOW)).toBe(rtf.format(2, 'hour'))
    })
})

describe('describeInstant', () => {
    it('spells the instant out in UTC and ISO, whatever the reader’s zone', () => {
        const at = new Date('2026-10-12T08:41:07.000Z')
        const instant = describeInstant(at)
        expect(instant.iso).toBe('2026-10-12T08:41:07.000Z')
        expect(instant.utcTime).toBe('08:41:07 UTC')
        expect(instant.offset).toMatch(/^UTC[+−]\d{2}:\d{2}$/)
        expect(instant.date).toContain('2026')
    })
})

describe('formatSpan', () => {
    it('is compact and exact enough at every scale', () => {
        expect(formatSpan(400)).toBe('<1 s')
        expect(formatSpan(45_000)).toBe('45 s')
        expect(formatSpan(3 * MIN + 12_000)).toBe('3 min 12 s')
        expect(formatSpan(4 * MIN)).toBe('4 min')
        expect(formatSpan(2 * HOUR + 5 * MIN)).toBe('2 h 05 min')
        expect(formatSpan(3 * 24 * HOUR + 4 * HOUR)).toBe('3 d 4 h')
    })

    it('refuses a span that is not one', () => {
        expect(formatSpan(-1)).toBe('—')
        expect(formatSpan(Number.NaN)).toBe('—')
    })
})
