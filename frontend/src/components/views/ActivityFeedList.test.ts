/**
 * groupActivity — the day-bucketing + duplicate-folding that turns a raw feed
 * into what the user reads. Worth pinning: a republished data source emits one
 * data_changed per affected view, so the raw feed repeats the same sentence
 * several times in a row, and the folding is what makes the feed legible.
 */
import { describe, it, expect } from 'vitest'
import { groupActivity } from './ActivityFeedList'
import type { ViewActivityEntry } from '@/services/viewApiService'

function entry(over: Partial<ViewActivityEntry> & { id: string }): ViewActivityEntry {
    return {
        action: 'data_changed',
        actor: 'user_1',
        actorName: 'System Admin',
        summary: 'Underlying data updated',
        viewId: 'view_1',
        viewName: 'Impact Analysis',
        createdAt: new Date().toISOString(),
        ...over,
    } as ViewActivityEntry
}

const iso = (d: Date) => d.toISOString()
const today = new Date()
const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)

describe('groupActivity', () => {
    it('folds a run of identical adjacent events into one row with a count', () => {
        const groups = groupActivity([
            entry({ id: 'a' }),
            entry({ id: 'b' }),
            entry({ id: 'c' }),
        ])

        expect(groups).toHaveLength(1)
        expect(groups[0].rows).toHaveLength(1)
        expect(groups[0].rows[0].count).toBe(3)
    })

    it('keeps the NEWEST event of a folded run (entries arrive newest-first)', () => {
        const groups = groupActivity([
            entry({ id: 'newest', createdAt: iso(today) }),
            entry({ id: 'older', createdAt: iso(new Date(today.getTime() - 60_000)) }),
        ])

        expect(groups[0].rows[0].entry.id).toBe('newest')
        expect(groups[0].rows[0].count).toBe(2)
    })

    it('does not fold across different views', () => {
        const groups = groupActivity([
            entry({ id: 'a', viewId: 'view_1', viewName: 'One' }),
            entry({ id: 'b', viewId: 'view_2', viewName: 'Two' }),
        ])

        expect(groups[0].rows).toHaveLength(2)
        expect(groups[0].rows.every(r => r.count === 1)).toBe(true)
    })

    it('does not fold across different actions on the same view', () => {
        const groups = groupActivity([
            entry({ id: 'a', action: 'data_changed' }),
            entry({ id: 'b', action: 'updated' }),
        ])

        expect(groups[0].rows).toHaveLength(2)
    })

    it('does not fold across different actors', () => {
        const groups = groupActivity([
            entry({ id: 'a', actor: 'user_1' }),
            entry({ id: 'b', actor: 'user_2' }),
        ])

        expect(groups[0].rows).toHaveLength(2)
    })

    it('only folds ADJACENT events — an interruption starts a new row', () => {
        const groups = groupActivity([
            entry({ id: 'a', action: 'data_changed' }),
            entry({ id: 'b', action: 'updated' }),
            entry({ id: 'c', action: 'data_changed' }),
        ])

        // Not 2 rows with data_changed×2: the update sits between them.
        expect(groups[0].rows).toHaveLength(3)
    })

    it('buckets by day and labels today/yesterday', () => {
        const groups = groupActivity([
            entry({ id: 'a', createdAt: iso(today) }),
            entry({ id: 'b', createdAt: iso(yesterday) }),
        ])

        expect(groups).toHaveLength(2)
        expect(groups[0].label).toBe('Today')
        expect(groups[1].label).toBe('Yesterday')
    })

    it('never folds identical events that fall on different days', () => {
        const groups = groupActivity([
            entry({ id: 'a', createdAt: iso(today) }),
            entry({ id: 'b', createdAt: iso(yesterday) }),
        ])

        expect(groups[0].rows[0].count).toBe(1)
        expect(groups[1].rows[0].count).toBe(1)
    })

    it('handles an empty feed', () => {
        expect(groupActivity([])).toEqual([])
    })
})
