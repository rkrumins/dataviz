/**
 * The colour IS the information. A reader scanning a column of timestamps never
 * reads the numbers — they look for the thing that isn't green. If these
 * thresholds drift, every stale record quietly starts looking healthy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { freshnessColor } from './TimeStamp'

const NOW = new Date('2026-07-13T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString()

afterEach(() => vi.useRealTimers())

describe('freshnessColor', () => {
    it('is green within a week', () => {
        vi.useFakeTimers().setSystemTime(NOW)
        expect(freshnessColor(daysAgo(0))).toBe('text-emerald-500')
        expect(freshnessColor(daysAgo(6.9))).toBe('text-emerald-500')
    })

    it('turns amber past a week', () => {
        vi.useFakeTimers().setSystemTime(NOW)
        expect(freshnessColor(daysAgo(7.1))).toBe('text-amber-500')
        expect(freshnessColor(daysAgo(29))).toBe('text-amber-500')
    })

    it('turns red past a month — the point of the whole thing', () => {
        vi.useFakeTimers().setSystemTime(NOW)
        expect(freshnessColor(daysAgo(31))).toBe('text-red-500')
        expect(freshnessColor(daysAgo(400))).toBe('text-red-500')
    })

    it('holds the boundaries exactly', () => {
        vi.useFakeTimers().setSystemTime(NOW)
        expect(freshnessColor(daysAgo(7))).toBe('text-emerald-500')
        expect(freshnessColor(daysAgo(30))).toBe('text-amber-500')
    })

    it('degrades to muted on an unparseable date rather than screaming red', () => {
        expect(freshnessColor('not-a-date')).toBe('text-ink-muted')
    })
})
