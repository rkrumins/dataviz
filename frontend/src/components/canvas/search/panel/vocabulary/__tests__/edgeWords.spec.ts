/**
 * edgeWords — one set of edges is never called two things: an edge type by
 * its name, an edge set in a few words, a graph shape and an edge count by
 * the edges they count.
 */
import { describe, expect, it } from 'vitest'

import type { EdgeClass } from '@/types/search'

import {
    degreePhrase,
    edgeSetOf,
    edgeSetPhrase,
    edgeTypeName,
    shapeLabel,
    shapePhrase,
    type ShapeKind,
    withEdgeSet,
} from '../edgeWords'


describe('edgeWords', () => {
    it('names an edge type as people read it, this app’s word first', () => {
        expect(edgeTypeName('PRODUCES')).toBe('Produces')
        expect(edgeTypeName('TAGGED_WITH')).toBe('Tagged with')
        expect(edgeTypeName('AGGREGATED')).toBe('Combined flow')
    })

    it('reads the edges a condition counts: a class, or the types it names', () => {
        expect(edgeSetOf({})).toBe('lineage')
        expect(edgeSetOf({ edgeClass: 'links' })).toBe('links')
        expect(edgeSetOf({ edgeClass: 'any', edgeTypes: [] })).toBe('types')
        expect(edgeSetPhrase({ edgeClass: 'any' })).toBe('any edge')
        expect(edgeSetPhrase({ edgeTypes: ['PRODUCES', 'CONSUMES', 'DEFINED_BY'] }))
            .toBe('Produces, Consumes or Defined by edges')
    })

    it('switches a condition to other edges, leaving its other fields', () => {
        expect(withEdgeSet({ kind: 'isRoot', edgeClass: 'lineage' }, 'types'))
            .toEqual({ kind: 'isRoot', edgeTypes: [] })
        expect(withEdgeSet({ kind: 'degree', direction: 'in', op: 'gt', value: 2, edgeTypes: ['X'] }, 'links'))
            .toEqual({ kind: 'degree', direction: 'in', op: 'gt', value: 2, edgeClass: 'links' })
    })

    it.each<[ShapeKind, { edgeClass?: EdgeClass; edgeTypes?: string[] }, string, string, string]>([
        ['isRoot', {}, 'No upstream lineage', 'has no upstream lineage', 'have no upstream lineage'],
        ['isRoot', { edgeClass: 'links' }, 'Nothing links into it', 'nothing links into', 'nothing links into'],
        ['isRoot', { edgeClass: 'any' }, 'No incoming edges', 'has no incoming edges', 'have no incoming edges'],
        ['isLeaf', { edgeClass: 'links' }, 'Links to nothing', 'links to nothing', 'link to nothing'],
        ['isLeaf', { edgeClass: 'containment' }, 'Contains nothing', 'contains nothing', 'contain nothing'],
        ['isOrphan', { edgeClass: 'any' }, 'No edges at all', 'has no edges at all', 'have no edges at all'],
        ['isOrphan', { edgeClass: 'links' }, 'No links at all', 'has no links at all', 'have no links at all'],
        ['hasIncoming', { edgeTypes: ['DEFINED_BY'] }, 'Has incoming Defined by edges',
            'has incoming Defined by edges', 'have incoming Defined by edges'],
        ['hasOutgoing', { edgeClass: 'containment' }, 'Contains something', 'contains something',
            'contain something'],
    ])('names %s through %j for the edges it counts', (kind, edges, label, one, many) => {
        expect(shapeLabel(kind, edges)).toBe(label)
        expect(shapePhrase(kind, edges, false)).toBe(one)
        expect(shapePhrase(kind, edges, true)).toBe(many)
    })

    it('reads an edge count in words', () => {
        expect(degreePhrase({ kind: 'degree', direction: 'both', op: 'gt', value: 5, edgeClass: 'links' }))
            .toBe('more than 5 links, either way')
        expect(degreePhrase({ kind: 'degree', direction: 'in', op: 'eq', value: 1, edgeTypes: ['PRODUCES'] }))
            .toBe('exactly 1 incoming Produces edge')
        expect(degreePhrase({ kind: 'degree', direction: 'out', op: 'lte', value: 2, edgeClass: 'any' }))
            .toBe('at most 2 outgoing edges')
    })
})
