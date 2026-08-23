/**
 * "Most opened" ranks what is LOADED, and cannot do otherwise.
 *
 * Opens live in the product-event log and views in the catalogue, and this
 * repo bans cross-domain JOINs — so there is no `ORDER BY opens` for the list
 * endpoint to run, and the ranking is finished on the client from the usage
 * the page already fetched for its cards.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useOpensOrdering } from '../useOpensOrdering'
import type { ViewUsage } from '@/services/contentInsightsService'
import type { View } from '@/services/viewApiService'

const view = (id: string, name: string) => ({ id, name }) as View

const usage = (opens: number, uniqueViewers = 1): ViewUsage => ({
    viewId: 'x', opens, uniqueViewers, lastOpenedAt: null, trend: [],
    windowDays: 30, lifetimeOpens: opens, onlyAuthor: false,
    yourOpens: 0, yourLastOpenedAt: null,
})

const VIEWS = [view('a', 'Alpha'), view('b', 'Bravo'), view('c', 'Charlie')]

function order(map: Record<string, ViewUsage>, sort = 'most-opened' as const) {
    const { result } = renderHook(() => useOpensOrdering(VIEWS, map, sort))
    return result.current.map(v => v.id)
}

describe('useOpensOrdering', () => {
    it('ranks by opens, most first', () => {
        expect(order({ a: usage(3), b: usage(40), c: usage(12) }))
            .toEqual(['b', 'c', 'a'])
    })

    it('breaks a tie on how many people reached for it', () => {
        // Between two views opened the same number of times, the one more
        // people used is the better answer to "what does this team use".
        expect(order({ a: usage(10, 1), b: usage(10, 9), c: usage(1) }))
            .toEqual(['b', 'a', 'c'])
    })

    it('sorts a view with no usage yet LAST, not as a zero', () => {
        // Absent means "we have not been told". Ranking an unknown above a
        // genuine zero would be an ordering built on a loading state.
        expect(order({ a: usage(0), c: usage(5) })).toEqual(['c', 'a', 'b'])
    })

    it('falls back to name order when nothing is known at all', () => {
        expect(order({})).toEqual(['a', 'b', 'c'])
    })

    it('leaves every other sort exactly as the server returned it', () => {
        const { result } = renderHook(() => useOpensOrdering(VIEWS, { b: usage(99) }, 'az'))
        expect(result.current).toBe(VIEWS)
    })
})
