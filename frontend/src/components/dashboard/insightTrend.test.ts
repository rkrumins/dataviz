import { describe, expect, it } from 'vitest'
import { changePhrase, cumulativeByDay, seriesDelta } from './insightTrend'

describe('seriesDelta', () => {
    it('runs from the first measured day to the last, skipping days before anything was measured', () => {
        expect(seriesDelta([null, null, 100, 120, 110])).toEqual({ first: 100, last: 110, change: 10, pct: 0.1 })
    })

    it('says nothing from fewer than two measurements', () => {
        expect(seriesDelta([null, 5])).toBeNull()
        expect(seriesDelta([])).toBeNull()
    })

    it('has no percentage when it started from nothing', () => {
        expect(seriesDelta([0, 0, 3])).toEqual({ first: 0, last: 3, change: 3, pct: null })
    })
})

describe('cumulativeByDay', () => {
    it('counts what existed at the end of each day', () => {
        const days = ['2026-10-01', '2026-10-02', '2026-10-03']
        expect(cumulativeByDay(['2026-10-02T09:00:00Z', '2025-01-01T00:00:00Z', '2026-10-03T23:59:00Z'], days))
            .toEqual([1, 2, 3])
    })
})

describe('changePhrase', () => {
    it('reads as a signed count over the window, or nothing when flat', () => {
        expect(changePhrase({ first: 1, last: 4, change: 3, pct: 3 }, 30)).toBe('+3 in 30 days')
        expect(changePhrase({ first: 4, last: 2, change: -2, pct: -0.5 }, 30)).toBe('−2 in 30 days')
        expect(changePhrase({ first: 4, last: 4, change: 0, pct: 0 }, 30)).toBeNull()
        expect(changePhrase(null, 30)).toBeNull()
    })
})
