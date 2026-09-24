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
import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSearchStore } from '@/store/searchStore'
import type {
    Predicate,
    SearchAggregateBucket,
    SearchResultPage,
} from '@/types/search'

import { SEARCH_OPTIONS } from '@/components/canvas/search/searchOptions'

import { PROGRESS_WAIT_MS, useAdvancedSearch } from '../useAdvancedSearch'

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProvider: () => provider,
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

const searchAdvanced = vi.fn()
const searchAncestorCounts = vi.fn()
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
    typeCounts: { column: 42 },
}

function page(over: Partial<SearchResultPage>): SearchResultPage {
    return {
        elapsedMs: 1, candidateCount: 42, truncated: false,
        deadlineExceeded: false, cacheHit: false,
        ...over,
    } as SearchResultPage
}

/** A top-level container on the canvas: no containment edge points at
 *  it, so the old client-side hint would have called it a view root. */
function canvasNode(urn: string): LineageNode {
    return {
        id: urn,
        position: { x: 0, y: 0 },
        data: { label: urn, urn, type: 'table' },
    }
}

/** The scope the hook stamped onto the Nth request. */
function scopeOf(callIndex: number): Record<string, unknown> {
    return searchAdvanced.mock.calls[callIndex][0].scope
}

beforeEach(() => {
    searchAdvanced.mockReset()
    searchAncestorCounts.mockReset()
    useSearchStore.getState().clear()
    // `clear()` deliberately keeps the user's scope mode, so reset it here.
    useSearchStore.getState().setScopeMode('view')
    useCanvasStore.setState({ nodes: [], edges: [] })
    provider = Object.assign(
        Object.create(RemoteGraphProvider.prototype),
        { searchAdvanced, searchAncestorCounts },
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

    it('no longer treats a plain `parent` facet as ancestor counts', async () => {
        searchAdvanced.mockResolvedValue(page({
            hits: [HIT], aggregates: [[BUCKET]],
        }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, {
                ...SEARCH_OPTIONS,
                aggregations: [{ by: 'parent', maxBuckets: 200 }],
            })
        })

        // The facet is 'parent', not 'ancestor', so the bucket's 42 is
        // ignored and the store falls back to the page-derived rollup.
        expect(useSearchStore.getState().ancestorMatchCounts.get('A')).toBe(1)
    })
})


describe('useAdvancedSearch — exact counts for every loaded container', () => {
    // A facet of at most one bucket: A (42) is listed, B is left out.
    const OPTIONS = {
        ...SEARCH_OPTIONS,
        aggregations: [{ by: 'ancestor' as const, maxBuckets: 1, sampleHitsPerBucket: 0 }],
    }

    function container(urn: string): LineageNode {
        return { ...canvasNode(urn), data: { label: urn, urn, type: 'table', childCount: 3 } }
    }

    function finished(over: Partial<SearchResultPage> = {}): SearchResultPage {
        return page({
            hits: [HIT], aggregates: [[BUCKET]], status: 'complete', sessionId: 'sid-1', ...over,
        })
    }

    function counts(entries: Record<string, number>) {
        return {
            status: 'complete',
            counts: Object.fromEntries(Object.entries(entries).map(([urn, count]) => [urn, {
                count, typeCounts: { column: count }, displayName: urn, entityType: 'table',
            }])),
        }
    }

    it('reads the containers a full facet left out from the search session', async () => {
        useCanvasStore.setState({ nodes: [container('A'), container('B'), canvasNode('leaf')] })
        searchAdvanced.mockResolvedValue(finished())
        searchAncestorCounts.mockResolvedValue(counts({ B: 7 }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, OPTIONS)
        })

        await waitFor(() => expect(useSearchStore.getState().ancestorMatchCounts.get('B')).toBe(7))
        const [body] = searchAncestorCounts.mock.calls[0]
        // Only the containers the facet did not list — never a leaf.
        expect(body.urns).toEqual(['B'])
        expect(body.sessionId).toBe('sid-1')
        expect(body.scope.viewId).toBe('view-1')
        expect(useSearchStore.getState().ancestorMatchCounts.get('A')).toBe(42)
        expect(useSearchStore.getState().ancestorMatchTypeBreakdowns.get('B')?.get('column')).toBe(7)
    })

    it('does not ask when the facet already lists every container holding a match', async () => {
        useCanvasStore.setState({ nodes: [container('A'), container('B')] })
        searchAdvanced.mockResolvedValue(finished())

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, {
                ...OPTIONS, aggregations: [{ by: 'ancestor', maxBuckets: 5 }],
            })
        })
        await new Promise((r) => setTimeout(r, 250))
        expect(searchAncestorCounts).not.toHaveBeenCalled()
    })

    it('asks about containers that load later, each once', async () => {
        useCanvasStore.setState({ nodes: [container('A'), container('B')] })
        searchAdvanced.mockResolvedValue(finished())
        searchAncestorCounts.mockImplementation(async (body: { urns: string[] }) =>
            counts(Object.fromEntries(body.urns.map((u) => [u, 3]))))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, OPTIONS)
        })
        await waitFor(() => expect(searchAncestorCounts).toHaveBeenCalledTimes(1))

        act(() => {
            useCanvasStore.setState({ nodes: [container('A'), container('B'), container('C')] })
        })
        await waitFor(() => expect(searchAncestorCounts).toHaveBeenCalledTimes(2))
        expect(searchAncestorCounts.mock.calls[1][0].urns).toEqual(['C'])
        await waitFor(() => expect(useSearchStore.getState().ancestorMatchCounts.get('C')).toBe(3))

        act(() => {
            useCanvasStore.setState({ nodes: [container('A'), container('B'), container('C')] })
        })
        await new Promise((r) => setTimeout(r, 250))
        expect(searchAncestorCounts).toHaveBeenCalledTimes(2)
    })

    it('keeps the counts it read after loadMore', async () => {
        useCanvasStore.setState({ nodes: [container('A'), container('B')] })
        searchAdvanced.mockResolvedValueOnce(finished({ cursor: 'cursor-1' }))
        searchAdvanced.mockResolvedValueOnce(page({ hits: [] }))
        searchAncestorCounts.mockResolvedValue(counts({ B: 7 }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, OPTIONS)
        })
        await waitFor(() => expect(useSearchStore.getState().ancestorMatchCounts.get('B')).toBe(7))
        await act(async () => {
            await result.current.loadMore()
        })
        expect(useSearchStore.getState().ancestorMatchCounts.get('B')).toBe(7)
    })

    it('stops asking once the session has expired', async () => {
        useCanvasStore.setState({ nodes: [container('A'), container('B')] })
        searchAdvanced.mockResolvedValue(finished())
        searchAncestorCounts.mockResolvedValue({ status: 'expired', counts: {} })

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, OPTIONS)
        })
        await waitFor(() => expect(searchAncestorCounts).toHaveBeenCalledTimes(1))
        act(() => {
            useCanvasStore.setState({ nodes: [container('A'), container('B')] })
        })
        await new Promise((r) => setTimeout(r, 250))
        expect(searchAncestorCounts).toHaveBeenCalledTimes(1)
        expect(useSearchStore.getState().ancestorMatchCounts.get('B')).toBeUndefined()
    })
})


describe('useAdvancedSearch — the shared search options reach the wire', () => {
    it('sends the shared shape verbatim, asking for progressive answers', async () => {
        searchAdvanced.mockResolvedValue(page({ hits: [], aggregates: [[]] }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })

        expect(searchAdvanced).toHaveBeenCalledWith(
            expect.objectContaining({ options: { ...SEARCH_OPTIONS, waitMs: PROGRESS_WAIT_MS } }),
            { signal: expect.any(AbortSignal) },
        )
        expect(SEARCH_OPTIONS).toEqual({
            results: 'both',
            pageSize: 1000,
            aggregations: [{ by: 'ancestor', maxBuckets: 20000, sampleHitsPerBucket: 0 }],
            includeAncestorPath: true,
            candidateCap: 50000,
            softDeadlineMs: 20000,
        })
    })
})


describe('useAdvancedSearch — what the stamped scope carries', () => {
    it('sends no rootUrns in view mode: the server resolves the view roots', async () => {
        // Two unparented containers — the client used to walk exactly
        // these and ship them as the scope hint.
        useCanvasStore.setState({ nodes: [canvasNode('A'), canvasNode('B')], edges: [] })
        searchAdvanced.mockResolvedValue(page({ hits: [] }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })

        const scope = scopeOf(0)
        expect(scope.viewId).toBe('view-1')
        expect(scope.scopeMode).toBe('view')
        expect('rootUrns' in scope).toBe(false)
    })

    it('sends the canvas URNs in visible mode', async () => {
        useCanvasStore.setState({ nodes: [canvasNode('A'), canvasNode('B')], edges: [] })
        useSearchStore.getState().setScopeMode('visible')
        searchAdvanced.mockResolvedValue(page({ hits: [] }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })

        const scope = scopeOf(0)
        expect(scope.scopeMode).toBe('visible')
        expect(scope.visibleUrns).toEqual(['A', 'B'])
        expect('rootUrns' in scope).toBe(false)
    })
})


describe('useAdvancedSearch — a new run supersedes the one in flight', () => {
    it('aborts the first request and ignores its late answer', async () => {
        let answerFirst: (p: SearchResultPage) => void = () => {}
        searchAdvanced.mockImplementationOnce(
            () => new Promise<SearchResultPage>((resolve) => { answerFirst = resolve }),
        )
        searchAdvanced.mockResolvedValueOnce(page({
            hits: [{
                node: {
                    urn: 'hit-2', displayName: 'customer_name',
                    entityType: 'column', properties: {},
                },
            }],
        }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        let firstRun!: Promise<void>
        await act(async () => {
            firstRun = result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })

        // The request must be cancellable at all — the signal has to
        // reach the provider, not just the hook's own aborted-check.
        const firstSignal = searchAdvanced.mock.calls[0][1]?.signal as AbortSignal
        expect(firstSignal).toBeInstanceOf(AbortSignal)
        expect(firstSignal.aborted).toBe(false)

        await act(async () => {
            await result.current.runPredicate(
                { kind: 'group', op: 'and', children: [
                    { kind: 'text', target: 'any', match: 'substring', value: 'order' },
                ] },
                SEARCH_OPTIONS,
            )
        })
        expect(firstSignal.aborted).toBe(true)

        // The superseded request answers late. It owns nothing now.
        await act(async () => {
            answerFirst(page({ hits: [HIT] }))
            await firstRun
        })
        const view = result.current.view
        expect(view.kind).toBe('results')
        expect(view.kind === 'results' && view.result.hits?.[0]?.node?.urn).toBe('hit-2')
        expect(useSearchStore.getState().matchUrnSet.has('hit-1')).toBe(false)
    })
})


describe('useAdvancedSearch — a search still scanning the view', () => {
    const running = (over: Partial<SearchResultPage>) => page({
        status: 'running', sessionId: 's-1', countStatus: 'lowerBound',
        progress: { scanned: 40, total: 100, matched: 1 }, ...over,
    })

    it('shows each answer as it lands and continues the same session', async () => {
        const seen: string[][] = []
        searchAdvanced
            .mockResolvedValueOnce(running({ hits: [HIT] }))
            .mockImplementationOnce(async () => {
                seen.push([...useSearchStore.getState().matchUrnSet])
                return page({ hits: [HIT, { ...HIT, node: { ...HIT.node, urn: 'hit-2' } }],
                              status: 'complete', totalCount: 2, sessionId: 's-1' })
            })

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })

        // The first, provisional answer was already on the canvas while the
        // follow-up was in flight.
        expect(seen).toEqual([['hit-1']])
        const follow = searchAdvanced.mock.calls[1][0]
        expect(follow.options.sessionId).toBe('s-1')
        expect(follow.options.waitMs).toBe(PROGRESS_WAIT_MS)
        expect(follow.predicate).toEqual(searchAdvanced.mock.calls[0][0].predicate)
        const view = result.current.view
        expect(view.kind === 'results' && view.result.totalCount).toBe(2)
        expect(result.current.runState?.status).toBe('done')
        // The query the panel keeps (for later pages) carries no session.
        expect(view.kind === 'results' && view.query.options?.sessionId).toBeFalsy()
    })

    it('stops at the last answer, marked unfinished, when follow-ups keep failing', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        try {
            searchAdvanced
                .mockResolvedValueOnce(running({ hits: [HIT] }))
                .mockRejectedValue(new Error('429'))
            const { result } = renderHook(() => useAdvancedSearch('view-1'))
            await act(async () => {
                await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
            })
            const view = result.current.view
            expect(view.kind).toBe('results')
            expect(view.kind === 'results' && view.result.deadlineExceeded).toBe(true)
            expect(view.kind === 'results' && view.result.truncated).toBe(true)
            expect(view.kind === 'results' && view.result.hits?.length).toBe(1)
            expect(searchAdvanced).toHaveBeenCalledTimes(4)   // 1 + three attempts
        } finally {
            vi.useRealTimers()
        }
    })

    it('stops continuing a search a newer run replaced', async () => {
        let answerFollowUp: (p: SearchResultPage) => void = () => {}
        searchAdvanced
            .mockResolvedValueOnce(running({ hits: [HIT] }))
            .mockImplementationOnce(() => new Promise<SearchResultPage>((resolve) => {
                answerFollowUp = resolve
            }))
            .mockResolvedValueOnce(page({ hits: [], status: 'complete', totalCount: 0 }))

        const { result } = renderHook(() => useAdvancedSearch('view-1'))
        let first!: Promise<void>
        await act(async () => {
            first = result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })
        await act(async () => {
            await result.current.runPredicate(PREDICATE, { results: 'hits' })
        })
        await act(async () => {
            answerFollowUp(running({ hits: [HIT] }))
            await first
        })
        expect(searchAdvanced).toHaveBeenCalledTimes(3)
        const view = result.current.view
        expect(view.kind === 'results' && view.result.hits).toEqual([])
    })
})


describe('useAdvancedSearch — clearOnUnmount', () => {
    it('wipes the published matches on unmount by default', async () => {
        searchAdvanced.mockResolvedValue(page({ hits: [HIT] }))

        const { result, unmount } = renderHook(() => useAdvancedSearch('view-1'))
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })
        expect(useSearchStore.getState().matchUrnSet.size).toBe(1)

        unmount()
        expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
    })

    it('keeps them when clearOnUnmount is false', async () => {
        searchAdvanced.mockResolvedValue(page({ hits: [HIT] }))

        const { result, unmount } = renderHook(
            () => useAdvancedSearch('view-1', { clearOnUnmount: false }),
        )
        await act(async () => {
            await result.current.runPredicate(PREDICATE, SEARCH_OPTIONS)
        })

        unmount()
        expect(useSearchStore.getState().matchUrnSet.size).toBeGreaterThan(0)
        expect(useSearchStore.getState().matchUrnSet.has('hit-1')).toBe(true)
    })
})


/**
 * The session hands this whole object to the panel and re-exposes it on a
 * context. A fresh object literal every render would make the session
 * itself a fresh object every render, and every consumer of that context
 * would re-render on any canvas state change — so the identity has to
 * track the state, not the render.
 */
describe('useAdvancedSearch — stable identity', () => {
    it('returns the same object across a re-render with unchanged state', () => {
        const { result, rerender } = renderHook(() => useAdvancedSearch('view-1'))

        const first = result.current
        rerender()

        expect(result.current).toBe(first)
    })
})
