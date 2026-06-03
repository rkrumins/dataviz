/**
 * Tests for the pure helper that finds the canvas's view roots —
 * top-level containers that define the view's boundary. Used by:
 *   1. ``useAdvancedSearch.stampScope`` to populate scope.rootUrns
 *      when the view has no explicit roots (so the BE applies its
 *      containment clamp instead of running unscoped).
 *   2. The "Root in view is…" filter editor for the dropdown.
 */
import { describe, expect, it } from 'vitest'

import type { LineageEdge, LineageNode } from '@/store/canvas'

import { computeViewRoots, computeViewRootUrns } from '../useCanvasViewRoots'


function node(
    id: string,
    type: string,
    label: string = id,
): LineageNode {
    return {
        id,
        position: { x: 0, y: 0 },
        data: { type, urn: id, label } as LineageNode['data'],
    } as LineageNode
}


function containment(source: string, target: string): LineageEdge {
    return {
        id: `${source}-${target}`,
        source,
        target,
        data: { edgeType: 'CONTAINS' } as LineageEdge['data'],
    } as LineageEdge
}


describe('computeViewRoots — finds top-level containers in the canvas', () => {
    it('returns nodes that have no incoming containment edge', () => {
        const nodes = [
            node('silver', 'container', 'SILVER'),
            node('child1', 'dataset', 'child_dataset'),
        ]
        const edges = [containment('silver', 'child1')]
        const roots = computeViewRoots(nodes, edges, ['CONTAINS'], ['container'])
        expect(roots).toHaveLength(1)
        expect(roots[0].urn).toBe('silver')
    })

    it('returns multiple roots sorted by display name', () => {
        const nodes = [
            node('gold', 'container', 'GOLD'),
            node('silver', 'container', 'SILVER'),
            node('reporting', 'container', 'REPORTING'),
        ]
        const roots = computeViewRoots(nodes, [], ['CONTAINS'], ['container'])
        expect(roots.map((r) => r.displayName)).toEqual([
            'GOLD', 'REPORTING', 'SILVER',
        ])
    })

    it('filters out ghost nodes', () => {
        const nodes = [
            node('silver', 'container', 'SILVER'),
            node('ghost1', 'ghost', 'ghost'),
        ]
        const roots = computeViewRoots(nodes, [], ['CONTAINS'], ['container'])
        expect(roots).toHaveLength(1)
        expect(roots[0].urn).toBe('silver')
    })

    it('only considers root entity types when configured', () => {
        const nodes = [
            node('silver', 'container', 'SILVER'),
            node('orphanDataset', 'dataset', 'orphan'),
        ]
        // ``rootEntityTypes`` says only 'container' is a valid root —
        // the orphan dataset is excluded even though it has no parent.
        const roots = computeViewRoots(nodes, [], ['CONTAINS'], ['container'])
        expect(roots.map((r) => r.urn)).toEqual(['silver'])
    })

    it('treats empty rootEntityTypes as "accept any type"', () => {
        const nodes = [
            node('a', 'whatever', 'A'),
            node('b', 'other', 'B'),
        ]
        const roots = computeViewRoots(nodes, [], ['CONTAINS'], [])
        expect(roots).toHaveLength(2)
    })

    it('ignores non-containment edges when deciding parenthood', () => {
        const nodes = [
            node('silver', 'container', 'SILVER'),
            node('downstream', 'container', 'DOWNSTREAM'),
        ]
        const edges: LineageEdge[] = [{
            id: 'lineage', source: 'silver', target: 'downstream',
            data: { edgeType: 'LINEAGE' } as LineageEdge['data'],
        } as LineageEdge]
        // Only CONTAINS is treated as containment; LINEAGE edges
        // shouldn't mark a node as "having a parent".
        const roots = computeViewRoots(nodes, edges, ['CONTAINS'], ['container'])
        expect(roots).toHaveLength(2)
    })

    it('returns empty array when canvas is empty', () => {
        const roots = computeViewRoots([], [], ['CONTAINS'], ['container'])
        expect(roots).toEqual([])
    })

    it('computeViewRootUrns wraps the same logic and returns URNs', () => {
        const nodes = [
            node('silver', 'container', 'SILVER'),
            node('gold', 'container', 'GOLD'),
            node('child', 'dataset', 'child'),
        ]
        const edges = [containment('silver', 'child')]
        const urns = computeViewRootUrns(nodes, edges, ['CONTAINS'], ['container'])
        // Sorted by display name → GOLD before SILVER
        expect(urns).toEqual(['gold', 'silver'])
    })
})
