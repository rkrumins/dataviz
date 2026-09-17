/**
 * Every Fine-Tune Performance profile must handle a large graph (1M nodes
 * / 2M edges) out of the box.
 *
 * The presets trade off how hard a job leans on the graph provider —
 * pacing, scan width, extract concurrency, retries. They must NOT trade
 * off capacity: the budgets and the rollup storage mode are what decide
 * whether a big graph completes at all, so picking "Conservative" instead
 * of "Performance" should change how long a rebuild takes, never whether
 * it succeeds.
 *
 * Capacity on the graph store is MEASURED — the rebuild reads the shard
 * that owns the graph and budgets by its free memory — and an explicit
 * ceiling on the job wins over that measurement. So no preset may carry
 * one: a pinned 25M made every UI-triggered rebuild stop at 25M however
 * much memory the operator added to the shard.
 */
import { describe, expect, it } from 'vitest'
import { CONFIG_PRESETS, PRESET_TIMEOUT_MINUTES } from './AggregationOverridesForm'

describe('aggregation config presets', () => {
    it('gives every profile the same capacity floor', () => {
        for (const preset of CONFIG_PRESETS) {
            // Worker RSS budget — independent of graph-store topology.
            expect(preset.tuning.maxPendingPairs, preset.id).toBe(50_000_000)
            expect(preset.timeoutMinutes, preset.id).toBe(PRESET_TIMEOUT_MINUTES)
        }
    })

    it('leaves the graph-store budget to the shard on every profile', () => {
        // A preset that set the ceiling would override the measured budget
        // on every job started from the UI; the reserve and bytes-per-edge
        // are the operator's (Defaults) or the shard's (calibrated), never
        // a profile's.
        for (const preset of CONFIG_PRESETS) {
            for (const key of ['maxMaterializedEdges', 'shardReservePct', 'bytesPerEdge'] as const) {
                expect(Object.hasOwn(preset.tuning, key), `${preset.id}.${key}`).toBe(false)
            }
        }
    })

    it('expresses no rollup-storage choice on any profile', () => {
        // A profile says how hard to lean on the provider, not where the
        // rollups live. Setting the key here would make picking a profile
        // silently overwrite a fleet-wide storage decision — in either
        // direction, since an absent key now means INHERIT (the stored global,
        // then the env default) rather than Auto.
        for (const preset of CONFIG_PRESETS) {
            expect(preset.tuning.materializeFinePairs, preset.id).toBeUndefined()
            expect(Object.hasOwn(preset.tuning, 'materializeFinePairs'), preset.id).toBe(false)
        }
    })

    it('still differentiates the profiles by provider load', () => {
        const byId = Object.fromEntries(CONFIG_PRESETS.map(p => [p.id, p]))

        // Pacing is a sleep multiplier: HIGHER is gentler and slower.
        expect(byId.conservative.tuning.writePacingRatio!)
            .toBeGreaterThan(byId.balanced.tuning.writePacingRatio!)
        expect(byId.balanced.tuning.writePacingRatio!)
            .toBeGreaterThan(byId.performance.tuning.writePacingRatio!)

        expect(byId.performance.tuning.extractConcurrency!)
            .toBeGreaterThan(byId.conservative.tuning.extractConcurrency!)
        expect(byId.performance.tuning.scanRangeWidth!)
            .toBeGreaterThan(byId.conservative.tuning.scanRangeWidth!)
    })

    it('offers a Gentle profile for graphs the store keeps refusing, gentler than Conservative', () => {
        const byId = Object.fromEntries(CONFIG_PRESETS.map(p => [p.id, p]))
        expect(CONFIG_PRESETS[0].id).toBe('gentle')                       // first: the safe choice leads
        expect(byId.gentle.tuning.writePacingRatio!).toBeGreaterThan(byId.conservative.tuning.writePacingRatio!)
        expect(byId.gentle.tuning.scanRangeWidth!).toBeLessThan(byId.conservative.tuning.scanRangeWidth!)
        expect(byId.gentle.tuning.extractConcurrency).toBe(1)
        expect(byId.gentle.tuning.scanShrinkFloor).toBe(1)               // narrows all the way to one row
        expect(byId.gentle.tuning.scanTimeoutS!).toBeGreaterThan(30)      // more patience per query
        expect(byId.gentle.maxRetries).toBe(5)
        // It says nothing about what the last run learned — the hints apply.
        expect(Object.hasOwn(byId.gentle.tuning, 'ignoreObserved')).toBe(false)
    })

    it('keeps the profiles distinguishable, so the selector still means something', () => {
        const fingerprints = CONFIG_PRESETS.map(p => JSON.stringify([p.maxRetries, p.tuning]))
        expect(new Set(fingerprints).size).toBe(CONFIG_PRESETS.length)
    })
})
