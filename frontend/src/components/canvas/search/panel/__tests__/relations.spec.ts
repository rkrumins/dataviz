import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import type { Predicate, RelatedPredicate } from '@/types/search'

import {
    formatNamePath,
    hopRange,
    maxHopsFor,
    newRelation,
    parseNamePath,
    refLabel,
    relationDepth,
} from '../relations'


const rel = (over: Partial<RelatedPredicate>): RelatedPredicate => ({ kind: 'related', axis: 'parent', ...over })


describe('relations — hops', () => {
    it.each<[Partial<RelatedPredicate>, [number, number]]>([
        [{ axis: 'parent' }, [1, 1]],
        [{ axis: 'child', minHops: 3 }, [1, 1]],
        [{ axis: 'root' }, [1, 20]],
        [{ axis: 'upstream' }, [1, 1]],
        [{ axis: 'upstream', minHops: 2 }, [2, 2]],
        [{ axis: 'downstream', maxHops: 3 }, [1, 3]],
        [{ axis: 'ancestor' }, [1, 20]],
        [{ axis: 'descendant', minHops: 2, maxHops: 4 }, [2, 4]],
    ])('reads %j as the server does', (over, range) => {
        expect(hopRange(rel(over))).toEqual(range)
    })

    it('lets lineage go further only from named entities at the top of the query', () => {
        const named = rel({ axis: 'upstream', where: { kind: 'is', refs: [{ path: ['Sales'] }] } })
        expect(maxHopsFor(named, { topLevel: true, rule: false })).toBe(10)
        expect(maxHopsFor(named, { topLevel: false, rule: false })).toBe(3)
        expect(maxHopsFor({ ...named, quantifier: 'none' }, { topLevel: true, rule: false })).toBe(3)
        expect(maxHopsFor(rel({ axis: 'upstream' }), { topLevel: true, rule: false })).toBe(3)
        expect(maxHopsFor(named, { topLevel: true, rule: true })).toBe(1)
    })
})


describe('relations — nesting', () => {
    it('counts relationships inside conditions, groups and path ends', () => {
        const type: Predicate = { kind: 'entityType', op: 'in', values: ['domain'] }
        const two = newRelation('upstream', newRelation('parent', type))
        expect(relationDepth(type)).toBe(0)
        expect(relationDepth(two)).toBe(2)
        expect(relationDepth({ kind: 'group', op: 'or', children: [type, two] })).toBe(2)
        expect(relationDepth({ kind: 'path', sourceUrns: ['a'], targetWhere: two } as Predicate)).toBe(2)
    })
})


describe('relations — name paths', () => {
    it('splits on slashes, keeps an escaped one, trims and drops empty segments', () => {
        expect(parseNamePath(' Country / United Kingdom ')).toEqual(['Country', 'United Kingdom'])
        expect(parseNamePath('a\\/b/**/c//')).toEqual(['a/b', '**', 'c'])
    })

    it('writes what it reads', () => {
        const segment = fc.string({ minLength: 1, maxLength: 8 })
            .filter((s) => s.trim() === s && s.length > 0 && !s.endsWith('\\'))
        fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (path) => {
            expect(parseNamePath(formatNamePath(path))).toEqual(path)
        }), { numRuns: 300 })
    })

    it('labels a reference by its path, or its URN', () => {
        expect(refLabel({ path: ['Country', 'UK'] })).toBe('Country / UK')
        expect(refLabel({ path: ['Sales'], entityType: 'domain' })).toBe('Sales (domain)')
        expect(refLabel({ urn: 'urn:li:dataset:orders' })).toContain('orders')
    })
})
