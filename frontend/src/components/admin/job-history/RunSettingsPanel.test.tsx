/**
 * Every run shows what it ran with — each knob, its value and where it came
 * from — and what its pressure ladder adapted to; a run without the record
 * falls back to its frozen tuning, and a clean run says so plainly.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AggregationJobResponse } from '@/services/aggregationService'
import { RunSettingsPanel } from './RunSettingsPanel'
import { adaptationSentences, presetForRun, runSettingsRows } from './runSettings'

const EFFECTIVE = {
    scan_range_width: 200_000, max_pending_pairs: 50_000_000, apply_chunk: 20_000, delete_chunk: 10_000,
    write_pacing_ratio: 1.0, extract_concurrency: 1, materialize_leaf_pairs: false, materialize_fine_pairs: 'true',
    max_materialized_edges: null, shard_reserve_pct: 20, bytes_per_edge: 640, scan_shrink_floor: 1,
    scan_timeout_s: 30, write_timeout_s: 60, ignore_observed: false,
    stall_timeout_secs: 10_800, max_wall_secs: 86_400, max_retries: 3,
    sources: {
        scan_range_width: 'job', max_pending_pairs: 'job', apply_chunk: 'env', delete_chunk: 'env',
        write_pacing_ratio: 'job', extract_concurrency: 'job', materialize_leaf_pairs: 'env',
        materialize_fine_pairs: 'env', max_materialized_edges: 'env', shard_reserve_pct: 'job',
        bytes_per_edge: 'hint', scan_shrink_floor: 'env', scan_timeout_s: 'env', write_timeout_s: 'env',
        ignore_observed: 'env', stall_timeout_secs: 'job', max_wall_secs: 'env', max_retries: 'job',
    },
}

function job(over: Partial<AggregationJobResponse> = {}): AggregationJobResponse {
    return {
        id: 'agg_1', dataSourceId: 'ds-1', status: 'completed', triggerSource: 'manual', progress: 100,
        totalEdges: 10, processedEdges: 10, createdEdges: 4, batchSize: 1000, resumable: false, retryCount: 0,
        createdAt: '2026-09-09T10:00:00Z', ...over,
    } as AggregationJobResponse
}

describe('runSettingsRows', () => {
    it('labels every value by where it came from, and a job value equal to the fleet default as the fleet default', () => {
        const rows = runSettingsRows(EFFECTIVE, { shardReservePct: 20, scanRangeWidth: 100_000 })
        const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
        expect(byKey.scan_range_width).toMatchObject({ value: '200,000', source: 'job' })
        expect(byKey.shard_reserve_pct).toMatchObject({ value: '20%', source: 'global' })
        expect(byKey.bytes_per_edge).toMatchObject({ value: '640 B', source: 'hint' })
        expect(byKey.apply_chunk).toMatchObject({ value: '20,000', source: 'env' })
        expect(byKey.max_materialized_edges.value).toBe('Shard governs')
        expect(byKey.materialize_fine_pairs.value).toBe('Full detail')
        expect(byKey.stall_timeout_secs).toMatchObject({ value: '3h', source: 'job' })
        expect(byKey.scan_timeout_s.value).toBe('30 s')
        expect(byKey.ignore_observed).toBeUndefined()          // only shown when set
        expect(rows.map(r => r.key)[0]).toBe('scan_range_width')
    })
})

describe('presetForRun', () => {
    it('names the profile a run matches and null for a custom mix', () => {
        expect(presetForRun(EFFECTIVE)).toBe('Balanced')
        expect(presetForRun({ ...EFFECTIVE, scan_range_width: 123_456 })).toBeNull()
        expect(presetForRun(null)).toBeNull()
    })
})

describe('adaptationSentences', () => {
    it('says what the ladder changed, in plain words', () => {
        const s = adaptationSentences({
            scan_width_min: 12_500, scan_shrinks: 3, extract_concurrency: 1, reconcile_strategy: 'keys_only',
            write_batch_min: 60, write_shrinks: 2, timeout_retries: 4, budget_rechecks: 2,
            by_scan: { 'reconcile:AGGREGATED': { events: 2, min_size: 12_500, kind: 'memory' }, 'extract:FLOWS': { events: 1, min_size: 50_000, kind: 'timeout' } },
        }, { bytesPerEdgeObserved: 640 })
        expect(s).toEqual([
            'Scans narrowed to 12,500 rows after 3 shrinks (reconcile:AGGREGATED, extract:FLOWS)',
            'Read concurrency dropped to 1',
            'Reconcile switched to keys-only (two passes)',
            'Write batch shrank to 60 rows after 2 shrinks',
            '4 timeout retries at the narrowest width',
            'Shard re-measured 2× during the apply',
            'Calibrated 640 B per rollup edge',
        ])
    })

    it('credits the last run for what it started from, and says nothing for a clean run', () => {
        expect(adaptationSentences({ from_last_run: { scan_width: 12_500, extract_concurrency: 1 }, extract_concurrency: 1 }))
            .toEqual(['Started from what the last run learned: scans at 12,500, serial reads'])
        expect(adaptationSentences(null)).toEqual([])
    })
})

describe('RunSettingsPanel', () => {
    it('renders the record for a completed run with its profile and adaptation', () => {
        render(<RunSettingsPanel job={job({ runStats: { effective_tuning: EFFECTIVE, adapted: { scan_width_min: 12_500, scan_shrinks: 3 }, bytes_per_edge_observed: 640 } })} />)
        const panel = screen.getByTestId('run-settings-panel')
        expect(within(panel).getByText('Balanced profile')).toBeInTheDocument()
        expect(within(panel).getByText('Scan range width')).toBeInTheDocument()
        expect(within(panel).getByText('Learned from last run')).toBeInTheDocument()
        expect(within(panel).getByText('Scans narrowed to 12,500 rows after 3 shrinks')).toBeInTheDocument()
        expect(within(panel).getByText('Calibrated 640 B per rollup edge')).toBeInTheDocument()
    })

    it('says a clean run ran at its settings, and reads the live overlay first while running', () => {
        render(<RunSettingsPanel job={job({ runStats: { effective_tuning: EFFECTIVE } })} />)
        expect(screen.getByText('Nothing — ran at its settings')).toBeInTheDocument()

        render(<RunSettingsPanel
            job={job({ status: 'running', runStats: { effective_tuning: EFFECTIVE, adapted: { scan_width: 50_000, scan_width_min: 50_000 } } })}
            live={{ scan_width: 25_000, scan_width_min: 25_000, extract_concurrency: 1 }}
        />)
        expect(screen.getByText('Adapting during the run')).toBeInTheDocument()
        expect(screen.getByText('Scans narrowed to 25,000 rows')).toBeInTheDocument()
        expect(screen.getByText('Read concurrency dropped to 1')).toBeInTheDocument()
    })

    it('falls back to the frozen tuning for a legacy row, labelled as such', () => {
        render(<RunSettingsPanel job={job({ tuning: { scan_range_width: 100_000, write_pacing_ratio: 2 } })} />)
        expect(screen.getByText('Legacy record')).toBeInTheDocument()
        expect(screen.getAllByText('Frozen tuning')).toHaveLength(2)
        expect(screen.getByText('×2')).toBeInTheDocument()
    })
})

describe('adaptationSentences — changed while running', () => {
    it('says what an operator changed on the running job', () => {
        expect(adaptationSentences({ live: { write_pacing_ratio: 2, extract_concurrency: 1, scan_width: 5_000, scan_timeout_s: 120 } }))
            .toContain('Changed while running: pacing 2×, serial reads, scans capped at 5,000 rows, scan timeout 120 s')
        expect(adaptationSentences({ live: { write_pacing_ratio: 0 } })).toContain('Changed while running: no pacing')
        expect(adaptationSentences({ live: {} })).toEqual([])
    })
})

describe('adaptationSentences — replicas and a node that went away', () => {
    it('says the run paced itself against the replicas, and how far behind they got', () => {
        expect(adaptationSentences({ replica_holds: 12, replica_wait_s: 204, replica_max_lag_bytes: 1_288_490_188 }))
            .toContain('Waited for the graph store’s replicas 12 times (3m 24s in total, up to 1.2 GB behind)')
        // Acknowledged every time: no hold, so the sentence is not a warning.
        expect(adaptationSentences({ replica_waits: 40, replica_wait_s: 2 }))
            .toContain('Paced against the graph store’s replicas (2s in total)')
    })

    it('says which node went away, for how long, and that the run kept its place', () => {
        const s = adaptationSentences({
            store_outage_holds: 2, store_outage_s: 92,
            node_restarts: [{ endpoint: '10.0.0.3:6379', at: '2026-09-09T12:04:00Z', uptime_s: 12 }],
        })
        expect(s.some(line => /^Held 2 times while 10\.0\.0\.3:6379 was unreachable \(1m 32s\) — it restarted at \d{1,2}:\d{2}/.test(line))).toBe(true)
        // Waited but nothing proved a restart: no claim that one happened.
        expect(adaptationSentences({ store_outage_holds: 1, store_outage_s: 30 }))
            .toEqual(['Held 1 time while the graph store node was unreachable (30s)'])
    })
})

describe('adaptationSentences — the write governor', () => {
    it('says how often the run held a batch for the node, why, and for how long', () => {
        expect(adaptationSentences({ store_holds: { fork: 2, replica_lost: 1 }, store_hold_s: { fork: 190, replica_lost: 70 } }))
            .toContain('Held the next write batch 3 times for the graph store node (a fork in flight 2×, replicas gone 1×; 4m 20s in total)')
        // A reason the panel does not know yet is still named, never dropped.
        expect(adaptationSentences({ store_holds: { loading: 1, eclipse: 1 } }))
            .toContain('Held the next write batch 2 times for the graph store node (the node loading 1×, eclipse 1×)')
        expect(adaptationSentences({ store_holds: {} })).toEqual([])
    })
})

describe('adaptationSentences — worker memory', () => {
    it('says how often the run flushed on memory, with the peak against the limit', () => {
        expect(adaptationSentences({ memory_flushes: 3, rss_high_water_mb: 2_970, mem_limit_mb: 4_096 }))
            .toContain('Flushed 3× on worker memory (peak 2.9 GB of 4.0 GB)')
        expect(adaptationSentences({ memory_rollups: 2, rss_high_water_mb: 512 }))
            .toContain('Rolled up early 2× on worker memory (peak 512 MB)')
    })
})
