/**
 * `inlineSearchHits` — which of the view search's hits render as virtual
 * rows under one container row, and how deep inside it each one sits.
 *
 * Three rules, each load-bearing:
 *
 *  - a hit that is ALREADY a loaded child of that row renders twice
 *    otherwise — once as the child it is, once as a hit — so it is dropped;
 *  - the breadcrumb is RELATIVE. The reader is looking at the container
 *    already; repeating the container's own ancestors says nothing, while
 *    the steps BELOW it are the whole answer to "where inside?";
 *  - the stack is capped. One container can hold every match in the view,
 *    and an unbounded list belongs in the panel, not spliced into a tree.
 */
import { describe, it, expect } from 'vitest'

import type { AncestorRef, SearchHit } from '@/types/search'

import { inlineSearchHits } from '../inlineSearchHits'


const ancestor = (urn: string): AncestorRef => ({
    urn,
    displayName: urn,
    entityType: 'container',
})

const hit = (urn: string, path: string[]): SearchHit => ({
    node: { urn, displayName: urn, entityType: 'dataset', properties: {} },
    ancestorPath: path.map(ancestor),
})


describe('inlineSearchHits', () => {
    it('drops loaded children, cuts the crumb to the part inside the row, and caps the rest', () => {
        // 52 hits live inside P and are not loaded under it (G1 plus 51
        // siblings), so 50 render and 2 become the overflow. C1 is a hit
        // AND a loaded child of P: it is already a row.
        const fillers = Array.from({ length: 51 }, (_, i) => hit(`F${i}`, ['P']))
        const hits = [hit('C1', ['P']), hit('G1', ['P', 'C2']), ...fillers]

        const { rows, overflow } = inlineSearchHits('P', hits, new Set(['C1']))

        expect(rows.map(r => r.hit.node.urn)).not.toContain('C1')
        expect(rows[0].hit.node.urn).toBe('G1')
        expect(rows[0].crumbs).toEqual([ancestor('C2')])
        expect(rows).toHaveLength(50)
        expect(overflow).toBe(2)
    })

    it('gives a hit sitting directly in the container no crumbs at all', () => {
        const { rows, overflow } = inlineSearchHits('P', [hit('D1', ['P'])], new Set())

        expect(rows).toHaveLength(1)
        expect(rows[0].crumbs).toEqual([])
        expect(overflow).toBe(0)
    })

    it('keeps the whole path when the container is not on it', () => {
        // Defensive: the server may return a hit whose ancestorPath was
        // truncated. Showing every step it DID send beats showing none.
        const { rows } = inlineSearchHits('P', [hit('X', ['Q', 'R'])], new Set())

        expect(rows[0].crumbs).toEqual([ancestor('Q'), ancestor('R')])
    })
})
