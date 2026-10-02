import { describe, it, expect, beforeEach } from 'vitest'

import { useSearchStore } from '../searchStore'


beforeEach(() => {
    useSearchStore.getState().clear()
})


describe('searchStore.setResult — ancestorCounts (server-exact) vs path rollup', () => {
    it('a server bucket overrides the page-derived rollup for that ancestor', () => {
        useSearchStore.getState().setResult({
            viewId: 'view-1',
            matchUrns: ['hit-1'],
            // A single hit's path rollup would only credit ancestor 'A'
            // with 1 match — the server's exact aggregation says 7.
            ancestorPaths: [
                {
                    path: [{ urn: 'A', displayName: 'A', entityType: 'domain' }],
                    leafEntityType: 'dataset',
                },
            ],
            ancestorCounts: [
                { urn: 'A', count: 7, breakdown: new Map([['dataset', 7]]) },
            ],
            queryHash: 'q1',
        })
        const s = useSearchStore.getState()
        expect(s.ancestorMatchCounts.get('A')).toBe(7)
        expect(s.ancestorMatchTypeBreakdowns.get('A')?.get('dataset')).toBe(7)
    })

    it('an ancestor the server sent no bucket for keeps its rollup count', () => {
        useSearchStore.getState().setResult({
            viewId: 'view-1',
            matchUrns: ['hit-1'],
            // The hit's path credits its parent 'A' AND its grandparent 'P'.
            ancestorPaths: [
                {
                    path: [
                        { urn: 'P', displayName: 'P', entityType: 'domain' },
                        { urn: 'A', displayName: 'A', entityType: 'table' },
                    ],
                    leafEntityType: 'column',
                },
            ],
            // The aggregation groups by immediate parent, so only 'A'
            // comes back with a bucket.
            ancestorCounts: [
                { urn: 'A', count: 7, breakdown: new Map([['column', 7]]) },
            ],
            queryHash: 'q3',
        })
        const s = useSearchStore.getState()
        expect(s.ancestorMatchCounts.get('A')).toBe(7)
        expect(s.ancestorMatchTypeBreakdowns.get('A')?.get('column')).toBe(7)
        // 'P' has no bucket, so it keeps what this page proved — otherwise
        // Isolate/Hide would drop a container that demonstrably has matches
        // under it.
        expect(s.ancestorMatchCounts.get('P')).toBe(1)
        expect(s.ancestorMatchTypeBreakdowns.get('P')?.get('column')).toBe(1)
    })

    it('drops the rollup breakdown of an ancestor the server counted', () => {
        useSearchStore.getState().setResult({
            viewId: 'view-1',
            matchUrns: ['hit-1'],
            ancestorPaths: [
                {
                    path: [{ urn: 'A', displayName: 'A', entityType: 'table' }],
                    leafEntityType: 'column',
                },
            ],
            // The request asks for no sub-aggregation, so a bucket arrives
            // with an exact count and no composition.
            ancestorCounts: [{ urn: 'A', count: 42 }],
            queryHash: 'q4',
        })
        const s = useSearchStore.getState()
        expect(s.ancestorMatchCounts.get('A')).toBe(42)
        // Keeping the page's `{column: 1}` here would put a breakdown
        // summing to 1 under a badge reading "42 matches inside this
        // subtree". A count with no composition is the honest answer.
        expect(s.ancestorMatchTypeBreakdowns.get('A')).toBeUndefined()
    })

    it('falls back to the page-derived rollup when ancestorCounts is omitted', () => {
        useSearchStore.getState().setResult({
            viewId: 'view-1',
            matchUrns: ['hit-1'],
            ancestorPaths: [
                {
                    path: [{ urn: 'A', displayName: 'A', entityType: 'domain' }],
                    leafEntityType: 'dataset',
                },
            ],
            queryHash: 'q1',
        })
        const s = useSearchStore.getState()
        expect(s.ancestorMatchCounts.get('A')).toBe(1)
        expect(s.ancestorMatchTypeBreakdowns.get('A')?.get('dataset')).toBe(1)
    })

    it('an ancestorCounts entry with no breakdown yields no breakdown entry', () => {
        useSearchStore.getState().setResult({
            viewId: 'view-1',
            matchUrns: ['hit-1'],
            ancestorCounts: [{ urn: 'B', count: 3 }],
            queryHash: 'q2',
        })
        const s = useSearchStore.getState()
        expect(s.ancestorMatchCounts.get('B')).toBe(3)
        expect(s.ancestorMatchTypeBreakdowns.has('B')).toBe(false)
    })
})


describe('searchStore — pendingSearchSeed removed', () => {
    it('has no pendingSearchSeed / setPendingSearchSeed / consumePendingSearchSeed', () => {
        const s = useSearchStore.getState() as unknown as Record<string, unknown>
        expect('pendingSearchSeed' in s).toBe(false)
        expect('setPendingSearchSeed' in s).toBe(false)
        expect('consumePendingSearchSeed' in s).toBe(false)
    })
})


// ---------------------------------------------------------------------------
// Keeping the user's place while pages land
// ---------------------------------------------------------------------------

/**
 * "Load all" walks the cursor to the end and republishes the merged match
 * set after EVERY page. Clearing the focused match on each of those wiped
 * the row the user had just picked — reported as results "jumping away, as
 * if they disappear". A continuation is not a new query, and `queryHash`
 * is what tells the two apart.
 */
describe('searchStore.setResult — the focused match survives pagination', () => {
    const publish = (matchUrns: string[], queryHash: string) =>
        useSearchStore.getState().setResult({
            viewId: 'view-1',
            matchUrns,
            ancestorPaths: [],
            ancestorCounts: undefined,
            queryHash,
        })

    it('keeps the focused match when a later page extends the same query', () => {
        publish(['a', 'b', 'c'], 'q1')
        useSearchStore.getState().setFocusedMatchIndex(1) // 'b'

        publish(['a', 'b', 'c', 'd', 'e'], 'q1')

        const s = useSearchStore.getState()
        expect(s.orderedMatchUrns[s.focusedMatchIndex!]).toBe('b')
    })

    it('follows the focused URN when the page changes its position', () => {
        publish(['a', 'b'], 'q1')
        useSearchStore.getState().setFocusedMatchIndex(1) // 'b'

        // A continuation whose ordering puts new urns ahead of 'b'.
        publish(['x', 'y', 'a', 'b'], 'q1')

        const s = useSearchStore.getState()
        expect(s.orderedMatchUrns[s.focusedMatchIndex!]).toBe('b')
    })

    it('drops the focus when a NEW query replaces the results', () => {
        publish(['a', 'b', 'c'], 'q1')
        useSearchStore.getState().setFocusedMatchIndex(1)

        publish(['p', 'q'], 'q2')

        expect(useSearchStore.getState().focusedMatchIndex).toBeNull()
    })

    it('drops the focus when the focused match is no longer in the results', () => {
        publish(['a', 'b', 'c'], 'q1')
        useSearchStore.getState().setFocusedMatchIndex(1) // 'b'

        publish(['a', 'c'], 'q1')

        expect(useSearchStore.getState().focusedMatchIndex).toBeNull()
    })

    it('leaves an unfocused list unfocused', () => {
        publish(['a', 'b'], 'q1')
        publish(['a', 'b', 'c'], 'q1')

        expect(useSearchStore.getState().focusedMatchIndex).toBeNull()
    })
})
