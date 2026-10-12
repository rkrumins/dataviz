import { describe, expect, it } from 'vitest'

import type { TypeFeedState } from '@/store/canvas'

import { feedRemainder } from '../feedRemainder'

const feed = (hasMore: boolean, total?: number | null): TypeFeedState =>
    ({ entityTypes: [], offset: 200, hasMore, total })

describe('feedRemainder', () => {
    it("sums each open type's server total less what is loaded, ignoring a feed with no more", () => {
        expect(feedRemainder(
            ['dataset', 'container'],
            { dataset: feed(true, 12000), container: feed(false, 300) },
            new Map([['dataset', 200], ['container', 300]]),
        )).toBe(11800)
    })

    it('is unknown when a feed that still has more has no total', () => {
        expect(feedRemainder(
            ['dataset', 'container'],
            { dataset: feed(true, 12000), container: feed(true, null) },
            new Map(),
        )).toBeNull()
        expect(feedRemainder(['dataset'], { dataset: feed(true) }, new Map())).toBeNull()
    })

    it('is never negative', () => {
        expect(feedRemainder(['dataset'], { dataset: feed(true, 100) }, new Map([['dataset', 250]]))).toBe(0)
    })

    it('matches a feed to its loaded rows case-insensitively', () => {
        expect(feedRemainder(['Dataset'], { Dataset: feed(true, 500) }, new Map([['dataset', 200]]))).toBe(300)
    })
})
