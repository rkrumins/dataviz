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
 */
import { describe, expect, it } from 'vitest'
import { CONFIG_PRESETS, PRESET_TIMEOUT_MINUTES } from './AggregationOverridesForm'

describe('aggregation config presets', () => {
    it('gives every profile the same capacity floor', () => {
        for (const preset of CONFIG_PRESETS) {
            // Graph-store budget: sized against ONE shard, since a graph key
            // never spans shards. Must stay in step with the backend default
            // in falkordb_materialize._max_materialized_edges.
            expect(preset.tuning.maxMaterializedEdges, preset.id).toBe(16_000_000)
            // Worker RSS budget — independent of graph-store topology.
            expect(preset.tuning.maxPendingPairs, preset.id).toBe(50_000_000)
            expect(preset.timeoutMinutes, preset.id).toBe(PRESET_TIMEOUT_MINUTES)
        }
    })

    it('never forces full-detail rollup storage on any profile', () => {
        // `materializeFinePairs` is `boolean | undefined` and Auto is only
        // expressible by OMITTING the key. Setting it true would force the
        // full cube — the mode that OOMs a multi-million-edge instance.
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

    it('keeps the three profiles distinguishable, so the selector still means something', () => {
        const fingerprints = CONFIG_PRESETS.map(p => JSON.stringify([p.maxRetries, p.tuning]))
        expect(new Set(fingerprints).size).toBe(CONFIG_PRESETS.length)
    })
})
