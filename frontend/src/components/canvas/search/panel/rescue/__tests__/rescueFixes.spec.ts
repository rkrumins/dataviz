/**
 * When a query matches nothing: the line where the matches run out, and
 * the smallest changes worth counting, mildest first.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import type { ClauseCount } from '../../counts/useClauseCounts'
import { stringifyPredicate } from '../../predicateDsl'
import { emptyingClause, rescueFixes } from '../rescueFixes'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })
const tag = (...values: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values })
const all = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const n = (count: number) => ({ count, complete: true })
const line = (alone: number | null, cumulative: number | null): ClauseCount => ({
    alone: alone === null ? null : n(alone), cumulative: cumulative === null ? null : n(cumulative),
    where: null, reason: null,
})

const fixes = (draft: Predicate, clause: number) =>
    rescueFixes(draft, clause).map((f) => `${f.kind}: ${stringifyPredicate(f.predicate)}`)


describe('emptyingClause', () => {
    it('finds the line where the running total reaches nothing', () => {
        expect(emptyingClause([line(13, 13), line(9, 9), line(4, 0)])).toBe(2)
    })

    it('else blames the first line that matches nothing by itself', () => {
        expect(emptyingClause([line(3, null), line(0, null), line(0, null)])).toBe(1)
    })

    it('blames nothing while there are matches, or counts still to come', () => {
        expect(emptyingClause([line(13, 13), line(9, 9)])).toBeNull()
        expect(emptyingClause([line(null, null)])).toBeNull()
    })
})


describe('rescueFixes', () => {
    it('looks further along lineage first, then drops the line, or matches any', () => {
        const draft = all(type('dataset'), { kind: 'related', axis: 'downstream', maxHops: 1, where: type('dashboard') },
            tag('PII'))
        expect(fixes(draft, 1)).toEqual([
            'hops: type:dataset AND downstream*..3(type:dashboard) AND tag:PII',
            'anyOf: type:dataset AND (downstream(type:dashboard) OR tag:PII)',
            'drop: type:dataset AND tag:PII',
        ])
    })

    it('asks for any relative, not every one, and for one, not many', () => {
        const every: Predicate = { kind: 'related', axis: 'child', quantifier: 'all', where: tag('PII') }
        expect(fixes(all(type('table'), every), 1)[0]).toBe('anyRelative: type:table AND child(tag:PII)')
        const many: Predicate = { kind: 'related', axis: 'child', count: { op: 'gte', value: 50 } }
        expect(fixes(all(type('table'), many), 1)[0]).toBe('fewer: type:table AND count(child()) >= 1')
    })

    it('loosens exact text to text that contains it', () => {
        const exact = { kind: 'text', value: 'orders', target: 'name', match: 'exact' } as Predicate
        expect(rescueFixes(all(type('table'), exact), 1)[0]).toMatchObject({
            kind: 'contains', text: 'orders', predicate: { children: [type('table'), { match: 'substring' }] },
        })
    })

    it('offers the whole view when the query is clamped to a container', () => {
        const inside: Predicate = { kind: 'related', axis: 'ancestor', where: { kind: 'is', refs: [{ path: ['**', 'GOLD'] }] } }
        const draft = all(type('dataset'), inside, tag('PII'))
        expect(fixes(draft, 2)).toEqual([
            'anyOf: type:dataset AND (ancestor(@"**/GOLD") OR tag:PII)',
            'drop: type:dataset AND ancestor(@"**/GOLD")',
            'wholeView: type:dataset AND tag:PII',
        ])
    })

    it('drops a subject that names a type the view lacks', () => {
        expect(fixes(all(type('report'), tag('PII')), 0)).toEqual(['drop: tag:PII'])
    })
})
