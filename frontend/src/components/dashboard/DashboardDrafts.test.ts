/**
 * A draft's AGE is the signal that matters: drafts don't expire, they sit at the
 * commit they were forked from while main moves on, so an old one is tomorrow's
 * merge conflict. The threshold decides what we escalate, so it gets a test.
 */
import { describe, it, expect } from 'vitest'
import { isStale } from './DashboardDrafts'

const NOW = new Date('2026-07-13T12:00:00Z').getTime()
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString()

describe('isStale', () => {
    it('flags a draft untouched for more than a week', () => {
        expect(isStale(daysAgo(8), NOW)).toBe(true)
        expect(isStale(daysAgo(30), NOW)).toBe(true)
    })

    it('leaves recent work alone', () => {
        expect(isStale(daysAgo(0), NOW)).toBe(false)
        expect(isStale(daysAgo(6), NOW)).toBe(false)
    })

    it('does not flag exactly on the boundary', () => {
        expect(isStale(daysAgo(7), NOW)).toBe(false)
    })

    it('treats an unparseable timestamp as not stale, never crashing the card', () => {
        expect(isStale('not-a-date', NOW)).toBe(false)
    })
})
