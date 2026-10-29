/**
 * findMode — what the panel finds, entities or the connections between
 * them, and the switch between the two: what each side keeps of the query,
 * and what it leaves out, named so the panel can say so.
 */
import { describe, expect, it } from 'vitest'

import type { EdgesPredicate, Predicate } from '@/types/search'

import { asDraft, findModeOf, queryLabel, toConnections, toEntities } from '../findMode'


const DATASETS: Predicate = { kind: 'entityType', op: 'in', values: ['dataset'] }
const PII: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }
const feeds = (maxHops: number): Predicate => ({ kind: 'related', axis: 'downstream', maxHops, where: DATASETS })


describe('findMode', () => {
    it("is the draft's own kind", () => {
        expect(findModeOf(null)).toBe('entities')
        expect(findModeOf(DATASETS)).toBe('entities')
        expect(findModeOf({ kind: 'edges' })).toBe('connections')
    })
})


describe('toConnections', () => {
    it('takes the conditions into From, leaving out what one edge can’t hold', () => {
        const { next, dropped } = toConnections({ kind: 'group', op: 'and', children: [
            DATASETS, PII, { kind: 'withinHops', urns: ['urn:a'], hops: 2 }, feeds(6), feeds(2),
        ] })
        expect(next).toEqual({
            kind: 'edges', sourceWhere: { kind: 'group', op: 'and', children: [DATASETS, PII, feeds(2)] },
        })
        expect(dropped).toEqual(['“within N hops”', 'lineage followed 6 steps'])
    })

    it('keeps any-of as any-of, and a lone condition as itself', () => {
        expect(toConnections({ kind: 'group', op: 'or', children: [DATASETS, PII] }).next)
            .toEqual({ kind: 'edges', sourceWhere: { kind: 'group', op: 'or', children: [DATASETS, PII] } })
        expect(toConnections(DATASETS).next).toEqual({ kind: 'edges', sourceWhere: DATASETS })
    })

    it('starts from any entity with nothing, or only a route, to keep', () => {
        expect(toConnections(null)).toEqual({ next: { kind: 'edges' }, dropped: [] })
        expect(toConnections({ kind: 'path', sourceUrns: ['urn:a'], targetUrns: ['urn:b'] }))
            .toEqual({ next: { kind: 'edges' }, dropped: ['a path search'] })
        expect(toConnections({ kind: 'all' })).toEqual({ next: { kind: 'edges' }, dropped: [] })
    })
})


describe('toEntities', () => {
    it('keeps the From conditions, naming what it leaves out', () => {
        expect(toEntities({ kind: 'edges', sourceWhere: DATASETS })).toEqual({ next: DATASETS, dropped: [] })
        expect(toEntities({ kind: 'edges', targetWhere: PII, edgeTypes: ['PRODUCES'] }))
            .toEqual({ next: null, dropped: ['the To conditions', 'the edges it goes through'] })
        expect(toEntities({ kind: 'edges', sourceWhere: DATASETS, direction: 'either' }).dropped)
            .toEqual(['the edges it goes through'])
    })

    it('gives back what the switch to Connections took', () => {
        const draft: Predicate = { kind: 'group', op: 'and', children: [DATASETS, PII] }
        expect(toEntities(toConnections(draft).next)).toEqual({ next: draft, dropped: [] })
    })
})


describe('saved and recent Connections searches', () => {
    const edges: EdgesPredicate = { kind: 'edges', sourceWhere: DATASETS }

    it('load as themselves when sent in an AND group of their own', () => {
        expect(asDraft({ kind: 'group', op: 'and', children: [edges] })).toEqual(edges)
        expect(asDraft(edges)).toBe(edges)
        const one: Predicate = { kind: 'group', op: 'and', children: [DATASETS] }
        expect(asDraft(one)).toBe(one)
    })

    it('read as their two ends', () => {
        expect(queryLabel({ kind: 'group', op: 'and', children: [edges] })).toBe('type:dataset → anything')
        expect(queryLabel({ kind: 'edges', targetWhere: PII })).toBe('anything → tag:PII')
        expect(queryLabel(DATASETS)).toBe('type:dataset')
    })
})
