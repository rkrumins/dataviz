/**
 * Which aggregations still deserve a bucket CARD.
 *
 * The container roll-up (`by: 'parent'`, and `by: 'ancestor'` once the
 * backend ships it) exists to make the canvas badges and the panel's
 * container counts exact — up to 20 000 buckets of it. Painting that as
 * a card list would bury the results under a wall of folders that the
 * layer › container grouping below already shows, and shows better. So
 * on a canvas that has a session, those buckets are badge-only.
 *
 * The canvases whose only search IS the panel have no such grouping,
 * and their bucket cards are the orientation step — they keep every
 * facet.
 */
import { describe, expect, it } from 'vitest'

import type { SearchAggregateBucket, SearchQuery, SearchResultPage } from '@/types/search'

import { visibleFacetBuckets } from '../ResultsPane'


function bucket(urn: string): SearchAggregateBucket {
    return {
        ancestorUrn: urn,
        ancestorDisplayName: urn,
        ancestorEntityType: 'container',
        ancestorDepthFromScopeRoot: 0,
        matchCount: 1,
        sampleHits: [],
    }
}

const CONTAINERS = [bucket('C1'), bucket('C2')]
const TYPES = [bucket('dataset')]

function page(aggregates: SearchAggregateBucket[][]): SearchResultPage {
    return {
        aggregates, candidateCount: 3, truncated: false,
        deadlineExceeded: false, cacheHit: false, elapsedMs: 1,
    } as SearchResultPage
}

function query(...by: string[]): SearchQuery {
    return {
        predicate: { kind: 'text', target: 'any', match: 'substring', value: 'x' },
        options: { aggregations: by.map((b) => ({ by: b })) },
    } as unknown as SearchQuery
}


describe('visibleFacetBuckets', () => {
    it('drops the container roll-up when a session owns the grouping', () => {
        const buckets = visibleFacetBuckets(
            page([CONTAINERS, TYPES]), query('parent', 'entityType'), true,
        )

        expect(buckets).toEqual(TYPES)
    })

    it('drops the ancestor roll-up the same way', () => {
        const buckets = visibleFacetBuckets(
            page([CONTAINERS, TYPES]), query('ancestor', 'entityType'), true,
        )

        expect(buckets).toEqual(TYPES)
    })

    it('keeps every facet on a canvas with no session', () => {
        const buckets = visibleFacetBuckets(
            page([CONTAINERS, TYPES]), query('parent', 'entityType'), false,
        )

        expect(buckets).toEqual([...CONTAINERS, ...TYPES])
    })

    it('keeps buckets it cannot attribute to a spec', () => {
        // A response with more aggregate lists than the request declared:
        // unattributable is not the same as container-shaped, and silently
        // hiding them would lose facets.
        const buckets = visibleFacetBuckets(page([TYPES]), query(), true)

        expect(buckets).toEqual(TYPES)
    })
})
