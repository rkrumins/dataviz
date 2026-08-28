/**
 * Grouping results the way the canvas is arranged.
 *
 * The cases that matter are the ones where `ancestorPath[0]` is the
 * wrong answer: the server walks the full graph containment chain with
 * no knowledge of the view, so it can hand back a path that starts above
 * anything the canvas draws.
 */
import { describe, expect, it } from 'vitest'

import type { AncestorRef, SearchHit } from '@/types/search'

import {
    type CanvasRoot,
    OFF_CANVAS_KEY,
    groupHitsByTopLevel,
} from '../groupHitsByTopLevel'


function root(urn: string, name: string, layer = 'Warehouse'): CanvasRoot {
    return {
        urn, id: urn, displayName: name,
        entityType: 'container', layerName: layer, layerColor: '#0af',
    }
}

function anc(urn: string): AncestorRef {
    return { urn, displayName: urn, entityType: 'container' }
}

function hit(urn: string, path: string[]): SearchHit {
    return {
        node: { urn, entityType: 'dataset', displayName: urn, properties: {} },
        ancestorPath: path.map(anc),
    } as SearchHit
}


const ROOTS = new Map<string, CanvasRoot>([
    ['snowflake', root('snowflake', 'Snowflake')],
    ['commerce', root('commerce', 'Commerce', 'Source')],
])


describe('groupHitsByTopLevel', () => {
    it('groups under the top-level canvas node, not the immediate parent', () => {
        const groups = groupHitsByTopLevel([
            hit('dim_customer', ['snowflake', 'gold']),
            hit('customer_id', ['snowflake', 'gold', 'dim_orders']),
        ], ROOTS)

        expect(groups).toHaveLength(1)
        expect(groups[0].root?.displayName).toBe('Snowflake')
        expect(groups[0].hits).toHaveLength(2)
    })

    it('reports the root depth so rows can drop the repeated prefix', () => {
        // The server's path starts ABOVE the canvas: account > snowflake.
        const groups = groupHitsByTopLevel(
            [hit('dim_customer', ['account', 'snowflake', 'gold'])],
            ROOTS,
        )
        expect(groups[0].root?.urn).toBe('snowflake')
        expect(groups[0].depth).toBe(1)
    })

    it('resolves the OUTERMOST canvas root when the path holds several', () => {
        const roots = new Map(ROOTS)
        roots.set('gold', root('gold', 'GOLD'))
        const groups = groupHitsByTopLevel(
            [hit('dim_customer', ['snowflake', 'gold'])],
            roots,
        )
        expect(groups[0].root?.urn).toBe('snowflake')
        expect(groups[0].depth).toBe(0)
    })

    it('gives a matching top-level node its own group', () => {
        const groups = groupHitsByTopLevel([hit('snowflake', [])], ROOTS)
        expect(groups[0].root?.urn).toBe('snowflake')
        expect(groups[0].depth).toBe(0)
    })

    it('puts hits with no canvas root in an explicit off-canvas group', () => {
        const groups = groupHitsByTopLevel([
            hit('stray', ['somewhere_else']),
            hit('orphan', []),
        ], ROOTS)

        expect(groups).toHaveLength(1)
        expect(groups[0].key).toBe(OFF_CANVAS_KEY)
        expect(groups[0].root).toBeNull()
        expect(groups[0].depth).toBe(-1)
    })

    it('orders by size but pins the off-canvas group last', () => {
        const groups = groupHitsByTopLevel([
            hit('stray1', ['elsewhere']),
            hit('stray2', ['elsewhere']),
            hit('stray3', ['elsewhere']),
            hit('a', ['commerce']),
            hit('b', ['snowflake']),
            hit('c', ['snowflake']),
        ], ROOTS)

        expect(groups.map((g) => g.key)).toEqual([
            'snowflake', 'commerce', OFF_CANVAS_KEY,
        ])
    })

    it('degrades to a single off-canvas group when the canvas is empty', () => {
        const groups = groupHitsByTopLevel(
            [hit('a', ['snowflake']), hit('b', ['commerce'])],
            new Map(),
        )
        expect(groups).toHaveLength(1)
        expect(groups[0].hits).toHaveLength(2)
    })
})
