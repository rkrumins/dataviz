/**
 * The knob catalogue is the one description of every tuning knob, and its
 * arithmetic is the pipeline's own — so a what-if in the UI moves the way
 * the next rebuild will decide.
 */
import { describe, expect, it } from 'vitest'
import type { AggregationTuning, EnvTuningDefaults } from '@/services/aggregationService'
import {
    KNOB_BY_KEY, TUNING_KNOBS, compactBytes, compactEdges, fitsEdges, freeAfterReserve, heldByRebuilds,
    fullDetailVerdict, knobPlaceholder, resolveKnob, serverCapNote,
    containerNeededBytes, fleetTimeoutCapMs, graphStoreLimitsPath,
} from './aggregationKnobs'

const GB = 2 ** 30

/** The numeric keys the server accepts in ``AggregationTuning``. */
const NUMERIC_TUNING_KEYS: (keyof AggregationTuning)[] = [
    'scanRangeWidth', 'maxPendingPairs', 'applyChunk', 'deleteChunk', 'writePacingRatio',
    'extractConcurrency', 'maxMaterializedEdges', 'shardReservePct', 'bytesPerEdge',
    'scanShrinkFloor', 'scanTimeoutS', 'writeTimeoutS', 'stallTimeoutSecs', 'maxWallSecs',
    'flushMemPct', 'maxCubeEdges', 'estimateMarginPct',
    'replicaAckMin', 'replicaAckTimeoutMs',
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
        expect([KNOB_BY_KEY.scanShrinkFloor.min, KNOB_BY_KEY.scanShrinkFloor.max]).toEqual([1, 5_000_000])
        expect([KNOB_BY_KEY.scanTimeoutS.min, KNOB_BY_KEY.scanTimeoutS.max]).toEqual([5, 600])
        expect([KNOB_BY_KEY.stallTimeoutSecs.min, KNOB_BY_KEY.stallTimeoutSecs.max]).toEqual([60, 604_800])
        expect([KNOB_BY_KEY.maxWallSecs.min, KNOB_BY_KEY.maxWallSecs.max]).toEqual([3_600, 604_800])
        // The stall window is a fleet default only: the per-job form already has it as the Stall timeout.
        expect(KNOB_BY_KEY.stallTimeoutSecs.fleetOnly).toBe(true)
        // The memory flush is a fleet default too, and bounded like the server.
        expect([KNOB_BY_KEY.flushMemPct.min, KNOB_BY_KEY.flushMemPct.max]).toEqual([30, 90])
        expect(KNOB_BY_KEY.flushMemPct.fleetOnly).toBe(true)
        // Auto's cube ceiling and the estimate margin: fleet defaults, bounded like the server.
        expect([KNOB_BY_KEY.maxCubeEdges.min, KNOB_BY_KEY.maxCubeEdges.max]).toEqual([10_000, 50_000_000])
        expect([KNOB_BY_KEY.estimateMarginPct.min, KNOB_BY_KEY.estimateMarginPct.max]).toEqual([0, 100])
        expect(KNOB_BY_KEY.maxCubeEdges.fleetOnly).toBe(true)
        expect(KNOB_BY_KEY.estimateMarginPct.fleetOnly).toBe(true)
        // Replication backpressure: a per-job knob too, because it is the
        // control an operator reaches for on a rebuild that is stalling a shard.
        expect([KNOB_BY_KEY.replicaAckMin.min, KNOB_BY_KEY.replicaAckMin.max]).toEqual([0, 5])
        expect([KNOB_BY_KEY.replicaAckTimeoutMs.min, KNOB_BY_KEY.replicaAckTimeoutMs.max]).toEqual([500, 60_000])
        expect(KNOB_BY_KEY.replicaAckMin.fleetOnly).toBeUndefined()
    })

    it('says when a per-query timeout is past the graph store’s own cap', () => {
        const env: EnvTuningDefaults = { serverTimeoutMaxMs: 180_000 }
        expect(serverCapNote(KNOB_BY_KEY.scanTimeoutS, 120, env)).toBeNull()
        expect(serverCapNote(KNOB_BY_KEY.scanTimeoutS, 300, env)).toMatch(/Capped by the graph store at 180 s/)
        expect(serverCapNote(KNOB_BY_KEY.writeTimeoutS, 300, env)).toMatch(/TIMEOUT_MAX/)
        // Not a per-query knob, no cap reported, or no value → nothing to say.
        expect(serverCapNote(KNOB_BY_KEY.maxWallSecs, 300, env)).toBeNull()
        expect(serverCapNote(KNOB_BY_KEY.scanTimeoutS, 300, {})).toBeNull()
        expect(serverCapNote(KNOB_BY_KEY.scanTimeoutS, null, env)).toBeNull()
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
        // What running rebuilds hold in the node's ledger comes off free memory as used memory does.
        expect(freeAfterReserve({ ...shard, reservedBytes: 2 * GB }, 20)).toBe(20 * GB)
        expect(heldByRebuilds({ reservedBytes: 2 * GB, reservedByJobs: 1 })).toBe('2.0 GB held by 1 running rebuild')
        expect(heldByRebuilds({ reservedBytes: 3 * GB, reservedByJobs: 2 })).toBe('3.0 GB held by 2 running rebuilds')
        expect(heldByRebuilds({ reservedBytes: 0, reservedByJobs: 0 })).toBeNull()
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

describe('the graph store’s own limits', () => {
    it('lets the cap read from the node win over the deployment mirror, and says where to raise it', () => {
        const env: EnvTuningDefaults = { serverTimeoutMaxMs: 180_000 }
        expect(serverCapNote(KNOB_BY_KEY.scanTimeoutS, 300, env, 600_000)).toBeNull()      // the node allows 600 s now
        expect(serverCapNote(KNOB_BY_KEY.scanTimeoutS, 300, env, 120_000)).toMatch(/at 120 s \(TIMEOUT_MAX, read from the node\)/)
        expect(serverCapNote(KNOB_BY_KEY.scanTimeoutS, 300, env, null)).toMatch(/from the deployment/)
        expect(serverCapNote(KNOB_BY_KEY.writeTimeoutS, 300, env)).toMatch(/Admin → Graph store/)
    })

    it('takes the lowest cap across the fleet’s shards', () => {
        const shards = (caps: (number | null)[]) =>
            ({ shards: caps.map(timeoutMaxMs => ({ timeoutMaxMs })) }) as unknown as Parameters<typeof fleetTimeoutCapMs>[0]
        expect(fleetTimeoutCapMs(shards([300_000, 120_000, null]))).toBe(120_000)
        expect(fleetTimeoutCapMs(shards([null]))).toBeNull()
        expect(fleetTimeoutCapMs(null)).toBeNull()
    })

    it('mirrors the server’s container formula', () => {
        const GB = 2 ** 30, MB = 2 ** 20
        expect(containerNeededBytes(6 * GB, 2, 512 * MB)).toBe(Math.floor(1.25 * 6 * GB) + 2 * Math.floor(1.3 * 512 * MB) + 256 * MB)
        expect(containerNeededBytes(32 * GB, 0, 1)).toBe(Math.floor(1.25 * 32 * GB) + 1 + GB)
    })

    it('links to a node’s limits with the endpoint encoded', () => {
        // Admin → Graph store is where a node is looked at, so it is where
        // its limits change; the Infrastructure page still answers the same
        // deep link for anything bookmarked before the page existed.
        expect(graphStoreLimitsPath('10.0.0.1:6379')).toBe('/admin/graph-store?limits=10.0.0.1%3A6379')
    })
})
