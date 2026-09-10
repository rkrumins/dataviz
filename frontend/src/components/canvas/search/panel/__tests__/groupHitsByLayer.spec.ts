/**
 * The results panel's "where do these live?" grouping.
 *
 * Two rules carry the whole feature, and both are easy to get wrong:
 *
 *   * a container's count comes from the SERVER's per-ancestor
 *     aggregation, not from how many of its hits happen to be on this
 *     page — "40 matches" under a container showing 2 rows is the
 *     honest answer, and the page rollup would say "2";
 *   * a hit whose chain touches no layer of this view is not dropped.
 *     It lands in "Not on this canvas", last, so the count in the
 *     header and the rows in the body agree.
 */
import { describe, expect, it } from 'vitest'

import type { SearchHit } from '@/types/search'
import type { ViewLayerConfig } from '@/types/schema'

import { flattenRows, groupHitsByLayer } from '../HitsByLayer'


function hit(urn: string, containerUrn: string): SearchHit {
    return {
        node: { urn, displayName: urn, entityType: 'dataset', properties: {} },
        ancestorPath: [{
            urn: containerUrn,
            displayName: containerUrn.toUpperCase(),
            entityType: 'container',
        }],
    } as unknown as SearchHit
}

const LAYERS = [
    { id: 'L1', name: 'Raw', entityTypes: [], order: 0 },
    { id: 'L2', name: 'Curated', entityTypes: [], order: 1 },
] as ViewLayerConfig[]

/** Two hits under C1 (in L1), one under C2 (in L2). */
const HITS = [hit('a', 'C1'), hit('b', 'C1'), hit('c', 'C2')]

const LAYER_OF: Record<string, string> = { a: 'L1', b: 'L1', c: 'L2' }
const resolveLayer = (h: SearchHit) => LAYER_OF[h.node.urn] ?? null

/** What the server said about the FULL match set — C1 holds 40 matches,
 *  only 2 of which are on this page. */
const COUNTS = new Map([['C1', 40], ['C2', 3]])


describe('groupHitsByLayer', () => {
    it('counts containers from the server aggregation, not from the page', () => {
        const groups = groupHitsByLayer(HITS, resolveLayer, COUNTS, LAYERS)

        expect(groups).toHaveLength(2)
        expect(groups[0]).toMatchObject({
            layerId: 'L1', layerName: 'Raw', count: 40,
        })
        expect(groups[0].containers).toHaveLength(1)
        expect(groups[0].containers[0]).toMatchObject({ urn: 'C1', count: 40 })
        expect(groups[0].containers[0].hits).toHaveLength(2)
        expect(groups[1]).toMatchObject({
            layerId: 'L2', layerName: 'Curated', count: 3,
        })
    })

    it('falls back to the hits on the page when the server counted no ancestors', () => {
        const groups = groupHitsByLayer(HITS, resolveLayer, new Map(), LAYERS)

        expect(groups[0].containers[0].count).toBe(2)
        expect(groups[0].count).toBe(2)
    })

    it('orders groups by the layer order and puts off-canvas hits last', () => {
        const groups = groupHitsByLayer(
            [hit('z', 'C9'), ...HITS],
            (h) => (h.node.urn === 'z' ? null : resolveLayer(h)),
            COUNTS,
            LAYERS,
        )

        expect(groups.map((g) => g.layerId)).toEqual(['L1', 'L2', null])
        expect(groups[2].layerName).toBe('Not on this canvas')
        expect(groups[2].containers[0].hits.map((h) => h.node.urn)).toEqual(['z'])
    })
})


describe('groupHitsByLayer — a container split across two layers', () => {
    // Reachable whenever a mid-path ancestor carries its own assignment
    // (or one with `inheritsChildren: false`): two hits under the SAME
    // top-level container resolve to different layer columns.
    const SPLIT = [hit('a', 'C1'), hit('b', 'C1')]
    const splitLayer = (h: SearchHit) => (h.node.urn === 'a' ? 'L1' : 'L2')

    it('does not hand each layer the whole server count', () => {
        const groups = groupHitsByLayer(SPLIT, splitLayer, COUNTS, LAYERS)

        // C1 holds 40 matches in total. Neither half may claim all 40 —
        // the two layer headers would then sum to 80 under a 3-row page.
        expect(groups.map((g) => g.count)).toEqual([1, 1])
        expect(groups[0].containers[0].count).toBe(1)
        expect(groups[1].containers[0].count).toBe(1)
    })

    it('still uses the exact count for the containers that are not split', () => {
        const groups = groupHitsByLayer(
            [...SPLIT, hit('c', 'C2')], splitLayer, COUNTS, LAYERS)

        // C2 lives in one layer only, so its server count stands.
        const l2 = groups.find((g) => g.layerId === 'L2')!
        expect(l2.containers.find((c) => c.urn === 'C2')!.count).toBe(3)
    })
})


describe('flattenRows', () => {
    it('emits a header per layer, per container, then the hits', () => {
        const rows = flattenRows(groupHitsByLayer(HITS, resolveLayer, COUNTS, LAYERS), new Set())

        expect(rows.map((r) => r.kind)).toEqual([
            'layer', 'container', 'hit', 'hit',
            'layer', 'container', 'hit',
        ])
    })

    it('omits everything under a collapsed layer', () => {
        const groups = groupHitsByLayer(HITS, resolveLayer, COUNTS, LAYERS)
        const rows = flattenRows(groups, new Set([groups[0].key]))

        expect(rows.map((r) => r.kind)).toEqual(['layer', 'layer', 'container', 'hit'])
        expect(rows.some((r) => r.kind === 'hit' && r.hit.node.urn === 'a')).toBe(false)
    })

    it('omits only the hits under a collapsed container', () => {
        const groups = groupHitsByLayer(HITS, resolveLayer, COUNTS, LAYERS)
        const rows = flattenRows(groups, new Set([groups[0].containers[0].key]))

        expect(rows.map((r) => r.kind)).toEqual([
            'layer', 'container',
            'layer', 'container', 'hit',
        ])
    })
})
