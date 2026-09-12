import { describe, expect, it } from 'vitest'
import type { FailureCategory, FreshnessRow } from '@/services/freshnessService'
import {
    FAILURE_CATEGORY_LABEL,
    asFailureCategory,
    countFailuresByCategory,
    failureBadgeLabel,
    failureBadgeWhy,
    graphStoreNodeFromReason,
    relatedFailureCount,
} from './failureGuidance'
import { matchesFailureFacet } from './freshnessTriage'

const row = (over: Partial<FreshnessRow>): FreshnessRow => ({
    dataSourceId: over.dataSourceId ?? 'ds',
    aggregationStatus: over.aggregationStatus ?? 'failed',
    lastFailureCategory: over.lastFailureCategory ?? null,
    ...over,
})

describe('graphStoreNodeFromReason', () => {
    it('finds the node in both messages a connection failure arrives as', () => {
        expect(graphStoreNodeFromReason(
            'the graph store node 10.0.0.3:6379 did not answer for 15 minute(s) during apply '
            + '(ConnectionError: Error 111 connecting to 10.0.0.3:6379. Connection refused.). '
            + 'The run keeps its checkpoint — Resume it once the node is back',
        )).toBe('10.0.0.3:6379')
        // The breaker's own text names no node; the reason it kept does.
        expect(graphStoreNodeFromReason(
            "Provider 'Warehouse' unavailable: Circuit open; will probe downstream again in ~28s. "
            + 'First failure: Error 111 connecting to falkordb-1.falkordb.svc.cluster.local:6379.',
        )).toBe('falkordb-1.falkordb.svc.cluster.local:6379')
    })

    it('does not mistake a clock time or an elapsed window for an address', () => {
        expect(graphStoreNodeFromReason('Job killed by watchdog: no progress for 30:00')).toBeNull()
        expect(graphStoreNodeFromReason('Held twice at 12:04')).toBeNull()
        expect(graphStoreNodeFromReason(null)).toBeNull()
    })
})

describe('failureGuidance', () => {
    it('names the cause on a failed row', () => {
        expect(failureBadgeLabel(row({ lastFailureCategory: 'out_of_memory' })))
            .toBe(FAILURE_CATEGORY_LABEL.out_of_memory)
        expect(failureBadgeLabel(row({ lastFailureCategory: null })))
            .toBe('Rebuild failed')
    })

    it('tallies causes for Start here and related links', () => {
        const rows = [
            row({ dataSourceId: 'a', lastFailureCategory: 'out_of_memory' }),
            row({ dataSourceId: 'b', lastFailureCategory: 'out_of_memory' }),
            row({ dataSourceId: 'c', lastFailureCategory: 'timeout' }),
            row({ dataSourceId: 'd', aggregationStatus: 'ready' }),
        ]
        expect(countFailuresByCategory(rows)).toEqual([
            { category: 'out_of_memory', count: 2 },
            { category: 'timeout', count: 1 },
        ])
        expect(relatedFailureCount(rows, 'out_of_memory', 'a')).toBe(1)
    })

    it('keeps query_memory distinct from out_of_memory', () => {
        // Two different ceilings with two different fixes: out_of_memory is
        // the store's maxmemory (free space or grow it), query_memory is the
        // per-query budget (make the rebuild read less). Collapsing them
        // would send operators to the wrong remedy — which is what the
        // provider_unavailable misclassification used to do.
        expect(failureBadgeLabel(row({ lastFailureCategory: 'query_memory' })))
            .toBe(FAILURE_CATEGORY_LABEL.query_memory)
        expect(FAILURE_CATEGORY_LABEL.query_memory)
            .not.toBe(FAILURE_CATEGORY_LABEL.out_of_memory)

        const rows = [
            row({ dataSourceId: 'a', lastFailureCategory: 'query_memory' }),
            row({ dataSourceId: 'b', lastFailureCategory: 'out_of_memory' }),
        ]
        expect(countFailuresByCategory(rows)).toEqual([
            { category: 'out_of_memory', count: 1 },
            { category: 'query_memory', count: 1 },
        ])
        expect(matchesFailureFacet(rows[0], 'query_memory')).toBe(true)
        expect(matchesFailureFacet(rows[0], 'out_of_memory')).toBe(false)
    })

    it('keeps a write-budget refusal distinct from running out of memory', () => {
        // Nothing broke: the rebuild measured the shard before writing and
        // refused because the rollups would not fit. Filing it under
        // out_of_memory would tell the operator the store failed, when the
        // message already says exactly how short the shard was.
        expect(asFailureCategory('write_budget')).toBe('write_budget')
        expect(failureBadgeLabel(row({ lastFailureCategory: 'write_budget' })))
            .toBe(FAILURE_CATEGORY_LABEL.write_budget)
        expect(FAILURE_CATEGORY_LABEL.write_budget)
            .not.toBe(FAILURE_CATEGORY_LABEL.out_of_memory)
        expect(failureBadgeWhy(row({ lastFailureCategory: 'write_budget' })))
            .toMatch(/refused before writing/)

        const rows = [
            row({ dataSourceId: 'a', lastFailureCategory: 'write_budget' }),
            row({ dataSourceId: 'b', lastFailureCategory: 'out_of_memory' }),
        ]
        expect(matchesFailureFacet(rows[0], 'write_budget')).toBe(true)
        expect(matchesFailureFacet(rows[0], 'out_of_memory')).toBe(false)
    })

    it('separates a dead worker from a timeout, and from the job at all', () => {
        // The worker process vanished — an evicted pod, an OOM kill. The
        // rebuild itself was healthy up to that instant and its checkpoint is
        // intact. Filed under 'timeout' it sends an operator to raise the
        // stall window, and no time limit brings back a dead pod; filed under
        // 'unknown' it says nothing at all. Both are where these used to go.
        expect(asFailureCategory('worker_lost')).toBe('worker_lost')
        expect(FAILURE_CATEGORY_LABEL.worker_lost)
            .not.toBe(FAILURE_CATEGORY_LABEL.timeout)
        expect(FAILURE_CATEGORY_LABEL.worker_lost)
            .not.toBe(FAILURE_CATEGORY_LABEL.unknown)
        expect(failureBadgeWhy(row({ lastFailureCategory: 'worker_lost' })))
            .toMatch(/disappeared/)

        const rows = [
            row({ dataSourceId: 'a', lastFailureCategory: 'worker_lost' }),
            row({ dataSourceId: 'b', lastFailureCategory: 'timeout' }),
        ]
        expect(matchesFailureFacet(rows[0], 'worker_lost')).toBe(true)
        expect(matchesFailureFacet(rows[0], 'timeout')).toBe(false)
    })

    it('says when nothing ever picked the rebuild up', () => {
        // Not a failure of the rebuild — it never ran. Retrying before a
        // worker is registered just queues another row nothing will claim,
        // so this needs its own label and its own remedy.
        expect(asFailureCategory('never_dispatched')).toBe('never_dispatched')
        expect(failureBadgeLabel(row({ lastFailureCategory: 'never_dispatched' })))
            .toBe(FAILURE_CATEGORY_LABEL.never_dispatched)
        expect(failureBadgeWhy(row({ lastFailureCategory: 'never_dispatched' })))
            .toMatch(/no worker ever picked it up/)
    })

    it('gives every category a label and a why', () => {
        // The guard that keeps a new backend category from rendering as a
        // raw slug: both records are typed Record<FailureCategory, string>,
        // so a missing key is a compile error — this pins that neither is
        // filled in with a placeholder.
        for (const [cat, label] of Object.entries(FAILURE_CATEGORY_LABEL)) {
            expect(label.length).toBeGreaterThan(0)
            expect(failureBadgeWhy(row({
                lastFailureCategory: cat as FailureCategory,
            })).length).toBeGreaterThan(20)
        }
    })
})

describe('matchesFailureFacet', () => {
    it('keeps healthy rows out of a cause filter', () => {
        expect(matchesFailureFacet(
            row({ aggregationStatus: 'ready', lastFailureCategory: null }),
            'out_of_memory',
        )).toBe(false)
        expect(matchesFailureFacet(
            row({ lastFailureCategory: 'out_of_memory' }),
            'out_of_memory',
        )).toBe(true)
        expect(matchesFailureFacet(row({ lastFailureCategory: 'timeout' }), '')).toBe(true)
    })
})
