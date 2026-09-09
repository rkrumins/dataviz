/**
 * Re-trigger / Resume must start from the CONFIGURED DEFAULTS, not from
 * the settings the previous job happened to run with.
 *
 * Replaying a job's frozen tuning is what made a graph that failed under
 * bad settings keep failing under those same settings: an operator would
 * fix the admin defaults, hit Re-trigger, and silently get the old values
 * back. Only `projectionMode` is inherited, because that decides WHERE the
 * projection lives rather than how fast it is built.
 */
import { describe, expect, it } from 'vitest'
import { buildInitialOverridesFromJob, gentleRetryReason, retryPresetReason } from './RegistryJobHistory'
import type { AggregationJobResponse, AggregationTuning } from '@/services/aggregationService'

const CONFIGURED_DEFAULTS: AggregationTuning = {
    scanRangeWidth: 200_000,
    writePacingRatio: 1.0,
    extractConcurrency: 1,
    maxPendingPairs: 50_000_000,
}

/** A job frozen with cramped settings — the shape that keeps re-failing. */
const jobWithStaleTuning = {
    projectionMode: 'in_source',
    batchSize: 5000,
    maxRetries: 1,
    timeoutSecs: 3600,
    tuning: {
        scan_range_width: 250_000,
        write_pacing_ratio: 0.5,
        extract_concurrency: 2,
        max_pending_pairs: 5_000_000,
        max_materialized_edges: 2_000_000,
    },
} as unknown as AggregationJobResponse

describe('buildInitialOverridesFromJob', () => {
    it('seeds tuning from the configured defaults, not the job row', () => {
        const value = buildInitialOverridesFromJob(jobWithStaleTuning, CONFIGURED_DEFAULTS)

        expect(value.tuning).toEqual(CONFIGURED_DEFAULTS)
        // The cramped 2M ceiling on the job row is exactly what fails a
        // 1M-node / 2M-edge graph; it must not come back. With no ceiling
        // configured, the measured shard budget governs the re-run.
        expect(value.tuning?.maxMaterializedEdges).toBeUndefined()
    })

    it('uses the default retries and stall timeout, not the job row values', () => {
        const value = buildInitialOverridesFromJob(jobWithStaleTuning, CONFIGURED_DEFAULTS)

        expect(value.maxRetries).toBe(3)
        expect(value.timeoutMinutes).toBe(180)
    })

    it('still inherits projectionMode from the job', () => {
        const dedicated = { ...jobWithStaleTuning, projectionMode: 'dedicated' } as AggregationJobResponse

        expect(buildInitialOverridesFromJob(dedicated, CONFIGURED_DEFAULTS).projectionMode).toBe('dedicated')
        expect(buildInitialOverridesFromJob(jobWithStaleTuning, CONFIGURED_DEFAULTS).projectionMode).toBe('in_source')
    })

    it('leaves tuning undefined when no defaults are loaded, so the server resolves them', () => {
        // A failed settings fetch must not pin the job to the stale values
        // either — omitting `tuning` lets the control plane apply the
        // stored globals.
        expect(buildInitialOverridesFromJob(jobWithStaleTuning).tuning).toBeUndefined()
    })

    it('clamps a below-floor stored batchSize to the default', () => {
        // Legacy purge rows persist with batch_size = 0, below the
        // backend validator's floor of 100.
        const legacy = { ...jobWithStaleTuning, batchSize: 0 } as AggregationJobResponse

        expect(buildInitialOverridesFromJob(legacy, CONFIGURED_DEFAULTS).batchSize).toBe(5000)
    })
})

describe('a retry after the graph store kept refusing starts from the Gentle profile', () => {
    const refused = { ...jobWithStaleTuning, status: 'failed', failureCategory: 'query_memory' } as AggregationJobResponse

    it('pre-selects Gentle for a per-query memory or timeout failure, keeping the storage choice', () => {
        const value = buildInitialOverridesFromJob(refused, { ...CONFIGURED_DEFAULTS, materializeFinePairs: 'auto' })
        expect(value.tuning?.scanRangeWidth).toBe(25_000)
        expect(value.tuning?.extractConcurrency).toBe(1)
        expect(value.tuning?.scanShrinkFloor).toBe(1)
        expect(value.tuning?.materializeFinePairs).toBe('auto')     // the fleet's storage choice survives
        expect(value.maxRetries).toBe(5)
        expect(gentleRetryReason(refused)).toMatch(/per-query memory limit/)
        expect(gentleRetryReason({ status: 'failed', failureCategory: 'timeout' })).toMatch(/timed out/)
    })

    it('keeps the settings after a node went away — narrowing does not bring one back', () => {
        const away = {
            ...jobWithStaleTuning, status: 'failed', failureCategory: 'provider_unavailable',
        } as AggregationJobResponse
        expect(buildInitialOverridesFromJob(away, CONFIGURED_DEFAULTS).tuning).toEqual(CONFIGURED_DEFAULTS)
        expect(gentleRetryReason(away)).toBeNull()          // not a Gentle case
        expect(retryPresetReason(away)).toMatch(/not answering/)
        expect(retryPresetReason(away)).toMatch(/checkpoint/)
        // The Gentle cases still speak for themselves through the same call.
        expect(retryPresetReason(refused)).toMatch(/per-query memory limit/)
    })

    it('leaves every other failure — and a completed run — on the configured defaults', () => {
        for (const job of [
            { ...jobWithStaleTuning, status: 'failed', failureCategory: 'write_budget' },
            { ...jobWithStaleTuning, status: 'completed', failureCategory: null },
        ] as AggregationJobResponse[]) {
            expect(buildInitialOverridesFromJob(job, CONFIGURED_DEFAULTS).tuning).toEqual(CONFIGURED_DEFAULTS)
            expect(gentleRetryReason(job)).toBeNull()
        }
    })
})
