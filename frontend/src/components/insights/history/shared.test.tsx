import { describe, expect, it } from 'vitest'

import { compactNum, formatPct, laneMeta, nearbyEvents, signedNum } from './shared'

describe('compactNum', () => {
    it('abbreviates at thousand and million boundaries', () => {
        expect(compactNum(999)).toBe('999')
        expect(compactNum(1_500)).toBe('1.5k')
        expect(compactNum(67_870)).toBe('68k')
        expect(compactNum(2_400_000)).toBe('2.4M')
    })

    it('renders nullish as an em dash rather than 0', () => {
        expect(compactNum(null)).toBe('—')
        expect(compactNum(undefined)).toBe('—')
        expect(compactNum(0)).toBe('0')
    })

    it('abbreviates negatives by magnitude, keeping the sign', () => {
        expect(compactNum(-1_500)).toBe('-1.5k')
    })
})

describe('signedNum', () => {
    it('signs movement but not stillness', () => {
        expect(signedNum(1_200)).toBe('+1.2k')
        expect(signedNum(-1_200)).toBe('−1.2k')
        // A no-change is not a movement and must not be dressed as one.
        expect(signedNum(0)).toBe('0')
    })

    it('renders nullish as an em dash', () => {
        expect(signedNum(null)).toBe('—')
    })
})

describe('formatPct', () => {
    it('rounds coarsely above 10% and finely below', () => {
        expect(formatPct(12.34)).toBe('+12%')
        expect(formatPct(1.26)).toBe('+1.3%')
        expect(formatPct(-4.5)).toBe('−4.5%')
    })

    it('returns null when there is no baseline to be a percentage of', () => {
        expect(formatPct(null)).toBeNull()
    })
})

describe('laneMeta', () => {
    it('names each collection lane', () => {
        expect(laneMeta('probe').label).toBe('Probe')
        expect(laneMeta('sweep').label).toBe('Sweep')
    })

    it('falls back rather than throwing on an unknown lane', () => {
        expect(laneMeta('nonsense').label).toBe('Write')
    })
})

describe('nearbyEvents', () => {
    const event = (id: string, ts: string) => ({
        id, ts, origin: 'reconcile-sweep', actor: 'internal', scope: 'auto',
        outcome: 'accepted', gate: 'changed', reason: null, detail: null,
        job_id: null, run_id: null,
    })

    it('keeps activity close enough in time to be plausibly related', () => {
        const near = nearbyEvents(
            [event('a', '2026-08-18T12:05:00Z')], '2026-08-18T12:00:00Z',
        )
        expect(near.map((e) => e.id)).toEqual(['a'])
    })

    it('matches either side of the observation', () => {
        // The event is emitted when an operation is DECIDED and the snapshot
        // written when the result is next observed — the cause can precede or
        // follow the point.
        const near = nearbyEvents([
            event('before', '2026-08-18T11:55:00Z'),
            event('after', '2026-08-18T12:05:00Z'),
        ], '2026-08-18T12:00:00Z')
        expect(near).toHaveLength(2)
    })

    it('drops activity too far away to be related', () => {
        const near = nearbyEvents(
            [event('old', '2026-08-18T06:00:00Z')], '2026-08-18T12:00:00Z',
        )
        expect(near).toEqual([])
    })

    it('returns newest first', () => {
        const near = nearbyEvents([
            event('older', '2026-08-18T11:56:00Z'),
            event('newer', '2026-08-18T12:04:00Z'),
        ], '2026-08-18T12:00:00Z')
        expect(near.map((e) => e.id)).toEqual(['newer', 'older'])
    })

    it('returns nothing for an unparseable anchor rather than throwing', () => {
        expect(nearbyEvents([event('a', '2026-08-18T12:00:00Z')], 'nonsense'))
            .toEqual([])
    })
})
