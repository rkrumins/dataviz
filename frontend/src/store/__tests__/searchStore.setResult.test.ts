import { describe, it, expect, beforeEach } from 'vitest'

import { useSearchStore } from '../searchStore'


beforeEach(() => {
    useSearchStore.getState().clear()
})


describe('searchStore.setResult — ancestorCounts (server-exact) vs path rollup', () => {
    it('ancestorCounts, when provided, replaces the page-derived rollup', () => {
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
