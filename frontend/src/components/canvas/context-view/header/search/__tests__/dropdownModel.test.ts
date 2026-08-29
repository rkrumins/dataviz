/**
 * The dropdown's arithmetic, away from the surface that renders it.
 *
 * Three questions the list has to answer about a hit — which ten of them
 * to show, WHY each one is in the list, and where it lives — and all
 * three are pure functions of the result page plus the text in the box.
 * The component only draws them.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_QUICK } from '@/components/canvas/search/session/quickPredicate'
import type { QuickQuery } from '@/components/canvas/search/session/quickPredicate'
import type { AncestorRef, SearchHit } from '@/types/search'

import {
    TOP_MATCHES, depthNote, formatPath, narrowingHints, topMatches, whyLabel,
} from '../dropdownModel'


function hit(displayName: string, highlights: { field: string; snippet: string }[] = []): SearchHit {
    return {
        node: { urn: `urn:${displayName}`, displayName, entityType: 'dataset', properties: {} },
        ancestorPath: [],
        highlights,
    } as unknown as SearchHit
}

function query(text: string): QuickQuery {
    return { ...DEFAULT_QUICK, text }
}

function anc(displayName: string): AncestorRef {
    return { urn: `urn:${displayName}`, displayName, entityType: 'container' }
}


describe('topMatches', () => {
    it('caps the list at ten', () => {
        const hits = Array.from({ length: 25 }, (_, i) => hit(`n${i}`))

        expect(topMatches(hits)).toHaveLength(TOP_MATCHES)
        expect(TOP_MATCHES).toBe(10)
    })

    it('keeps the server\'s order — the ranking is the backend\'s answer, not ours', () => {
        const hits = [hit('zebra'), hit('apple'), hit('mango')]

        expect(topMatches(hits).map((h) => h.node.displayName))
            .toEqual(['zebra', 'apple', 'mango'])
    })

    it('takes a smaller cap, and survives a page the server did not send', () => {
        expect(topMatches([hit('a'), hit('b'), hit('c')], 2)).toHaveLength(2)
        expect(topMatches(null)).toEqual([])
        expect(topMatches(undefined)).toEqual([])
    })
})


describe('whyLabel — the name tiers', () => {
    it('reads the whole name as an exact one, whatever the casing', () => {
        expect(whyLabel(hit('Orders'), query('orders')).label).toBe('Name is exactly')
    })

    it('reads a prefix as a prefix', () => {
        expect(whyLabel(hit('orders_daily'), query('orders')).label).toBe('Name starts with')
    })

    it('reads a separated word as a word', () => {
        expect(whyLabel(hit('daily_orders_v2'), query('orders')).label)
            .toBe('Name contains the word')
    })

    it('falls to the plain containment when the word runs into its neighbours', () => {
        expect(whyLabel(hit('reorders'), query('order')).label).toBe('Name contains')
    })

    it('answers about the name before it looks at any highlight', () => {
        const h = hit('orders_daily', [{ field: 'description', snippet: '…' }])

        expect(whyLabel(h, query('orders')).label).toBe('Name starts with')
    })
})


describe('whyLabel — the other fields', () => {
    it('names the description', () => {
        const h = hit('customers', [{ field: 'description', snippet: '…orders…' }])

        expect(whyLabel(h, query('orders'))).toEqual({
            label: 'In description', field: 'description',
        })
    })

    it('names a tag', () => {
        const h = hit('customers', [{ field: 'tags', snippet: 'orders' }])

        expect(whyLabel(h, query('orders')).label).toBe('Tag')
    })

    it('unwraps a property key', () => {
        const h = hit('customers', [{ field: 'property:owner', snippet: 'orders-team' }])

        expect(whyLabel(h, query('orders'))).toEqual({
            label: 'Property owner', field: 'property:owner',
        })
    })

    it('calls the qualified name the path, the way the rest of the UI does', () => {
        const h = hit('customers', [{ field: 'qualifiedName', snippet: 'db.orders.customers' }])

        expect(whyLabel(h, query('orders')).label).toBe('In path')
    })

    it('says only that it matched when the server sent no highlight at all', () => {
        expect(whyLabel(hit('customers'), query('orders')))
            .toEqual({ label: 'Matched', field: '' })
    })

    it('ignores the surrounding whitespace the box happily accepts', () => {
        expect(whyLabel(hit('orders'), query('  orders  ')).label).toBe('Name is exactly')
    })
})


describe('formatPath', () => {
    it('shows every crumb at three levels — an ellipsis would hide nothing', () => {
        const path = [anc('crm'), anc('public'), anc('customers')]
        const { crumbs, depth } = formatPath(path)

        expect(depth).toBe(3)
        expect(crumbs).toEqual([
            { ancestor: path[0], index: 0 },
            { ancestor: path[1], index: 1 },
            { ancestor: path[2], index: 2 },
        ])
    })

    // The index is the crumb's place in the WHOLE path, not in what
    // survived the elision: revealing a crumb slices the path with it,
    // and a renderer that recovered the number by searching the array
    // would hand back the wrong one for a repeated name.
    it('keeps the first and the last two, and elides the middle at four', () => {
        const path = [anc('crm'), anc('public'), anc('customers'), anc('columns')]
        const { crumbs } = formatPath(path)

        expect(crumbs).toEqual([
            { ancestor: path[0], index: 0 },
            { ellipsis: true },
            { ancestor: path[2], index: 2 },
            { ancestor: path[3], index: 3 },
        ])
    })

    it('takes its own head and tail', () => {
        const path = [anc('a'), anc('b'), anc('c'), anc('d'), anc('e')]

        expect(formatPath(path, { head: 2, tail: 1 })).toMatchObject({
            crumbs: [
                { ancestor: path[0], index: 0 },
                { ancestor: path[1], index: 1 },
                { ellipsis: true },
                { ancestor: path[4], index: 4 },
            ],
        })
    })

    it('spells the whole path out for the title, elided or not', () => {
        const path = [anc('crm'), anc('public'), anc('customers'), anc('columns')]

        expect(formatPath(path).full).toBe('crm › public › customers › columns')
    })

    it('has nothing to say about a top-level hit', () => {
        expect(formatPath([])).toEqual({ crumbs: [], depth: 0, full: '' })
    })
})


describe('depthNote', () => {
    it('stays quiet while the path is short enough to read', () => {
        expect(depthNote(0)).toBeNull()
        expect(depthNote(2)).toBeNull()
    })

    it('says how deep it is from three levels down', () => {
        expect(depthNote(3)).toBe('3 levels deep')
        expect(depthNote(6)).toBe('6 levels deep')
    })
})


describe('narrowingHints', () => {
    it('says nothing about a result set a person can actually read', () => {
        expect(narrowingHints(200, DEFAULT_QUICK)).toEqual([])
        expect(narrowingHints(0, DEFAULT_QUICK)).toEqual([])
        expect(narrowingHints(null, DEFAULT_QUICK)).toEqual([])
    })

    it('offers both ways in from two hundred and one', () => {
        expect(narrowingHints(201, DEFAULT_QUICK)).toEqual([
            { label: 'Names only', patch: { lookIn: 'name' } },
            { label: 'Starts with', patch: { match: 'prefix' } },
        ])
    })

    // A hint that is already on is not a hint — it is a button that does
    // nothing, offered at the exact moment the user is looking for help.
    it('drops the one the user has already taken', () => {
        expect(narrowingHints(5000, { ...DEFAULT_QUICK, lookIn: 'name' })).toEqual([
            { label: 'Starts with', patch: { match: 'prefix' } },
        ])
        expect(narrowingHints(5000, { ...DEFAULT_QUICK, match: 'prefix' })).toEqual([
            { label: 'Names only', patch: { lookIn: 'name' } },
        ])
    })

    it('has nothing left to suggest once both are narrowed', () => {
        expect(narrowingHints(5000, {
            ...DEFAULT_QUICK, lookIn: 'name', match: 'prefix',
        })).toEqual([])
    })
})
