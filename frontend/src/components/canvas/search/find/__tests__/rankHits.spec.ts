/**
 * rankHits — one ordering rule for a list assembled from two sources.
 *
 * The backend has no relevance signal in v1: `sort: 'relevance'` falls back
 * to display name, and the page is the alphabetically-first N of that. The
 * local tier meanwhile ranks properly. Merged, that produced one list obeying
 * two rules, with the best match potentially below a worse one purely because
 * of which tier found it.
 */
import { describe, expect, it } from 'vitest'

import type { SearchHit } from '@/types/search'

import { rankHits } from '../rankHits'


function hit(
    displayName: string,
    extra: Partial<SearchHit['node']> = {},
): SearchHit {
    return {
        node: {
            urn: `urn:${displayName}`,
            entityType: 'dataset',
            displayName,
            properties: {},
            ...extra,
        },
    } as SearchHit
}

const names = (hits: readonly SearchHit[]) => hits.map((h) => h.node.displayName)


describe('rankHits', () => {
    it('lifts the exact match over the alphabetically-first one', () => {
        // Exactly the server's failure mode: it would return these in this
        // order and the user would never see `revenue` at the top.
        const ranked = rankHits(
            [hit('a_revenue_draft'), hit('b_revenue_old'), hit('revenue')],
            'revenue',
        )
        expect(names(ranked)[0]).toBe('revenue')
    })

    it('ranks a name match above a description match', () => {
        const ranked = rankHits(
            [hit('orders', { description: 'gross revenue by month' }), hit('revenue_net')],
            'revenue',
        )
        expect(names(ranked)).toEqual(['revenue_net', 'orders'])
    })

    it('ranks a prefix above a mid-word substring', () => {
        const ranked = rankHits([hit('gross_revenue'), hit('revenue_net')], 'revenue')
        expect(names(ranked)).toEqual(['revenue_net', 'gross_revenue'])
    })

    it('keeps a hit that scores zero rather than dropping it', () => {
        // The server can match on the denormalised searchableText — a
        // property value that never reaches the wire node. Dropping such a
        // row would turn a ranking change into lost results.
        const ranked = rankHits([hit('revenue_net'), hit('orders')], 'revenue')
        expect(names(ranked)).toEqual(['revenue_net', 'orders'])
        expect(ranked).toHaveLength(2)
    })

    it('is stable within equal scores, so local hits stay ahead', () => {
        const ranked = rankHits(
            [hit('revenue_a'), hit('revenue_b'), hit('revenue_c')],
            'revenue',
        )
        expect(names(ranked)).toEqual(['revenue_a', 'revenue_b', 'revenue_c'])
    })

    it('also weighs tags and qualified names', () => {
        expect(names(rankHits(
            [hit('orders'), hit('totals', { tags: ['revenue'] })], 'revenue',
        ))[0]).toBe('totals')
        expect(names(rankHits(
            [hit('orders'), hit('totals', { qualifiedName: 'db.revenue.totals' })],
            'revenue',
        ))[0]).toBe('totals')
    })

    it('returns the input untouched when there is nothing to rank', () => {
        const one = [hit('a')]
        expect(rankHits(one, 'x')).toBe(one)
        const two = [hit('a'), hit('b')]
        expect(rankHits(two, '  ')).toBe(two)
    })
})
