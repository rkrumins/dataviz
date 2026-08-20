import { describe, expect, it } from 'vitest'

import { compactNum, formatPct, laneMeta, signedNum } from './shared'

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
