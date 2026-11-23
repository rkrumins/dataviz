/**
 * Units: every value reads with its unit, and what it is written as reads back to the same value.
 * The round trips are the point: a settings field shows `format(value)`, the person edits the text,
 * and `parse` must give back exactly what was shown, or an edit that changed nothing would stage a
 * change.
 */
import { describe, expect, it } from 'vitest'
import {
    BYTE_UNITS, DURATION_UNITS, FOREVER, UNLIMITED,
    formatBytes, formatBytesOrUnlimited, formatCount, formatCountOrUnlimited, formatDays, formatDaysOrForever,
    formatDuration, formatMs, formatNumber, formatPercent, formatRatio, formatRefusalBudget,
    parseBytes, parseBytesOrUnlimited, parseCount, parseCountOrUnlimited, parseDays, parseDaysOrForever,
    parseDuration, parseMs, parseNumber, parsePercent, parseRatio, parseRefusalBudget, pickUnit, pluralize,
} from './units'

const EN = 'en-US'

describe('numbers', () => {
    it('reads the separators it writes, and refuses a group that is not three digits', () => {
        expect(formatNumber(1234567.25, { locale: EN })).toBe('1,234,567.25')
        expect(parseNumber('1,234,567.25', EN)).toBe(1234567.25)
        expect(parseNumber('1234567', EN)).toBe(1234567)
        expect(parseNumber('1_000', EN)).toBe(1000)
        expect(parseNumber('.5', EN)).toBe(0.5)
        expect(parseNumber('-3', EN)).toBe(-3)
        expect(parseNumber('1,5', EN)).toBeNull()
        expect(parseNumber('12a', EN)).toBeNull()
        expect(parseNumber('', EN)).toBeNull()
    })

    it('reads a locale whose decimal is a comma', () => {
        expect(parseNumber(formatNumber(1234.5, { locale: 'de-DE' }), 'de-DE')).toBe(1234.5)
        expect(parseNumber('1.500', 'de-DE')).toBe(1500)
        expect(parseNumber(formatNumber(1234.5, { locale: 'fr-FR' }), 'fr-FR')).toBe(1234.5)
    })

    it('says one row, two rows, one entity, two entities', () => {
        expect(pluralize(1, 'rows')).toBe('row')
        expect(pluralize(2, 'rows')).toBe('rows')
        expect(pluralize(1, 'entities')).toBe('entity')
        expect(pluralize(3, 'entity')).toBe('entities')
        expect(pluralize(1, 'graph')).toBe('graph')
    })
})

describe('counts', () => {
    it('formats with separators and a noun', () => {
        expect(formatCount(200000, 'rows', EN)).toBe('200,000 rows')
        expect(formatCount(1, 'rows', EN)).toBe('1 row')
        expect(formatCount(42, undefined, EN)).toBe('42')
    })

    it('reads separators, multipliers and a trailing noun, and refuses fractions and negatives', () => {
        expect(parseCount('200,000', EN)).toBe(200000)
        expect(parseCount('200k', EN)).toBe(200000)
        expect(parseCount('1.5M', EN)).toBe(1500000)
        expect(parseCount('12 rows', EN)).toBe(12)
        expect(parseCount('1.5', EN)).toBeNull()
        expect(parseCount('-2', EN)).toBeNull()
    })

    it('round-trips', () => {
        for (const n of [0, 1, 7, 999, 1000, 200000, 12345678]) {
            expect(parseCount(formatCount(n, 'rows', EN), EN)).toBe(n)
        }
    })

    it('treats unlimited as a value', () => {
        expect(formatCountOrUnlimited(UNLIMITED, 'versions')).toBe('Unlimited')
        expect(formatCountOrUnlimited(3, 'versions', EN)).toBe('3 versions')
        expect(parseCountOrUnlimited('Unlimited')).toBe(UNLIMITED)
        expect(parseCountOrUnlimited('no limit')).toBe(UNLIMITED)
        expect(parseCountOrUnlimited('3', EN)).toBe(3)
        for (const v of [UNLIMITED, 0, 5, 1200] as const) {
            expect(parseCountOrUnlimited(formatCountOrUnlimited(v, 'versions', EN), EN)).toBe(v)
        }
    })
})

describe('bytes (binary)', () => {
    it('formats in the largest unit reached', () => {
        expect(formatBytes(13 * 1024 ** 3, EN)).toBe('13 GB')
        expect(formatBytes(1536, EN)).toBe('1.5 KB')
        expect(formatBytes(1, EN)).toBe('1 byte')
        expect(formatBytes(512, EN)).toBe('512 bytes')
        expect(formatBytes(2 * 1024 ** 4, EN)).toBe('2 TB')
    })

    it('reads binary units however they are written', () => {
        expect(parseBytes('13 GB', EN)).toBe(13 * 1024 ** 3)
        expect(parseBytes('13GiB', EN)).toBe(13 * 1024 ** 3)
        expect(parseBytes('13g', EN)).toBe(13 * 1024 ** 3)
        expect(parseBytes('1.5 TB', EN)).toBe(1.5 * 1024 ** 4)
        expect(parseBytes('1024', EN)).toBe(1024)
        expect(parseBytes('3 parsecs', EN)).toBeNull()
    })

    it('round-trips', () => {
        for (const n of [0, 1, 800, 1024, 1536, 5 * 1024 ** 2, 13 * 1024 ** 3, 2.5 * 1024 ** 4]) {
            expect(parseBytes(formatBytes(n, EN), EN)).toBe(n)
        }
        for (const v of [UNLIMITED, 8 * 1024 ** 3] as const) {
            expect(parseBytesOrUnlimited(formatBytesOrUnlimited(v, EN), EN)).toBe(v)
        }
    })

    it('picks the unit an input shows a value in', () => {
        expect(pickUnit(13 * 1024 ** 3, BYTE_UNITS).id).toBe('GB')
        expect(pickUnit(1.5 * 1024 ** 3, BYTE_UNITS).id).toBe('GB')
        expect(pickUnit(1000, BYTE_UNITS).id).toBe('B')
        expect(pickUnit(5400, DURATION_UNITS).id).toBe('h')
        expect(pickUnit(5400, DURATION_UNITS, 0).id).toBe('min')
        expect(pickUnit(45, DURATION_UNITS).id).toBe('s')
    })
})

describe('durations (seconds)', () => {
    it('says a duration in the units a person would', () => {
        expect(formatDuration(5400, { locale: EN })).toBe('1 hour 30 minutes')
        expect(formatDuration(604800, { locale: EN })).toBe('7 days')
        expect(formatDuration(1, { locale: EN })).toBe('1 second')
        expect(formatDuration(0, { locale: EN })).toBe('0 seconds')
        expect(formatDuration(93784, { style: 'short', locale: EN })).toBe('1 d 2 h 3 min 4 s')
    })

    it('reads compact and spelled-out forms', () => {
        expect(parseDuration('90', EN)).toBe(90)
        expect(parseDuration('90s', EN)).toBe(90)
        expect(parseDuration('1.5h', EN)).toBe(5400)
        expect(parseDuration('1h30m', EN)).toBe(5400)
        expect(parseDuration('1 hour 30 minutes', EN)).toBe(5400)
        expect(parseDuration('2 days, 6 hours', EN)).toBe(194400)
        expect(parseDuration('2w', EN)).toBe(1209600)
        expect(parseDuration('soon', EN)).toBeNull()
        expect(parseDuration('5 fortnights', EN)).toBeNull()
    })

    it('round-trips', () => {
        for (const s of [0, 1, 59, 60, 90, 3600, 5400, 86400, 93784, 31536000]) {
            expect(parseDuration(formatDuration(s, { locale: EN }), EN)).toBe(s)
            expect(parseDuration(formatDuration(s, { style: 'short', locale: EN }), EN)).toBe(s)
        }
    })
})

describe('milliseconds', () => {
    it('keeps ms under a second, and whole seconds in words, as every other duration', () => {
        expect(formatMs(250, EN)).toBe('250 ms')
        expect(formatMs(1500, EN)).toBe('1,500 ms')
        expect(formatMs(30000, EN)).toBe('30 seconds')
        expect(formatMs(90000, EN)).toBe('1 minute 30 seconds')
    })

    it('reads ms, seconds and minutes', () => {
        expect(parseMs('250', EN)).toBe(250)
        expect(parseMs('250ms', EN)).toBe(250)
        expect(parseMs('1.5s', EN)).toBe(1500)
        expect(parseMs('2 min', EN)).toBe(120000)
    })

    it('round-trips', () => {
        for (const ms of [0, 1, 250, 999, 1000, 1500, 30000, 90000, 120000]) {
            expect(parseMs(formatMs(ms, EN), EN)).toBe(ms)
        }
    })
})

describe('days, and forever', () => {
    it('formats and reads days and weeks', () => {
        expect(formatDays(1, EN)).toBe('1 day')
        expect(formatDays(30, EN)).toBe('30 days')
        expect(parseDays('30d', EN)).toBe(30)
        expect(parseDays('2 weeks', EN)).toBe(14)
        expect(parseDays('1.5', EN)).toBeNull()
    })

    it('treats forever as a value', () => {
        expect(formatDaysOrForever(FOREVER)).toBe('Forever')
        expect(parseDaysOrForever('for good')).toBe(FOREVER)
        expect(parseDaysOrForever('never')).toBe(FOREVER)
        for (const v of [FOREVER, 1, 30, 365] as const) {
            expect(parseDaysOrForever(formatDaysOrForever(v, EN), EN)).toBe(v)
        }
    })
})

describe('percent and ratio', () => {
    it('formats a 0–100 percent and reads it back', () => {
        expect(formatPercent(85, EN)).toBe('85%')
        expect(formatPercent(0.5, EN)).toBe('0.5%')
        expect(parsePercent('85 %', EN)).toBe(85)
        for (const p of [0, 0.5, 30, 85, 100]) expect(parsePercent(formatPercent(p, EN), EN)).toBe(p)
    })

    it('shows a share as a percent and a multiplier with ×', () => {
        expect(formatRatio(0.4, 'share', EN)).toBe('40%')
        expect(formatRatio(0.125, 'share', EN)).toBe('12.5%')
        expect(formatRatio(0.5, 'times', EN)).toBe('×0.5')
        expect(parseRatio('40%', 'share', EN)).toBe(0.4)
        expect(parseRatio('40', 'share', EN)).toBe(0.4)
        expect(parseRatio('0.4', 'share', EN)).toBe(0.4)
        expect(parseRatio('×1.5', 'times', EN)).toBe(1.5)
        expect(parseRatio('1.5x', 'times', EN)).toBe(1.5)
        expect(parseRatio('150%', 'times', EN)).toBe(1.5)
    })

    it('round-trips', () => {
        for (const r of [0, 0.05, 0.125, 0.4, 1]) expect(parseRatio(formatRatio(r, 'share', EN), 'share', EN)).toBe(r)
        for (const r of [0, 0.25, 0.5, 1.5, 4]) expect(parseRatio(formatRatio(r, 'times', EN), 'times', EN)).toBe(r)
    })
})

describe('refused-rows budget', () => {
    it('says none, a count, a share or unlimited, and reads each back to its stored form', () => {
        expect(formatRefusalBudget('0')).toBe('None')
        expect(formatRefusalBudget('100', EN)).toBe('100 rows')
        expect(formatRefusalBudget('1', EN)).toBe('1 row')
        expect(formatRefusalBudget('0.5%', EN)).toBe('0.5% of rows')
        expect(formatRefusalBudget(UNLIMITED)).toBe('Unlimited')
        expect(parseRefusalBudget('none')).toBe('0')
        expect(parseRefusalBudget('1,000 rows', EN)).toBe('1000')
        expect(parseRefusalBudget('0.5 %', EN)).toBe('0.5%')
        expect(parseRefusalBudget('120%', EN)).toBeNull()
        for (const v of ['0', '1', '100', '25000', '0.5%', '2%', UNLIMITED]) {
            expect(parseRefusalBudget(formatRefusalBudget(v, EN), EN)).toBe(v)
        }
    })
})
