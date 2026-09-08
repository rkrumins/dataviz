/**
 * What "+3 h" and "double it" mean, exactly, and what a job is running under
 * — the pure half of the Extend control, shared with "extend all running".
 */
import { describe, expect, it } from 'vitest'
import type { AggregationJobResponse } from '@/services/aggregationService'
import {
    describeChange, doubleWallPatch, extendStallPatch, formatWindow, limitsInForce, perQueryPatch, secondsLeft,
} from './timeLimits'

function job(over: Partial<AggregationJobResponse> = {}): AggregationJobResponse {
    return {
        id: 'agg_1', dataSourceId: 'ds-1', status: 'running', triggerSource: 'manual', progress: 40,
        totalEdges: 100, processedEdges: 40, createdEdges: 0, batchSize: 1000, resumable: false, retryCount: 0,
        createdAt: '2026-09-09T10:00:00Z', ...over,
    } as AggregationJobResponse
}

describe('limitsInForce', () => {
    it('reads the row first, then the run record, then the defaults', () => {
        expect(limitsInForce(job())).toEqual({ stallSecs: 10_800, wallSecs: 86_400, scanTimeoutS: null, writeTimeoutS: null })
        const j = job({
            timeoutSecs: 21_600,
            runStats: { effective_tuning: { stall_timeout_secs: 7_200, max_wall_secs: 43_200, scan_timeout_s: 30, write_timeout_s: 60 } },
            liveOverrides: { max_wall_secs: 172_800, scan_timeout_s: 120, history: [] },
        })
        expect(limitsInForce(j)).toEqual({ stallSecs: 21_600, wallSecs: 172_800, scanTimeoutS: 120, writeTimeoutS: 60 })
        // The wall clock is never below the stall window.
        expect(limitsInForce(job({ timeoutSecs: 172_800 })).wallSecs).toBe(172_800)
    })
})

describe('the patches', () => {
    it('+N h raises the stall window, dragging the wall clock up only when it would fall below', () => {
        expect(extendStallPatch(job(), 3)).toEqual({ timeoutSecs: 21_600 })
        expect(extendStallPatch(job({ timeoutSecs: 82_800 }), 3)).toEqual({ timeoutSecs: 93_600, maxWallSecs: 93_600 })
        expect(extendStallPatch(job({ timeoutSecs: 604_000 }), 12)).toEqual({ timeoutSecs: 604_800, maxWallSecs: 604_800 })
    })

    it('doubles the wall clock up to seven days, and sends only the per-query budgets that changed', () => {
        expect(doubleWallPatch(job())).toEqual({ maxWallSecs: 172_800 })
        expect(doubleWallPatch(job({ liveOverrides: { max_wall_secs: 400_000 } }))).toEqual({ maxWallSecs: 604_800 })
        const j = job({ runStats: { effective_tuning: { scan_timeout_s: 30, write_timeout_s: 60 } } })
        expect(perQueryPatch(j, 120, 60)).toEqual({ scanTimeoutS: 120 })
        expect(perQueryPatch(j, null, 900)).toEqual({ writeTimeoutS: 600 })   // clamped to the bound
        expect(perQueryPatch(j, 30, null)).toEqual({})
    })
})

describe('what is left, and the history', () => {
    it('counts the stall window from the last checkpoint and the wall clock from the start', () => {
        const now = Date.parse('2026-09-09T12:00:00Z')
        const left = secondsLeft(job({ startedAt: '2026-09-09T10:00:00Z', lastCheckpointAt: '2026-09-09T11:30:00Z' }), now)
        expect(left).toEqual({ stall: 10_800 - 1_800, wall: 86_400 - 7_200 })
        expect(secondsLeft(job(), now)).toEqual({ stall: null, wall: null })
    })

    it('describes a change in words and formats windows for people', () => {
        expect(describeChange({ at: 'x', by: 'ops@example.com', field: 'timeout_secs', from: 10_800, to: 21_600 }))
            .toBe('ops@example.com raised the stall window 3 h → 6 h')
        expect(describeChange({ at: 'x', by: null, field: 'scan_timeout_s', from: null, to: 120 }))
            .toBe('An operator raised the scan timeout default → 120 s')
        expect(describeChange({ at: 'x', by: 'a', field: 'max_wall_secs', from: 172_800, to: 86_400 }))
            .toBe('a lowered the wall clock 2 d → 1 d')
        expect(formatWindow(1_800)).toBe('30 min')
        expect(formatWindow(5_400)).toBe('1.5 h')
        expect(formatWindow(259_200)).toBe('3 d')
    })
})
