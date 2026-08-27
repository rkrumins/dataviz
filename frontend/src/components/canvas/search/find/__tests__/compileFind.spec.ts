/**
 * compileFind — the header box's text, turned into a runnable predicate.
 *
 * Two audiences share one box, so the contract has two halves:
 *   1. A plain word means whatever the match-mode + field-scope controls
 *      say it means (the business persona never types an operator).
 *   2. Operators keep the meaning they have everywhere else in the
 *      product (the analyst never has to re-learn the box).
 */
import { describe, expect, it } from 'vitest'

import { compileFind, type FindMode, type FindScope } from '../compileFind'


/** Terse accessor — the generated predicate types are unions, and every
 *  assertion here is about shape rather than about the union. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const as = (p: unknown) => p as any

function compile(
    text: string,
    mode: FindMode = 'contains',
    scope: FindScope = 'everything',
) {
    return compileFind({ text, mode, scope })
}


describe('compileFind — a plain word', () => {
    it('searches everything by default: full text OR tags', () => {
        const p = as(compile('revenue').predicate)
        expect(p.kind).toBe('group')
        expect(p.op).toBe('or')
        expect(p.children.map((c: { target: string }) => c.target))
            .toEqual(['any', 'tags'])
        expect(p.children.every((c: { match: string }) => c.match === 'substring'))
            .toBe(true)
        expect(p.children.every((c: { value: string }) => c.value === 'revenue'))
            .toBe(true)
    })

    it('is reported as a fallback run, not a recognised operator', () => {
        const r = compile('revenue')
        expect(r.fallbackText).toEqual(['revenue'])
        expect(r.recognized).toEqual([])
        expect(r.usedOperators).toBe(false)
    })

    it('maps each match mode onto the backend match vocabulary', () => {
        const modes: Array<[FindMode, string]> = [
            ['contains', 'substring'],
            ['startsWith', 'prefix'],
            ['exact', 'exact'],
        ]
        for (const [mode, expected] of modes) {
            const p = as(compile('revenue', mode, 'names').predicate)
            expect(p.match).toBe(expected)
        }
    })

    it('maps each field scope onto the backend target vocabulary', () => {
        expect(as(compile('x', 'contains', 'names').predicate).target).toBe('name')
        expect(as(compile('x', 'contains', 'descriptions').predicate).target)
            .toBe('description')
        expect(as(compile('x', 'contains', 'tags').predicate).target).toBe('tags')
    })

    it('carries the mode into both branches of the everything scope', () => {
        const p = as(compile('rev', 'startsWith', 'everything').predicate)
        expect(p.children.map((c: { match: string }) => c.match))
            .toEqual(['prefix', 'prefix'])
    })

    it('never matches case-sensitively — a business user types lowercase', () => {
        expect(as(compile('x', 'contains', 'names').predicate).caseSensitive)
            .toBe(false)
    })

    it('returns a null predicate for empty and whitespace-only input', () => {
        expect(compile('').predicate).toBeNull()
        expect(compile('   ').predicate).toBeNull()
        expect(compile('').usedOperators).toBe(false)
    })
})


describe('compileFind — operators keep their meaning', () => {
    it('combines a word and a tag filter into an AND group', () => {
        const r = compile('revenue tag:PII')
        const p = as(r.predicate)
        expect(p.kind).toBe('group')
        expect(p.op).toBe('and')
        expect(p.children).toHaveLength(2)
        expect(r.usedOperators).toBe(true)
        expect(r.recognized).toContain('tag:PII')
        expect(r.fallbackText).toContain('revenue')
    })

    it('leaves tag: as an exact TagPredicate — the mode applies to words only', () => {
        const p = as(compile('tag:PII', 'startsWith').predicate)
        expect(p.kind).toBe('tag')
        expect(p.values).toEqual(['PII'])
    })

    it('compiles a numeric comparison to a property predicate', () => {
        const p = as(compile('rowCount > 1000').predicate)
        expect(p.kind).toBe('property')
        expect(p.key).toBe('rowCount')
        expect(p.op).toBe('gt')
        expect(p.value).toBe(1000)
    })

    it('compiles type: to an entityType predicate', () => {
        const p = as(compile('type:dataset').predicate)
        expect(p.kind).toBe('entityType')
        expect(p.values).toEqual(['dataset'])
    })

    it('honours the scope for the word half of a mixed query', () => {
        const p = as(compile('revenue tag:PII', 'contains', 'names').predicate)
        expect(p.children[0].kind).toBe('text')
        expect(p.children[0].target).toBe('name')
        expect(p.children[1].kind).toBe('tag')
    })

    it('treats a quoted phrase as one word, not two', () => {
        const r = compile('"monthly revenue"')
        expect(r.fallbackText).toEqual(['monthly revenue'])
        expect(as(r.predicate).children[0].value).toBe('monthly revenue')
    })
})


describe('compileFind — a half-typed query never throws', () => {
    it('reports unbalanced parens as an error instead of crashing', () => {
        const r = compile('(revenue AND')
        expect(r.error).toBeTruthy()
        expect(r.predicate).toBeNull()
    })
})
