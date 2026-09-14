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
import {
    buildInitialOverridesFromJob, gentleRetryReason, overridesFromRun, retryPresetReason,
} from './RegistryJobHistory'
import { balancedPreset, presetIdFor } from './shared/AggregationOverridesForm'
import type { AggregationJobResponse, AggregationTuning } from '@/services/aggregationService'

const CONFIGURED_DEFAULTS: AggregationTuning = {
    scanRangeWidth: 200_000,
    writePacingRatio: 1.0,
    extractConcurrency: 1,
    maxPendingPairs: 50_000_000,
}

/**
 * What the dialog should end up holding: the configured defaults, over a
 * Balanced seed. Here the two are the same knobs (Balanced IS the server's
 * environment default), so the only visible addition is the replica
 * acknowledgement — which the server already defaults to 1, and which the
 * dialog now states rather than leaving to a placeholder.
 */
const SEEDED_DEFAULTS: AggregationTuning = { ...CONFIGURED_DEFAULTS, replicaAckMin: 1 }

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

describe('what a manual trigger opens on', () => {
    it('is the Balanced profile, at one replica acknowledgement', () => {
        // Settings loaded, nothing stored: the operator used to be shown
        // "Custom" over settings that were exactly Balanced, because the
        // dialog seeded that empty global and no profile matched.
        const value = buildInitialOverridesFromJob(jobWithStaleTuning, {})

        expect(presetIdFor(value)).toBe('balanced')
        expect(value.tuning).toEqual({ ...balancedPreset().tuning, replicaAckMin: 1 })
        // Rollup storage stays unstated, so the form resolves it against the
        // server's effective default (Full detail). Writing it here would
        // overrule a fleet that had deliberately chosen Auto.
        expect(Object.hasOwn(value.tuning ?? {}, 'materializeFinePairs')).toBe(false)
    })

    it('lets a fleet default win over the seed', () => {
        // A stored global is the operator's answer to this question; Balanced
        // only fills in what they left alone.
        const value = buildInitialOverridesFromJob(
            jobWithStaleTuning, { ...CONFIGURED_DEFAULTS, writePacingRatio: 2.0, replicaAckMin: 0 },
        )
        expect(value.tuning?.writePacingRatio).toBe(2.0)
        expect(value.tuning?.replicaAckMin).toBe(0)
        expect(presetIdFor(value)).toBeNull()          // and it says so: Custom
    })
})

describe('buildInitialOverridesFromJob', () => {
    it('seeds tuning from the configured defaults, not the job row', () => {
        const value = buildInitialOverridesFromJob(jobWithStaleTuning, CONFIGURED_DEFAULTS)

        expect(value.tuning).toEqual(SEEDED_DEFAULTS)
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
        // Loaded-and-empty is a different thing and DOES get the Balanced
        // seed — see the first describe. Only a missing fetch stays silent.
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
        expect(buildInitialOverridesFromJob(away, CONFIGURED_DEFAULTS).tuning).toEqual(SEEDED_DEFAULTS)
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
            expect(buildInitialOverridesFromJob(job, CONFIGURED_DEFAULTS).tuning).toEqual(SEEDED_DEFAULTS)
            expect(gentleRetryReason(job)).toBeNull()
        }
    })
})

describe('overridesFromRun — putting a run’s own settings back', () => {
    it('reads what the run actually ran with, in the form’s spelling', () => {
        const value = overridesFromRun(jobWithStaleTuning)!

        // The run records the server's spelling; the form speaks the client's.
        expect(value.tuning).toEqual({
            scanRangeWidth: 250_000,
            writePacingRatio: 0.5,
            extractConcurrency: 2,
            maxPendingPairs: 5_000_000,
            maxMaterializedEdges: 2_000_000,
        })
        expect(value.maxRetries).toBe(1)
        expect(value.timeoutMinutes).toBe(60)
    })

    it('carries the rollup storage the run was FORCED to, not today’s default', () => {
        // The one setting that is not a number, and the one an operator most
        // often means by "the same as last time".
        const forced = {
            ...jobWithStaleTuning,
            tuning: { ...jobWithStaleTuning.tuning, materialize_fine_pairs: 'true' },
        } as unknown as AggregationJobResponse
        expect(overridesFromRun(forced)!.tuning?.materializeFinePairs).toBe(true)

        const auto = {
            ...jobWithStaleTuning,
            tuning: { ...jobWithStaleTuning.tuning, materialize_fine_pairs: 'auto' },
        } as unknown as AggregationJobResponse
        expect(overridesFromRun(auto)!.tuning?.materializeFinePairs).toBe('auto')
    })

    it('is null when the run recorded nothing, so the control is not offered', () => {
        // A job from before the self-tuning pipeline, or one that never
        // reached its first checkpoint.
        for (const tuning of [null, undefined, {}]) {
            expect(overridesFromRun({ ...jobWithStaleTuning, tuning } as AggregationJobResponse)).toBeNull()
        }
    })

    it('is NOT what the dialog opens on', () => {
        // The whole reason it is a control and not a default: re-triggering
        // exists to pick up the current defaults.
        const opened = buildInitialOverridesFromJob(jobWithStaleTuning, CONFIGURED_DEFAULTS)
        expect(opened.tuning).not.toEqual(overridesFromRun(jobWithStaleTuning)!.tuning)
        expect(opened.tuning?.maxMaterializedEdges).toBeUndefined()
    })

    it('ignores junk rather than putting it in the form', () => {
        const junk = {
            ...jobWithStaleTuning,
            tuning: { scan_range_width: 'wide', write_pacing_ratio: null, extract_concurrency: 2 },
        } as unknown as AggregationJobResponse
        expect(overridesFromRun(junk)!.tuning).toEqual({ extractConcurrency: 2 })
    })
})
