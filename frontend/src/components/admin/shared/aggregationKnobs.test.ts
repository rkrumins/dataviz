/**
 * The knob catalogue is the one description of every tuning knob, and its
 * arithmetic is the pipeline's own — so a what-if in the UI moves the way
 * the next rebuild will decide.
 */
import { describe, expect, it } from 'vitest'
import type { AggregationTuning, EnvTuningDefaults } from '@/services/aggregationService'
import {
    KNOB_BY_KEY, TUNING_KNOBS, compactBytes, compactEdges, fitsEdges, freeAfterReserve,
    fullDetailVerdict, knobPlaceholder, resolveKnob,
} from './aggregationKnobs'

const GB = 2 ** 30

/** The numeric keys the server accepts in ``AggregationTuning``. */
const NUMERIC_TUNING_KEYS: (keyof AggregationTuning)[] = [
    'scanRangeWidth', 'maxPendingPairs', 'applyChunk', 'deleteChunk', 'writePacingRatio',
    'extractConcurrency', 'maxMaterializedEdges', 'shardReservePct', 'bytesPerEdge',
]

describe('the knob catalogue', () => {
    it('describes every numeric tuning knob exactly once, with bounds the server enforces', () => {
        const keys = TUNING_KNOBS.map(k => k.key)
        expect(new Set(keys).size).toBe(keys.length)
        for (const key of NUMERIC_TUNING_KEYS) expect(keys, key).toContain(key)
        // Bounds mirror the backend schema (schemas.py AggregationTuning).
        expect([KNOB_BY_KEY.shardReservePct.min, KNOB_BY_KEY.shardReservePct.max]).toEqual([0, 90])
        expect([KNOB_BY_KEY.bytesPerEdge.min, KNOB_BY_KEY.bytesPerEdge.max]).toEqual([64, 16_384])
        expect([KNOB_BY_KEY.maxMaterializedEdges.min, KNOB_BY_KEY.maxMaterializedEdges.max]).toEqual([10_000, 500_000_000])
        expect([KNOB_BY_KEY.maxPendingPairs.min, KNOB_BY_KEY.maxPendingPairs.max]).toEqual([50_000, 50_000_000])
    })

    it('shows the server’s live env default as the placeholder, and what empty means for the ceiling', () => {
        const env: EnvTuningDefaults = { shardReservePct: 35, scanRangeWidth: 123_456 }
        expect(knobPlaceholder(KNOB_BY_KEY.shardReservePct, env)).toBe('35')
        expect(knobPlaceholder(KNOB_BY_KEY.scanRangeWidth, env)).toBe('123456')
        // No env reported → the shipped default, never a blank.
        expect(knobPlaceholder(KNOB_BY_KEY.shardReservePct, null)).toBe('20')
        // The ceiling's empty state is a meaning, not a number.
        expect(knobPlaceholder(KNOB_BY_KEY.maxMaterializedEdges, { maxMaterializedEdges: 25_000_000 })).toBe('shard governs')
    })

    it('resolves job → global → environment and names the source', () => {
        const env: EnvTuningDefaults = { shardReservePct: 20 }
        const global: AggregationTuning = { shardReservePct: 10 }
        expect(resolveKnob(KNOB_BY_KEY.shardReservePct, 5, global, env)).toEqual({ value: 5, source: 'job' })
        expect(resolveKnob(KNOB_BY_KEY.shardReservePct, null, global, env)).toEqual({ value: 10, source: 'global' })
        expect(resolveKnob(KNOB_BY_KEY.shardReservePct, undefined, {}, env)).toEqual({ value: 20, source: 'default' })
        // An unset ceiling resolves to "none": the shard governs.
        expect(resolveKnob(KNOB_BY_KEY.maxMaterializedEdges, null, {}, { maxMaterializedEdges: 25_000_000 }))
            .toEqual({ value: null, source: 'none' })
    })
})

describe('the capacity arithmetic', () => {
    const shard = { measurable: true, used: 10 * GB, maxmemory: 40 * GB }

    it('is the pipeline’s rule: free = maxmemory − reserve − used, edges = free / bytes', () => {
        expect(freeAfterReserve(shard, 20)).toBe(22 * GB)
        expect(fitsEdges(freeAfterReserve(shard, 20), 512)).toBe(Math.floor(22 * GB / 512))
        expect(freeAfterReserve({ measurable: false, used: null, maxmemory: null }, 20)).toBeNull()
        expect(fitsEdges(null, 512)).toBeNull()
    })

    it('charges growth over what the graph holds, with the margin, and never widens a ceiling', () => {
        const limits = { estimateMarginPct: 25 }
        const fits = fullDetailVerdict({ shard, limits, edgeCount: 2_000_000, estimateEdges: 10_000_000, bytesPerEdge: 512, reservePct: 20, ceiling: null })
        expect(fits.verdict).toBe('fits')
        expect(fits.growthEdges).toBe(8_000_000)
        expect(fits.neededBytes).toBe(8_000_000 * 512)

        const short = fullDetailVerdict({ shard: { ...shard, used: 40 * GB - 1024 }, limits, edgeCount: 0, estimateEdges: 1_000, bytesPerEdge: 512, reservePct: 0, ceiling: null })
        expect(short.verdict).toBe('short')
        expect(short.blockedBy).toBe('shard')
        expect(short.shortfallBytes).toBe(1_000 * 512 - 1024)

        const ceiling = fullDetailVerdict({ shard, limits, edgeCount: 0, estimateEdges: 30_000, bytesPerEdge: 512, reservePct: 20, ceiling: 10_000 })
        expect(ceiling.verdict).toBe('short')
        expect(ceiling.blockedBy).toBe('ceiling')

        expect(fullDetailVerdict({ shard, limits, edgeCount: 0, estimateEdges: null, bytesPerEdge: 512, reservePct: 20, ceiling: null }).verdict).toBe('unknown')
    })

    it('formats for prose', () => {
        expect(compactEdges(1_234_567)).toBe('1.2M')
        expect(compactEdges(12_345_678)).toBe('12M')
        expect(compactEdges(950)).toBe('950')
        expect(compactEdges(null)).toBe('—')
        expect(compactBytes(22 * GB)).toBe('22.0 GB')
        expect(compactBytes(512 * 1024)).toBe('512 KB')
    })
})
