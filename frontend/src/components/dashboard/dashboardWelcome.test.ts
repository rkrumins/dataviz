/**
 * The hero's greeting and "what's new" line.
 *
 * The cap matters most: the feed loads a bounded window, so if the count reaches
 * that window we do NOT know the true total and must not imply we do. Saying
 * "24 updates" when there might be 200 is the same class of lie as the fake
 * "Jump Back In" list this page used to ship.
 */
import { describe, it, expect } from 'vitest'
import { salutationFor, initialsOf, whatsNewLine } from './dashboardWelcome'
import type { ViewActivityEntry } from '@/services/viewApiService'

const NOW = new Date('2026-07-13T12:00:00Z').getTime()
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString()

function entry(over: Partial<ViewActivityEntry> & { id: string }): ViewActivityEntry {
    return {
        action: 'updated',
        actor: 'user_1',
        actorName: 'Priya',
        summary: null,
        viewId: 'view_1',
        viewName: 'Q3 Hierarchy',
        createdAt: hoursAgo(1),
        ...over,
    } as ViewActivityEntry
}

describe('salutationFor', () => {
    it('greets by time of day', () => {
        expect(salutationFor(9)).toBe('Good morning')
        expect(salutationFor(14)).toBe('Good afternoon')
        expect(salutationFor(20)).toBe('Good evening')
        expect(salutationFor(3)).toBe('Working late')
    })

    it('handles the boundaries', () => {
        expect(salutationFor(5)).toBe('Good morning')
        expect(salutationFor(11)).toBe('Good morning')
        expect(salutationFor(12)).toBe('Good afternoon')
        expect(salutationFor(17)).toBe('Good afternoon')
        expect(salutationFor(18)).toBe('Good evening')
        expect(salutationFor(0)).toBe('Working late')
        expect(salutationFor(23)).toBe('Good evening')
    })
})

describe('initialsOf', () => {
    it('takes one letter from each name', () => {
        expect(initialsOf('System', 'Admin')).toBe('SA')
        expect(initialsOf('priya', 'sharma')).toBe('PS')
    })

    it('falls back to the first two letters of a lone first name', () => {
        expect(initialsOf('Priya')).toBe('PR')
    })

    it('never renders an empty avatar', () => {
        expect(initialsOf()).toBe('?')
        expect(initialsOf('', '  ')).toBe('?')
    })
})

describe('whatsNewLine', () => {
    it('counts updates and the distinct views they touched', () => {
        const line = whatsNewLine([
            entry({ id: 'a', viewId: 'v1' }),
            entry({ id: 'b', viewId: 'v1' }),
            entry({ id: 'c', viewId: 'v2' }),
        ], 24, NOW)

        expect(line).toBe('3 updates across 2 views in the last 24 hours.')
    })

    it('ignores events older than 24 hours', () => {
        const line = whatsNewLine([
            entry({ id: 'fresh', createdAt: hoursAgo(2) }),
            entry({ id: 'stale', createdAt: hoursAgo(30) }),
        ], 24, NOW)

        expect(line).toBe('1 update across 1 view in the last 24 hours.')
    })

    it('says "24+" when the count fills the loaded window — we cannot know the true total', () => {
        const entries = Array.from({ length: 24 }, (_, i) =>
            entry({ id: `e${i}`, viewId: `v${i % 3}` }))

        const line = whatsNewLine(entries, 24, NOW)

        expect(line).toContain('24+ updates')
        expect(line).toContain('across 3 views')
    })

    it('returns null when nothing happened in the window — the hero falls back to its blurb', () => {
        expect(whatsNewLine([entry({ id: 'old', createdAt: hoursAgo(48) })], 24, NOW)).toBeNull()
        expect(whatsNewLine([], 24, NOW)).toBeNull()
    })

    it('survives an unparseable timestamp instead of counting it', () => {
        const line = whatsNewLine([
            entry({ id: 'good' }),
            entry({ id: 'bad', createdAt: 'not-a-date' }),
        ], 24, NOW)

        expect(line).toBe('1 update across 1 view in the last 24 hours.')
    })
})
