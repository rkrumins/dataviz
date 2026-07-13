/**
 * The merge is where the old page's repetition gets fixed, so it gets pinned down:
 * one card per view, every badge that applies, and a timestamp that means what it
 * says.
 */
import { describe, it, expect } from 'vitest'
import { mergeWorkItems, filterWorkItems, countBadge, isStaleDraft, isPersonal } from './workItems'
import type { MostViewedEntry, MyDraftEntry, RecentViewEntry, View } from '@/services/viewApiService'

const NOW = new Date('2026-07-13T12:00:00Z').getTime()
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString()
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString()

const draft = (over: Partial<MyDraftEntry> & { viewId: string }): MyDraftEntry => ({
    draftId: `br_${over.viewId}`,
    graphId: 'gv_1',
    viewName: 'A View',
    viewType: 'reference',
    createdAt: daysAgo(3),
    updatedAt: hoursAgo(1),
    ...over,
} as MyDraftEntry)

const pin = (over: Partial<View> & { id: string }): View => ({
    name: 'A View',
    viewType: 'reference',
    workspaceId: 'ws_1',
    workspaceName: 'Finance',
    updatedAt: daysAgo(2),
    ...over,
} as View)

const recent = (over: Partial<RecentViewEntry> & { viewId: string }): RecentViewEntry => ({
    viewName: 'A View',
    viewType: 'reference',
    visitedAt: hoursAgo(3),
    ...over,
} as RecentViewEntry)

describe('mergeWorkItems', () => {
    it('renders a view ONCE even when it is a draft, a pin AND a recent', () => {
        const items = mergeWorkItems(
            [draft({ viewId: 'v1' })],
            [pin({ id: 'v1' })],
            [recent({ viewId: 'v1' })],
        )

        expect(items).toHaveLength(1)
        expect(items[0].badges.sort()).toEqual(['draft', 'pinned', 'recent'])
    })

    it('keeps every badge — the point is to dedupe cards, not to lose signal', () => {
        const items = mergeWorkItems([], [pin({ id: 'v1' })], [recent({ viewId: 'v1' })])
        expect(items[0].badges.sort()).toEqual(['pinned', 'recent'])
    })

    it('carries the draft id so the card can deep-link into the draft', () => {
        const items = mergeWorkItems([draft({ viewId: 'v1', draftId: 'br_abc' })], [], [])
        expect(items[0].draftId).toBe('br_abc')
    })

    it('leaves draftId undefined for a view with no unfinished work', () => {
        const items = mergeWorkItems([], [pin({ id: 'v1' })], [])
        expect(items[0].draftId).toBeUndefined()
    })

    it('a draft owns the timestamp: "Edited 1h ago" beats "opened 3h ago"', () => {
        const items = mergeWorkItems(
            [draft({ viewId: 'v1', updatedAt: hoursAgo(1) })],
            [],
            [recent({ viewId: 'v1', visitedAt: hoursAgo(3) })],
        )

        expect(items[0].timeVerb).toBe('Edited')
        expect(items[0].timestamp).toBe(hoursAgo(1))
    })

    it('orders unfinished work first, then by recency', () => {
        const items = mergeWorkItems(
            [draft({ viewId: 'old-draft', updatedAt: daysAgo(5) })],
            [],
            [recent({ viewId: 'fresh-visit', visitedAt: hoursAgo(1) })],
        )

        // The 5-day-old draft outranks the view opened an hour ago: one is
        // half-finished work, the other is a page you looked at.
        expect(items.map(i => i.viewId)).toEqual(['old-draft', 'fresh-visit'])
    })

    it('sorts by recency within the same group', () => {
        const items = mergeWorkItems([], [], [
            recent({ viewId: 'older', visitedAt: hoursAgo(9) }),
            recent({ viewId: 'newer', visitedAt: hoursAgo(2) }),
        ])
        expect(items.map(i => i.viewId)).toEqual(['newer', 'older'])
    })

    it('takes the workspace name from a later source when the draft had none', () => {
        // The drafts endpoint returns a workspace ID but no NAME. Views do not have
        // unique names — this instance has two "Data Lineage" — so without the
        // workspace the two cards are indistinguishable. Whichever source knows the
        // name, the merged item must end up carrying it.
        const items = mergeWorkItems(
            [draft({ viewId: 'v1' })],
            [pin({ id: 'v1', workspaceName: 'Finance' })],
            [],
        )
        expect(items[0].workspaceName).toBe('Finance')
    })

    it('keeps a NAMED draft\'s name, and leaves it undefined when unnamed', () => {
        const named = mergeWorkItems([draft({ viewId: 'v1', name: 'Q3 refactor' })], [], [])
        expect(named[0].draftName).toBe('Q3 refactor')

        const unnamed = mergeWorkItems([draft({ viewId: 'v2', name: undefined })], [], [])
        // Undefined, not "Unnamed draft" — the card decides how to phrase absence.
        expect(unnamed[0].draftName).toBeUndefined()
    })

    it('handles all three sources being empty', () => {
        expect(mergeWorkItems([], [], [])).toEqual([])
    })
})

const hot = (over: Partial<MostViewedEntry> & { viewId: string }): MostViewedEntry => ({
    name: 'A View',
    viewType: 'reference',
    workspaceId: 'ws_1',
    viewers: 3,
    opens: 9,
    lastOpenedAt: hoursAgo(1),
    ...over,
} as MostViewedEntry)

describe('popularity', () => {
    it('does NOT put a popular view you have never touched into "All"', () => {
        // Otherwise "Your work" quietly fills up with other people's favourites.
        const items = mergeWorkItems([], [], [], [hot({ viewId: 'team-fave' })])

        expect(items).toHaveLength(1)
        expect(isPersonal(items[0])).toBe(false)
        expect(filterWorkItems(items, 'all')).toHaveLength(0)
        expect(filterWorkItems(items, 'popular').map(i => i.viewId)).toEqual(['team-fave'])
    })

    it('decorates a view that IS yours with the popular badge, keeping it in "All"', () => {
        const items = mergeWorkItems(
            [draft({ viewId: 'v1' })], [], [], [hot({ viewId: 'v1', viewers: 5 })],
        )

        expect(items).toHaveLength(1)
        expect(items[0].badges.sort()).toEqual(['draft', 'popular'])
        expect(items[0].viewers).toBe(5)
        expect(filterWorkItems(items, 'all')).toHaveLength(1)
    })

    it('ranks the popular tab by PEOPLE, not by raw hits', () => {
        // One person opening something 80 times is not a recommendation.
        const items = mergeWorkItems([], [], [], [
            hot({ viewId: 'obsessive', viewers: 1, opens: 80 }),
            hot({ viewId: 'genuinely-popular', viewers: 6, opens: 12 }),
        ])

        expect(filterWorkItems(items, 'popular').map(i => i.viewId))
            .toEqual(['genuinely-popular', 'obsessive'])
    })

    it('breaks a viewer tie on total opens', () => {
        const items = mergeWorkItems([], [], [], [
            hot({ viewId: 'quieter', viewers: 3, opens: 4 }),
            hot({ viewId: 'busier', viewers: 3, opens: 30 }),
        ])

        expect(filterWorkItems(items, 'popular').map(i => i.viewId)).toEqual(['busier', 'quieter'])
    })

    it('keeps "All" as your work when the two lists overlap partly', () => {
        const items = mergeWorkItems(
            [draft({ viewId: 'mine' })],
            [],
            [],
            [hot({ viewId: 'mine' }), hot({ viewId: 'theirs' })],
        )

        expect(filterWorkItems(items, 'all').map(i => i.viewId)).toEqual(['mine'])
        expect(filterWorkItems(items, 'popular').map(i => i.viewId).sort()).toEqual(['mine', 'theirs'])
    })
})

describe('filterWorkItems / countBadge', () => {
    const items = mergeWorkItems(
        [draft({ viewId: 'v1' })],
        [pin({ id: 'v1' }), pin({ id: 'v2' })],
        [recent({ viewId: 'v3' })],
    )

    it('narrows to each subset', () => {
        expect(filterWorkItems(items, 'draft').map(i => i.viewId)).toEqual(['v1'])
        expect(filterWorkItems(items, 'pinned').map(i => i.viewId).sort()).toEqual(['v1', 'v2'])
        expect(filterWorkItems(items, 'recent').map(i => i.viewId)).toEqual(['v3'])
        expect(filterWorkItems(items, 'all')).toHaveLength(3)
    })

    it('counts a view under every badge it carries', () => {
        // v1 is both a draft and a pin — the tab counts must reflect that, or the
        // numbers won't add up to what the user sees when they click.
        expect(countBadge(items, 'draft')).toBe(1)
        expect(countBadge(items, 'pinned')).toBe(2)
        expect(countBadge(items, 'recent')).toBe(1)
    })
})

describe('isStaleDraft', () => {
    it('flags a draft untouched for over a week', () => {
        const items = mergeWorkItems([draft({ viewId: 'v1', updatedAt: daysAgo(9) })], [], [])
        expect(isStaleDraft(items[0], NOW)).toBe(true)
    })

    it('does NOT flag an old pin — only unfinished work goes stale', () => {
        const items = mergeWorkItems([], [pin({ id: 'v1', updatedAt: daysAgo(60) })], [])
        expect(isStaleDraft(items[0], NOW)).toBe(false)
    })

    it('does not flag a recent draft', () => {
        const items = mergeWorkItems([draft({ viewId: 'v1', updatedAt: daysAgo(2) })], [], [])
        expect(isStaleDraft(items[0], NOW)).toBe(false)
    })
})
