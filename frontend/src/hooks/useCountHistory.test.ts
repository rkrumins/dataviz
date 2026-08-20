/**
 * `resolveWindow` — the range arithmetic behind every history request.
 *
 * Pure and tested on its own because the half-filled custom range is the case
 * that would otherwise silently blank the view: a date picker with only one
 * end filled in should narrow what you see, not erase it.
 */
import { describe, expect, it } from 'vitest'

import { HISTORY_WINDOWS, resolveWindow } from './useCountHistory'

const NOW = new Date('2026-08-20T12:00:00.000Z')

describe('resolveWindow', () => {
    it('resolves each named window to its span, ending now', () => {
        for (const w of HISTORY_WINDOWS) {
            const { from, to } = resolveWindow(w.key, undefined, NOW)
            expect(to).toBe(NOW.toISOString())
            const days = (NOW.getTime() - new Date(from).getTime()) / 86_400_000
            expect(days).toBeCloseTo(w.days, 5)
        }
    })

    it('falls back to 30 days for an unrecognised key', () => {
        const { from } = resolveWindow('nonsense' as never, undefined, NOW)
        const days = (NOW.getTime() - new Date(from).getTime()) / 86_400_000
        expect(days).toBeCloseTo(30, 5)
    })

    it('honours a fully specified custom range, inclusive of the end day', () => {
        const { from, to } = resolveWindow(
            'custom', { from: '2026-08-01', to: '2026-08-10' }, NOW,
        )
        expect(from).toBe('2026-08-01T00:00:00.000Z')
        // Through the END of the 10th — a range ending at midnight would drop
        // a whole day of observations without saying so.
        expect(to).toBe('2026-08-10T23:59:59.999Z')
    })

    it('anchors an open-ended custom range at now', () => {
        const { from, to } = resolveWindow('custom', { from: '2026-08-01' }, NOW)
        expect(from).toBe('2026-08-01T00:00:00.000Z')
        expect(to).toBe(NOW.toISOString())
    })

    it('completes a custom range that only has an end', () => {
        const { from, to } = resolveWindow('custom', { to: '2026-08-10' }, NOW)
        expect(to).toBe('2026-08-10T23:59:59.999Z')
        const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000
        expect(days).toBeCloseTo(30, 1)
    })

    it('treats an empty custom range as the default window', () => {
        const { from } = resolveWindow('custom', {}, NOW)
        const days = (NOW.getTime() - new Date(from).getTime()) / 86_400_000
        expect(days).toBeCloseTo(30, 5)
    })
})
