/**
 * localNodeIndex — the instant tier.
 *
 * Two properties matter here and nothing else does:
 *   1. It finds a node by every string a user might remember it by, not
 *      just its name (the old box read name + type, and nothing else).
 *   2. Every hit knows where it lives, because that ancestor path is what
 *      makes a collapsed container say "3 matches inside" — without it a
 *      deep match on a closed tree is invisible.
 */
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'

import {
    ancestorPathFor,
    buildLocalNodeIndex,
    matchLocalNodes,
    toSyntheticHit,
} from '../localNodeIndex'


function node(
    id: string,
    name: string,
    extra: Partial<HierarchyNode> = {},
): HierarchyNode {
    return {
        id, name,
        typeId: 'dataset',
        urn: id,
        data: {},
        children: [],
        depth: 0,
        entityTypeOption: 'dataset',
        tags: [],
        ...extra,
    } as HierarchyNode
}

const names = (hits: HierarchyNode[]) => hits.map((n) => n.name)


describe('buildLocalNodeIndex — what a node can be found by', () => {
    it('indexes the qualified name, description and business label', () => {
        const [doc] = buildLocalNodeIndex([node('a', 'orders', {
            data: {
                qualifiedName: 'warehouse.public.orders',
                description: 'Every completed purchase',
                businessLabel: 'Sales Ledger',
            },
        })])
        expect(doc.haystackLc).toContain('warehouse.public.orders')
        expect(doc.haystackLc).toContain('completed purchase')
        expect(doc.haystackLc).toContain('sales ledger')
        expect(doc.qnameLc).toBe('warehouse.public.orders')
    })

    it('indexes tags and entity type', () => {
        const [doc] = buildLocalNodeIndex([
            node('a', 'orders', { tags: ['PII', 'GDPR'], typeId: 'schemaField' }),
        ])
        expect(doc.haystackLc).toContain('pii')
        expect(doc.haystackLc).toContain('gdpr')
        expect(doc.haystackLc).toContain('schemafield')
    })

    it('indexes property KEYS as well as values', () => {
        // The server's denormalised searchableText carries values only, so
        // "which tables even have a pii_class?" is a question only this
        // tier can answer.
        const [doc] = buildLocalNodeIndex([node('a', 'orders', {
            data: { properties: { pii_class: 'EMAIL' } },
        })])
        expect(doc.haystackLc).toContain('pii_class')
        expect(doc.haystackLc).toContain('email')
    })

    it('indexes numeric and boolean property values as text', () => {
        const [doc] = buildLocalNodeIndex([node('a', 'orders', {
            data: { properties: { rowCount: 4200, nullable: false } },
        })])
        expect(doc.haystackLc).toContain('4200')
        expect(doc.haystackLc).toContain('false')
    })

    it('reads the legacy metadata bag as well as properties', () => {
        const [doc] = buildLocalNodeIndex([node('a', 'orders', {
            data: { metadata: { steward: 'finance-team' } },
        })])
        expect(doc.haystackLc).toContain('finance-team')
    })
})


describe('matchLocalNodes — the operators mirror the server', () => {
    const docs = buildLocalNodeIndex([
        node('a', 'revenue_gross'),
        node('b', 'net_revenue'),
        node('c', 'customer', { data: { description: 'holds revenue owner' } }),
        node('d', 'orders', { tags: ['revenue-critical'] }),
    ])

    it('contains matches anywhere in any indexed field', () => {
        const { hits } = matchLocalNodes(docs, 'revenue', 'contains', 'everything')
        expect(names(hits).sort())
            .toEqual(['customer', 'net_revenue', 'orders', 'revenue_gross'])
    })

    it('startsWith anchors to the beginning', () => {
        const { hits } = matchLocalNodes(docs, 'revenue', 'startsWith', 'names')
        expect(names(hits)).toEqual(['revenue_gross'])
    })

    it('exact wants the whole value', () => {
        expect(names(matchLocalNodes(docs, 'orders', 'exact', 'names').hits))
            .toEqual(['orders'])
        expect(matchLocalNodes(docs, 'order', 'exact', 'names').hits).toHaveLength(0)
    })

    it('narrows to descriptions when asked', () => {
        const { hits } = matchLocalNodes(docs, 'revenue', 'contains', 'descriptions')
        expect(names(hits)).toEqual(['customer'])
    })

    it('narrows to tags when asked', () => {
        const { hits } = matchLocalNodes(docs, 'revenue', 'contains', 'tags')
        expect(names(hits)).toEqual(['orders'])
    })

    it('ranks a name match above a description match', () => {
        const { hits } = matchLocalNodes(docs, 'revenue', 'contains', 'everything')
        expect(hits[0].name).toBe('revenue_gross')
    })

    it('is case-insensitive in both directions', () => {
        expect(matchLocalNodes(docs, 'REVENUE_GROSS', 'exact', 'names').hits)
            .toHaveLength(1)
    })

    it('returns nothing for an empty query', () => {
        expect(matchLocalNodes(docs, '   ', 'contains', 'everything').hits)
            .toHaveLength(0)
    })

    it('reports the pre-cap total so the panel can be honest about the cap', () => {
        const many = buildLocalNodeIndex(
            Array.from({ length: 50 }, (_, i) => node(`n${i}`, `revenue_${i}`)),
        )
        const { hits, total } = matchLocalNodes(many, 'revenue', 'contains', 'names', 10)
        expect(hits).toHaveLength(10)
        expect(total).toBe(50)
    })

    it('keeps a match the ranker does not weigh rather than dropping it', () => {
        // The hit is in a property key — real, but invisible to the
        // weighted fields. Silently discarding it would be the worst
        // possible answer.
        const docs2 = buildLocalNodeIndex([
            node('a', 'orders', { data: { properties: { pii_class: 'x' } } }),
        ])
        expect(matchLocalNodes(docs2, 'pii_class', 'contains', 'everything').hits)
            .toHaveLength(1)
    })
})


describe('ancestorPathFor — where a hit lives', () => {
    const root = node('root', 'SALES', { typeId: 'domain' })
    const mid = node('mid', 'Orders', { typeId: 'container', parentId: 'root' })
    const leaf = node('leaf', 'revenue', { parentId: 'mid' })
    const displayMap = new Map([root, mid, leaf].map((n) => [n.id, n]))

    it('returns the chain root-first, matching the wire contract', () => {
        const path = ancestorPathFor(leaf, new Map(), displayMap)
        expect(path.map((a) => a.displayName)).toEqual(['SALES', 'Orders'])
        expect(path[0].entityType).toBe('domain')
    })

    it('falls back to the containment map when the node has no parentId', () => {
        const orphanLeaf = node('leaf2', 'revenue')
        const path = ancestorPathFor(
            orphanLeaf,
            new Map([['leaf2', 'mid'], ['mid', 'root']]),
            displayMap,
        )
        expect(path.map((a) => a.displayName)).toEqual(['SALES', 'Orders'])
    })

    it('is empty for a top-level node', () => {
        expect(ancestorPathFor(root, new Map(), displayMap)).toEqual([])
    })

    it('terminates on a cycle instead of hanging the keystroke', () => {
        const x = node('x', 'X', { parentId: 'y' })
        const y = node('y', 'Y', { parentId: 'x' })
        const map = new Map([x, y].map((n) => [n.id, n]))
        expect(ancestorPathFor(x, new Map(), map).length).toBeLessThanOrEqual(2)
    })
})


describe('toSyntheticHit — one shape for both tiers', () => {
    it('carries the fields a result row renders', () => {
        const hit = toSyntheticHit(
            node('urn:a', 'revenue', {
                typeId: 'schemaField',
                tags: ['PII'],
                data: {
                    qualifiedName: 'db.public.revenue',
                    description: 'gross',
                    properties: { rowCount: 10 },
                },
            }),
            [{ urn: 'urn:p', displayName: 'Orders', entityType: 'container' }],
        )
        expect(hit.node.urn).toBe('urn:a')
        expect(hit.node.displayName).toBe('revenue')
        expect(hit.node.entityType).toBe('schemaField')
        expect(hit.node.qualifiedName).toBe('db.public.revenue')
        expect(hit.node.description).toBe('gross')
        expect(hit.node.tags).toEqual(['PII'])
        expect(hit.node.properties).toEqual({ rowCount: 10 })
        expect(hit.ancestorPath).toHaveLength(1)
    })

    it('falls back to the node id when a node carries no urn', () => {
        expect(toSyntheticHit(node('local-1', 'x', { urn: '' }), []).node.urn)
            .toBe('local-1')
    })
})
