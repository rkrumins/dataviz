import { describe, it, expect } from 'vitest'
import type { AggregationJobResponse } from '@/services/aggregationService'
import { runRecordText } from './runRecord'

const step = (over: Record<string, unknown> & { id: string }) => ({
    state: 'pending', started_at: null, ended_at: null, secs: 0, visits: 0,
    done: null, total: null, unit: null, waiting_for: null, ...over,
})

const job = (over: Record<string, unknown> = {}): AggregationJobResponse => ({
    id: 'agg_7f3',
    dataSourceId: 'ds-1',
    dataSourceLabel: 'Orders',
    status: 'failed',
    triggerSource: 'reconcile',
    reconcileReason: 'driftDetected',
    failureCategory: 'write_budget',
    progress: 80,
    totalEdges: 500_000,
    processedEdges: 500_000,
    createdEdges: 0,
    batchSize: 1000,
    resumable: true,
    retryCount: 2,
    maxRetries: 3,
    workerId: 'agg-worker-7',
    startedAt: '2026-09-12T09:00:00Z',
    completedAt: '2026-09-12T09:31:00Z',
    createdAt: '2026-09-12T08:59:00Z',
    durationSeconds: 1860,
    errorMessage: 'The shard had room for 120,000 more edges; this run needs 480,000.',
    runStats: {
        node: '10.0.0.3:6379',
        writes: 12_400,
        deletes: 8,
        pairs: 640_000,
        scanned_edges: 500_000,
        regime: 'cube',
        write_budget: { allowed_growth_edges: 120_000, governed_by: 'container' },
        effective_tuning: { scan_range_width: 200_000, sources: { scan_range_width: 'hint' } },
        adapted: { scan_width: 50_000, scan_shrinks: 3, pressure: [{ scan: 'x' }] },
        advisories: [{ kind: 'identity_unresolved', severity: 'error', message: 'No node carries urn.' }],
        steps: [
            step({ id: 'preparing', state: 'done', secs: 60 }),
            step({ id: 'extracting', state: 'done', secs: 300, done: 500_000, total: 500_000, unit: 'lineage edges' }),
            step({ id: 'applying', state: 'failed', secs: 1_500, done: 900, total: 1_200, unit: 'aggregated edges', visits: 2 }),
        ],
    },
    ...over,
} as unknown as AggregationJobResponse)

describe('runRecordText', () => {
    const text = runRecordText(job(), { label: 'Orders', graphName: 'gv_ds1' })

    it('identifies the run, the source, the graph and the node it wrote', () => {
        expect(text).toContain('Aggregation run agg_7f3')
        expect(text).toContain('Orders (ds-1)')
        expect(text).toContain('gv_ds1')
        expect(text).toContain('10.0.0.3:6379')
        expect(text).toContain('agg-worker-7')
    })

    it('carries the status with why it failed, and the retries it burned', () => {
        expect(text).toContain('failed (write_budget)')
        expect(text).toContain('reconcile — driftDetected')
        expect(text).toContain('2 of 3')
    })

    it('lays out every stage with its share and what it got through', () => {
        const apply = text.split('\n').find(l => l.trim().startsWith('Apply'))!
        expect(apply).toContain('failed')
        expect(apply).toContain('25m')          // 1,500s in the stage
        expect(apply).toContain('81%')          // of the run's 1,860s
        expect(apply).toContain('900 of 1,200 aggregated edges')
        expect(apply).toContain('(entered 2×)')
        // …and the stages it got through, in order, above it.
        const lines = text.split('\n').map(l => l.trim())
        expect(lines.indexOf('Stages')).toBeLessThan(lines.findIndex(l => l.startsWith('Prepare')))
        expect(lines.findIndex(l => l.startsWith('Prepare')))
            .toBeLessThan(lines.findIndex(l => l.startsWith('Apply')))
    })

    it('carries the result, the budget that governed it, and the settings', () => {
        expect(text).toContain('written       12,400')
        expect(text).toContain('120,000 edges (governed by container)')
        expect(text).toContain('Scan range width')
    })

    it('carries what the ladder adapted, skipping the nested pressure log', () => {
        expect(text).toContain('scan_width')
        expect(text).toContain('scan_shrinks')
        expect(text).not.toContain('pressure')
    })

    it('ends with the advisories and the error verbatim', () => {
        expect(text).toContain('[error] identity_unresolved: No node carries urn.')
        expect(text).toContain('this run needs 480,000.')
    })

    it('still says something useful for a run with no record at all', () => {
        const bare = runRecordText(job({ runStats: null, errorMessage: null }))
        expect(bare).toContain('Aggregation run agg_7f3')
        expect(bare).not.toContain('Stages')
        expect(bare).not.toContain('Error')
    })
})
