/**
 * The review's risk indicator: a band, and the reasons in the words of the
 * choices that put it there.
 */
import { describe, expect, it } from 'vitest'

import { keyExposure } from '../exposure'

const readOnly = { views: 'read', data: 'read', publish: false } as const

describe('how far a leaked key would reach', () => {
    it('is low for a short-lived, read-only key on picked items behind a network limit', () => {
        const e = keyExposure({ permissions: readOnly, resourceMode: 'items', lifetimeDays: 30, cidrs: ['10.0.0.0/8'] })
        expect(e.band).toBe('low')
        expect(e.label).toBe('Low')
        expect(e.reasons).toEqual([])
        expect(e.limits).toContain('Only from 1 network')
    })

    it('is high for everything, writing, publishing, forever, from anywhere — and says each', () => {
        const e = keyExposure({
            permissions: { views: 'write', data: 'write', publish: true },
            resourceMode: 'all', lifetimeDays: null, cidrs: [],
        })
        expect(e.band).toBe('high')
        expect(e.pct).toBe(100)
        expect(e.reasons).toEqual([
            'Reaches everything you can access, including what you gain later',
            'Can change data',
            'Can change views',
            'Can publish views to everyone',
            'Never expires',
            'Works from any network',
        ])
    })

    it('counts a long life against it, and no network limit', () => {
        const e = keyExposure({ permissions: readOnly, resourceMode: 'workspaces', lifetimeDays: 365, cidrs: [] })
        expect(e.band).toBe('moderate')
        expect(e.reasons).toEqual([
            'Reaches whole workspaces, including what is added to them later',
            'Long-lived: 365 days',
            'Works from any network',
        ])
    })
})
