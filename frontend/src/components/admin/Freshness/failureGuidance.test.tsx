import { describe, expect, it } from 'vitest'
import type { FreshnessRow } from '@/services/freshnessService'
import {
    FAILURE_CATEGORY_LABEL,
    countFailuresByCategory,
    failureBadgeLabel,
    relatedFailureCount,
} from './failureGuidance'
import { matchesFailureFacet } from './freshnessTriage'

const row = (over: Partial<FreshnessRow>): FreshnessRow => ({
    dataSourceId: over.dataSourceId ?? 'ds',
    aggregationStatus: over.aggregationStatus ?? 'failed',
    lastFailureCategory: over.lastFailureCategory ?? null,
    ...over,
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
