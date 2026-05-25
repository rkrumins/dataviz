import { describe, it, expect } from 'vitest'
import { parsePredicate, stringifyPredicate } from '../predicateDsl'

describe('predicateDsl — boolean grammar', () => {
    it('parses bareword as substring text', () => {
        const r = parsePredicate('t2')
        expect(r.predicate?.kind).toBe('text')
    })
    it('parses AND of two barewords', () => {
        const r = parsePredicate('t2 AND opp')
        expect(r.predicate?.kind).toBe('group')
        expect((r.predicate as any).op).toBe('and')
        expect((r.predicate as any).children).toHaveLength(2)
    })
    it('parses parenthesised OR', () => {
        const r = parsePredicate('t2 AND (account OR opp)')
        const p = r.predicate as any
        expect(p.kind).toBe('group')
        expect(p.op).toBe('and')
        expect(p.children).toHaveLength(2)
        expect(p.children[1].op).toBe('or')
        expect(p.children[1].children).toHaveLength(2)
    })
    it('parses the user\'s example fully', () => {
        const r = parsePredicate('t2 AND (account OR opp) OR NOT T1')
        const p = r.predicate as any
        expect(p.kind).toBe('group')
        expect(p.op).toBe('or')
        expect(p.children).toHaveLength(2)
        // left: AND(t2, OR(account, opp))
        const left = p.children[0]
        expect(left.op).toBe('and')
        // right: NOT(T1)
        const right = p.children[1]
        expect(right.op).toBe('not')
    })
    it('round-trips through stringify', () => {
        const original = 't2 AND (account OR opp) OR NOT T1'
        const parsed = parsePredicate(original).predicate
        const back = stringifyPredicate(parsed)
        // re-parse the stringified form and confirm structural equality
        const reparsed = parsePredicate(back).predicate
        expect(JSON.stringify(reparsed)).toBe(JSON.stringify(parsed))
    })
    it('keeps NOT around a single atom', () => {
        const r = parsePredicate('NOT tag:PII')
        const p = r.predicate as any
        expect(p.op).toBe('not')
        expect(p.children[0].kind).toBe('tag')
    })
    it('handles implicit AND', () => {
        const r = parsePredicate('a b c')
        const p = r.predicate as any
        expect(p.op).toBe('and')
        expect(p.children).toHaveLength(3)
    })
    it('handles nested groups', () => {
        const r = parsePredicate('(a OR b) AND (c OR NOT d)')
        const p = r.predicate as any
        expect(p.op).toBe('and')
        expect(p.children).toHaveLength(2)
        expect(p.children[0].op).toBe('or')
        expect(p.children[1].op).toBe('or')
        const dGroup = p.children[1].children[1]
        expect(dGroup.op).toBe('not')
    })
})
