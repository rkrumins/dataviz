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
