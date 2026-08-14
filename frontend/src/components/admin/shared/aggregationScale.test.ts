/**
 * The tuning readouts exist to stop operators misreading the knobs, so the
 * translations themselves have to be right — a confidently wrong "≈80% duty
 * cycle" is worse than no readout at all.
 */
import { describe, expect, it } from 'vitest'
import {
    writeDutyCyclePct,
    describeWriteBudget,
    describePendingPairs,
    budgetPressure,
    compactCount,
    formatBytes,
    BYTES_PER_AGG_EDGE,
} from './aggregationScale'

describe('writeDutyCyclePct', () => {
    it('inverts the pacing ratio — higher pacing is SLOWER', () => {
        // The pipeline sleeps `duration x ratio` after each write, so the
        // share of time spent writing is 1/(1+ratio). Reading the ratio as
        // "throughput" (higher = faster) is the exact misconception this
        // readout exists to kill.
        expect(writeDutyCyclePct(0)).toBe(100)
        expect(writeDutyCyclePct(0.25)).toBe(80)
        expect(writeDutyCyclePct(0.5)).toBe(67)
        expect(writeDutyCyclePct(1.0)).toBe(50)
        expect(writeDutyCyclePct(2.0)).toBe(33)
    })

    it('is monotonically decreasing', () => {
        const ratios = [0, 0.25, 0.5, 1, 2, 4, 10]
        const cycles = ratios.map(writeDutyCyclePct)
        expect(cycles).toEqual([...cycles].sort((a, b) => b - a))
    })

    it('does not divide by a negative or NaN ratio', () => {
        expect(writeDutyCyclePct(-1)).toBe(100)
        expect(writeDutyCyclePct(NaN)).toBe(100)
    })
})

describe('describeWriteBudget', () => {
    it('states the memory cost and the graph size it covers', () => {
        const text = describeWriteBudget(25_000_000)
        // 25M x 512B = 12.8GB
        expect(text).toContain('12.8 GB')
        // Boundary pairs run 1.5-2x raw edges → 12.5M-16.7M source edges.
        expect(text).toMatch(/12\.5M–16\.7M edges/)
    })

    it('is empty for a missing value rather than rendering "NaN"', () => {
        expect(describeWriteBudget(0)).toBe('')
        expect(describeWriteBudget(NaN)).toBe('')
    })
})

describe('describePendingPairs', () => {
    it('reports WORKER memory, which is the resource this knob bounds', () => {
        expect(describePendingPairs(50_000_000)).toContain('5 GB')
        expect(describePendingPairs(50_000_000)).toContain('worker memory')
    })
})

describe('budgetPressure', () => {
    it('mirrors the backend advisory threshold of 75%', () => {
        expect(budgetPressure(74, 100)).toBe('ok')
        expect(budgetPressure(75, 100)).toBe('warning')
        expect(budgetPressure(99, 100)).toBe('warning')
    })

    it('flags an over-budget run as critical', () => {
        expect(budgetPressure(100, 100)).toBe('critical')
        expect(budgetPressure(250, 100)).toBe('critical')
    })

    it('stays quiet when there is no budget to measure against', () => {
        expect(budgetPressure(10, 0)).toBe('ok')
    })
})

describe('formatting', () => {
    it('compacts counts without trailing ".0"', () => {
        expect(compactCount(950)).toBe('950')
        expect(compactCount(12_500)).toBe('12.5K')
        expect(compactCount(25_000_000)).toBe('25M')
        expect(compactCount(3_400_000)).toBe('3.4M')
    })

    it('formats bytes across the GB/MB boundary', () => {
        expect(formatBytes(12.8e9)).toBe('12.8 GB')
        expect(formatBytes(500e6)).toBe('500 MB')
        expect(formatBytes(0)).toBe('—')
    })

    it('keeps the per-edge cost in step with the documented ~0.5KB', () => {
        expect(BYTES_PER_AGG_EDGE).toBe(512)
    })
})
