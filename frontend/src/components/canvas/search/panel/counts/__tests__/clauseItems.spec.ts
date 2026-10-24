/**
 * The counts a query is read with: each clause alone, the matches as each
 * is added, a relationship's relatives and the total — only what the
 * server can count, each condition asked once, within one request.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import { COUNT_ITEMS_MAX, countId, planClauseCounts } from '../clauseItems'
import { whyUncountable } from '../countable'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })
const tag = (...values: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values })
const all = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const any = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'or', children })
const named = (name: string): Predicate => ({ kind: 'is', refs: [{ path: ['**', name] }] })


describe('whyUncountable', () => {
    it('counts a finished condition', () => {
        expect(whyUncountable(tag('PII'))).toBeNull()
        expect(whyUncountable(all(type('dataset'), tag('PII')))).toBeNull()
    })

    it('waits for a condition to be filled in', () => {
        expect(whyUncountable(tag())).toBe('unfinished')
        expect(whyUncountable({ kind: 'related', axis: 'parent', where: type() })).toBe('unfinished')
        expect(whyUncountable({ kind: 'group', op: 'not', children: [] })).toBe('unfinished')
    })

    it('leaves routes to the run', () => {
        expect(whyUncountable({ kind: 'path', sourceUrns: ['a'], targetUrns: ['b'] } as Predicate)).toBe('route')
    })

    it('counts lineage as far as a search tests it, and further when the far end is named', () => {
        expect(whyUncountable({ kind: 'related', axis: 'downstream', maxHops: 3 })).toBeNull()
        expect(whyUncountable({ kind: 'related', axis: 'downstream', maxHops: 4 })).toBe('too-far')
        expect(whyUncountable({ kind: 'related', axis: 'downstream', maxHops: 8, where: named('Sales') })).toBeNull()
        // A named far end walks further only at the top of the query.
        expect(whyUncountable(any({ kind: 'related', axis: 'downstream', maxHops: 8, where: named('Sales') }, tag('x'))))
            .toBe('too-far')
    })

    it('stops at relationships nested deeper than the server allows', () => {
        const deep: Predicate = { kind: 'related', axis: 'parent', where: { kind: 'related', axis: 'parent',
            where: { kind: 'related', axis: 'parent', where: { kind: 'related', axis: 'parent' } } } }
        expect(whyUncountable(deep)).toBe('too-deep')
    })
})


describe('planClauseCounts', () => {
    it('asks for nothing without a query', () => {
        expect(planClauseCounts(null)).toEqual({ items: [], clauses: [], total: null })
    })

    it('reads each clause alone and the matches narrowing clause by clause', () => {
        const draft = all(type('dataset'), tag('PII'), { kind: 'isLeaf' })
        const plan = planClauseCounts(draft)
        const [a, b, c] = plan.clauses
        expect(a.alone).toBe(countId(type('dataset')))
        expect(a.prefix).toBe(a.alone)                         // the first clause alone IS the first step
        expect(b.prefix).toBe(countId(all(type('dataset'), tag('PII'))))
        expect(c.prefix).toBe(plan.total)                      // all three IS the query
        expect(new Set(plan.items.map((i) => i.id)).size).toBe(plan.items.length)
        expect(plan.items).toHaveLength(5)                     // 3 alone + 1 two-clause step + the total
    })

    it('skips a clause still being filled in, as the run does', () => {
        const plan = planClauseCounts(all(type('dataset'), tag(), { kind: 'isLeaf' }))
        expect(plan.clauses[1]).toMatchObject({ alone: null, prefix: null, reason: 'unfinished' })
        expect(plan.clauses[2].prefix).toBe(countId(all(type('dataset'), { kind: 'isLeaf' })))
    })

    it('ends the narrowing at a clause that can\'t be counted', () => {
        const route = { kind: 'path', sourceUrns: ['a'], targetUrns: ['b'] } as Predicate
        const plan = planClauseCounts(all(type('dataset'), route, tag('PII')))
        expect(plan.clauses[1].reason).toBe('route')
        expect(plan.clauses[2].prefix).toBeNull()
        expect(plan.total).toBeNull()                          // the query runs as routes
        expect(plan.clauses[2].alone).not.toBeNull()            // but the clause alone still counts
    })

    it('reads no narrowing in an any-of query', () => {
        const plan = planClauseCounts(any(tag('PII'), tag('GDPR')))
        expect(plan.clauses.every((c) => c.prefix === null)).toBe(true)
        expect(plan.total).not.toBeNull()
    })

    it('counts what a relationship\'s relatives must be', () => {
        const feeds: Predicate = { kind: 'related', axis: 'downstream', maxHops: 3, where: type('dashboard') }
        const plan = planClauseCounts(all(type('dataset'), feeds))
        expect(plan.clauses[1].where).toBe(countId(type('dashboard')))
    })

    it('never asks for more than one request holds', () => {
        const many = all(...Array.from({ length: 20 }, (_, i) => tag(`t${i}`)))
        expect(planClauseCounts(many).items.length).toBeLessThanOrEqual(COUNT_ITEMS_MAX)
    })

    it('names the same condition the same way, and different ones apart', () => {
        expect(countId(tag('PII'))).toBe(countId(tag('PII')))
        expect(countId(tag('PII'))).not.toBe(countId(tag('GDPR')))
        expect(countId(tag('PII')).length).toBeLessThan(128)
    })
})
