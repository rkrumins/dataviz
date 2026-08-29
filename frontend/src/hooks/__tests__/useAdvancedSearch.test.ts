/**
 * useAdvancedSearch — what a run publishes to the search store.
 *
 * The contract under test is the container badge ("N matches inside"):
 * it must read the server's aggregation, which counts the WHOLE
 * candidate set, not the ancestor paths of the hits that happen to be
 * on the current page. The two are trivially told apart — one hit whose
 * path names container `A` rolls up to 1; the bucket says 42.
 *
 * The same must hold after `loadMore`: page 2 carries no aggregates
 * (the hook drops them from the follow-up query), so the counts have to
 * be recomputed from the MERGED result, which retains page 1's.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type {
    Predicate,
    SearchAggregateBucket,
    SearchResultPage,
} from '@/types/search'

import { SEARCH_OPTIONS } from '@/components/canvas/search/searchOptions'

import { useAdvancedSearch } from '../useAdvancedSearch'

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProvider: () => provider,
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

const searchAdvanced = vi.fn()
// `instanceof RemoteGraphProvider` gates every run, so the stub has to
// carry the real prototype — the hook refuses to talk to anything else.
let provider: RemoteGraphProvider

const PREDICATE: Predicate = {
    kind: 'group',
    op: 'and',
    children: [{ kind: 'text', target: 'any', match: 'substring', value: 'cust' }],
}

/** One hit inside container `A` — the single-hit rollup the aggregation
 *  has to beat. */
const HIT = {
    node: {
        urn: 'hit-1', displayName: 'customer_id',
        entityType: 'column', properties: {},
    },
    ancestorPath: [{ urn: 'A', displayName: 'A', entityType: 'table' }],
}

const BUCKET: SearchAggregateBucket = {
    ancestorUrn: 'A',
    ancestorDisplayName: 'A',
    ancestorEntityType: 'table',
    ancestorDepthFromScopeRoot: 0,
    matchCount: 42,
    sampleHits: [],
    subBuckets: [{
        ancestorUrn: 'A',
        ancestorDisplayName: 'A',
        ancestorEntityType: 'column',
        ancestorDepthFromScopeRoot: 1,
        matchCount: 42,
        sampleHits: [],
    }],
}

function page(over: Partial<SearchResultPage>): SearchResultPage {
    return {
        elapsedMs: 1, candidateCount: 42, truncated: false,
        deadlineExceeded: false, cacheHit: false,
        ...over,
    } as SearchResultPage
}

beforeEach(() => {
    searchAdvanced.mockReset()
    useSearchStore.getState().clear()
    provider = Object.assign(
        Object.create(RemoteGraphProvider.prototype),
        { searchAdvanced },
    ) as RemoteGraphProvider
})


describe('useAdvancedSearch — exact ancestor counts from the aggregation', () => {
    it('publishes the bucket count, not the page-derived rollup', async () => {
        searchAdvanced.mockResolvedValue(page({
            hits: [HIT], aggregates: [[BUCKET]],
        }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })

        const s = useSearchStore.getState()
        expect(s.ancestorMatchCounts.get('A')).toBe(42)
        expect(s.ancestorMatchTypeBreakdowns.get('A')?.get('column')).toBe(42)
    })

    it('keeps the exact count after loadMore, whose page has no aggregates', async () => {
        searchAdvanced.mockResolvedValueOnce(page({
            hits: [HIT], aggregates: [[BUCKET]], cursor: 'cursor-1',
        }))
        searchAdvanced.mockResolvedValueOnce(page({
            hits: [{
                node: {
                    urn: 'hit-2', displayName: 'customer_name',
                    entityType: 'column', properties: {},
                },
                ancestorPath: [{ urn: 'A', displayName: 'A', entityType: 'table' }],
            }],
        }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })
        await act(async () => {
            await result.current.loadMore()
        })

        expect(searchAdvanced).toHaveBeenCalledTimes(2)
        expect(useSearchStore.getState().matchUrnSet.has('hit-2')).toBe(true)
        expect(useSearchStore.getState().ancestorMatchCounts.get('A')).toBe(42)
    })

    it('falls back to the path rollup when the run asked for no aggregation', async () => {
        searchAdvanced.mockResolvedValue(page({ hits: [HIT] }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, { results: 'hits' })
        })

        expect(useSearchStore.getState().ancestorMatchCounts.get('A')).toBe(1)
    })
})


describe('useAdvancedSearch — the shared search options reach the wire', () => {
    it('sends the shared shape verbatim', async () => {
        searchAdvanced.mockResolvedValue(page({ hits: [], aggregates: [[]] }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })

        expect(searchAdvanced).toHaveBeenCalledWith(
            expect.objectContaining({ options: SEARCH_OPTIONS }),
        )
        expect(SEARCH_OPTIONS).toEqual({
            results: 'both',
            pageSize: 1000,
            aggregations: [{ by: 'parent', maxBuckets: 200, sampleHitsPerBucket: 3 }],
            includeAncestorPath: true,
            candidateCap: 50000,
            softDeadlineMs: 20000,
        })
    })
})
