/**
 * What "+3 h" and "double it" mean, exactly, and what a job is running under
 * — the pure half of the Extend control, shared with "extend all running".
 */
import { describe, expect, it } from 'vitest'
import type { AggregationJobResponse } from '@/services/aggregationService'
import {
    backToSettingsPatch, waitForReplicasPatch, releaseReplicaWaitPatch, describeChange, doubleWallPatch, extendStallPatch, formatWindow, halveScansPatch,
    limitsInForce, pacePatch, perQueryPatch, secondsLeft, serialReadsPatch, shapeInForce, smallerBatchesPatch,
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

describe('the scan shape', () => {
    it('reads what is in force: live first, then the run record, then the defaults', () => {
        expect(shapeInForce(job())).toEqual({
            pacingRatio: 1, extractConcurrency: 1, scanWidth: 200_000, scanWidthNow: null,
            replicaAckMin: 1, batchMax: 500, batchTargetS: 1,
            live: { pacing: false, concurrency: false, scanWidth: false, replicaAck: false, batchMax: false, batchTarget: false },
        })
        const j = job({
            runStats: {
                effective_tuning: { write_pacing_ratio: 0.5, extract_concurrency: 4, scan_range_width: 100_000, write_batch_max: 300, write_batch_target_s: 0.5 },
                adapted: { scan_width: 12_500 },
            },
            liveOverrides: { extract_concurrency: 2, replica_ack_min: 2, write_batch_max: 150 },
        })
        expect(shapeInForce(j)).toEqual({
            pacingRatio: 0.5, extractConcurrency: 2, scanWidth: 100_000, scanWidthNow: 12_500,
            replicaAckMin: 2, batchMax: 150, batchTargetS: 0.5,
            live: { pacing: false, concurrency: true, scanWidth: false, replicaAck: true, batchMax: true, batchTarget: false },
        })
    })

    it('builds the gentler patches from what is in force', () => {
        expect(pacePatch(job(), 2)).toEqual({ writePacingRatio: 2 })
        expect(pacePatch(job({ liveOverrides: { write_pacing_ratio: 0 } }), 4)).toEqual({ writePacingRatio: 4 })   // pacing off counts as 1×
        expect(pacePatch(job({ liveOverrides: { write_pacing_ratio: 6 } }), 2)).toEqual({ writePacingRatio: 10 })  // the bound
        expect(serialReadsPatch()).toEqual({ extractConcurrency: 1 })
        expect(halveScansPatch(job())).toEqual({ scanWidth: 100_000 })
        expect(halveScansPatch(job({ runStats: { adapted: { scan_width: 12_500 } } }))).toEqual({ scanWidth: 6_250 })
        expect(halveScansPatch(job({ liveOverrides: { scan_width: 1 } }))).toEqual({ scanWidth: 1 })
        expect(backToSettingsPatch()).toEqual({
            reset: ['writePacingRatio', 'extractConcurrency', 'scanWidth', 'replicaAckMin', 'writeBatchMax', 'writeBatchTargetS'],
        })
        // Smaller batches: half the ceiling in force, never below 10 rows.
        expect(smallerBatchesPatch(job())).toEqual({ writeBatchMax: 250 })
        expect(smallerBatchesPatch(job({ liveOverrides: { write_batch_max: 30 } }))).toEqual({ writeBatchMax: 15 })
        expect(smallerBatchesPatch(job({ liveOverrides: { write_batch_max: 10 } }))).toEqual({ writeBatchMax: 10 })
        // Replication backpressure: one more replica per write, or none at all.
        expect(waitForReplicasPatch(job())).toEqual({ replicaAckMin: 2 })
        expect(waitForReplicasPatch(job({ liveOverrides: { replica_ack_min: 5 } }))).toEqual({ replicaAckMin: 5 })
        expect(releaseReplicaWaitPatch()).toEqual({ replicaAckMin: 0 })
    })

    it('describes a shape change, and a clearing, in words', () => {
        expect(describeChange({ at: 'x', by: 'ops', field: 'write_pacing_ratio', from: 1, to: 2 })).toBe('ops set the write pacing 1× → 2×')
        expect(describeChange({ at: 'x', by: 'ops', field: 'scan_width', from: 5_000, to: null })).toBe('ops cleared the scan width (5,000 rows → the job’s setting)')
        expect(describeChange({ at: 'x', by: null, field: 'extract_concurrency', from: null, to: 1 })).toBe('An operator set the read concurrency the job’s setting → 1 at a time')
    })
})
