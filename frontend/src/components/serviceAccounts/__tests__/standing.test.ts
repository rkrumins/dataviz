/**
 * An account's standing says what its keys do, and they follow the pause
 * date the server keeps — not who can act for it this minute, which can run
 * ahead of it by up to an hour.
 */
import { describe, expect, it } from 'vitest'

import { standingOf } from '../parts'

const NOW = new Date('2026-10-24T12:00:00Z')
const base = { status: 'active' as const, managed: true, singleManager: false, pausesAt: null, adminHold: false }

describe('standingOf', () => {
    it('says the keys are paused once the pause date has passed, whoever can act now', () => {
        const paused = { ...base, managed: false, pausesAt: '2026-10-24T11:00:00Z' }
        expect(standingOf(paused, NOW)).toMatchObject({ tone: 'danger', label: 'Needs a manager — keys paused' })
        expect(standingOf({ ...paused, managed: true }, NOW)).toMatchObject({
            tone: 'danger', detail: 'Someone can act for it again: its keys work again within the hour.',
        })
    })

    it('says when they pause while there is still time', () => {
        expect(standingOf({ ...base, managed: false, pausesAt: '2026-10-29T12:00:00Z' }, NOW).label)
            .toMatch(/^Needs a manager — keys pause /)
    })

    it('does not call keys paused that still work, before the pause date is set', () => {
        expect(standingOf({ ...base, managed: false }, NOW)).toMatchObject({ tone: 'warning', label: 'Needs a manager' })
    })

    it('reads a manager who is back before the pause as managed', () => {
        expect(standingOf({ ...base, singleManager: true, pausesAt: '2026-10-29T12:00:00Z' }, NOW).label).toBe('Single manager')
        expect(standingOf({ ...base, status: 'disabled' }, NOW).label).toBe('Disabled')
    })

    it('says who can enable a disabled account', () => {
        expect(standingOf({ ...base, status: 'disabled' }, NOW).detail)
            .toBe('Its keys don’t work until one of its managers enables it.')
        expect(standingOf({ ...base, status: 'disabled', adminHold: true }, NOW).detail)
            .toBe('An administrator disabled it: its keys don’t work until an administrator enables it.')
    })
})
