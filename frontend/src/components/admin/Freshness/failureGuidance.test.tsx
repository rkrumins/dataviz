import { describe, expect, it } from 'vitest'
import type { FreshnessRow } from '@/services/freshnessService'
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
