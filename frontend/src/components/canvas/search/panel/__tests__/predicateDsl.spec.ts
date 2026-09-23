import { describe, it, expect } from 'vitest'
import { parsePredicate, stringifyPredicate } from '../predicateDsl'
import {
    appendCondition,
    duplicateConditionAt,
    setRootGroupOp,
    wrapConditionAt,
} from '../predicateComposition'
import type { Predicate } from '@/types/search'

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


describe('predicateDsl — stringify preserves visual grouping', () => {
    // Regression: the original stringifier dropped parens around child
    // groups whenever Cypher precedence allowed it. So a user who
    // typed `(t2 AND (account OR opp)) OR (T1 AND contacts)` saw it
    // collapse to `t2 AND (account OR opp) OR T1 AND contacts` after
    // Code → Visual → Code. Same semantics, but the visual grouping
    // was lost. We now always wrap nested AND/OR groups in parens.
    it('preserves AND-group parens inside an OR root', () => {
        const original = '(t2 AND (account OR opp)) OR (T1 AND contacts)'
        const parsed = parsePredicate(original).predicate
        expect(stringifyPredicate(parsed)).toBe(original)
    })

    it('preserves OR-group parens inside an AND root', () => {
        const original = 't2 AND (account OR opp)'
        const parsed = parsePredicate(original).predicate
        expect(stringifyPredicate(parsed)).toBe(original)
    })

    it('flat AND/OR has no outer parens', () => {
        expect(stringifyPredicate(parsePredicate('a AND b').predicate)).toBe('a AND b')
        expect(stringifyPredicate(parsePredicate('a OR b').predicate)).toBe('a OR b')
    })

    it('NOT keeps its prefix form, wraps inner group', () => {
        // NOT(leaf) → bare prefix
        expect(stringifyPredicate(parsePredicate('NOT t1').predicate)).toBe('NOT t1')
        // NOT(group) → prefix + wrapped group
        expect(stringifyPredicate(parsePredicate('NOT (a OR b)').predicate))
            .toBe('NOT (a OR b)')
    })

    it('full user example round-trips with parens preserved', () => {
        const original = '(t2 AND (account OR employees)) OR NOT (T1 OR SILVER)'
        const parsed = parsePredicate(original).predicate
        // Stringifier output is unambiguous and matches user intent
        expect(stringifyPredicate(parsed)).toBe(original)
    })
})


describe('predicateDsl — descendantOf (Root in view)', () => {
    // Regression: descendantOf was added to the type system + UI editor
    // + backend compiler but never wired into the DSL stringifier or
    // parser. Visual → Code → Visual dropped urns silently, so the BE
    // compiler received urns: [] and emitted `AND true` (no-op).
    it('stringifies a single-URN descendantOf via IN form', () => {
        const p: Predicate = {
            kind: 'descendantOf',
            urns: ['urn:synodic:layered-lineage:layer:LYR-tlB9DRNg'],
        }
        expect(stringifyPredicate(p)).toBe(
            'descendantOf IN ("urn:synodic:layered-lineage:layer:LYR-tlB9DRNg")',
        )
    })

    it('stringifies multi-URN descendantOf with quoted URNs', () => {
        const p: Predicate = {
            kind: 'descendantOf',
            urns: ['urn:a:1', 'urn:b:2'],
        }
        expect(stringifyPredicate(p)).toBe(
            'descendantOf IN ("urn:a:1", "urn:b:2")',
        )
    })

    it('parses descendantOf IN (...) to a DescendantOfPredicate', () => {
        const r = parsePredicate(
            'descendantOf IN ("urn:synodic:layered-lineage:layer:LYR-tlB9DRNg")',
        )
        expect(r.predicate?.kind).toBe('descendantOf')
        expect((r.predicate as { urns: string[] }).urns).toEqual([
            'urn:synodic:layered-lineage:layer:LYR-tlB9DRNg',
        ])
    })

    it('parses multi-URN descendantOf IN (...)', () => {
        const r = parsePredicate('descendantOf IN ("urn:a:1", "urn:b:2")')
        expect(r.predicate?.kind).toBe('descendantOf')
        expect((r.predicate as { urns: string[] }).urns).toEqual([
            'urn:a:1', 'urn:b:2',
        ])
    })

    it('round-trips through Visual → Code → Visual preserving urns', () => {
        const original: Predicate = {
            kind: 'group', op: 'and',
            children: [
                { kind: 'text', value: 'payment', target: 'name',
                  match: 'substring', caseSensitive: false, boost: 1.0 },
                { kind: 'descendantOf',
                  urns: ['urn:synodic:layered-lineage:layer:LYR-tlB9DRNg'] },
            ],
        }
        const code = stringifyPredicate(original)
        const reparsed = parsePredicate(code).predicate
        expect(JSON.stringify(reparsed)).toBe(JSON.stringify(original))
    })
})


function leaf(value: string): Predicate {
    return {
        kind: 'text', value, target: 'name',
        match: 'substring', caseSensitive: false, boost: 1.0,
    }
}


describe('predicateComposition — wrap / duplicate / root NOT', () => {
    it('wrapConditionAt wraps the right child only', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('a'), leaf('b'), leaf('c')],
        }
        const next = wrapConditionAt(draft, 1, 'or') as any
        expect(next.op).toBe('and')
        expect(next.children).toHaveLength(3)
        expect(next.children[0].value).toBe('a')
        expect(next.children[1].kind).toBe('group')
        expect(next.children[1].op).toBe('or')
        expect(next.children[1].children[0].value).toBe('b')
        expect(next.children[2].value).toBe('c')
    })

    it('wrapConditionAt no-ops when index is out of bounds', () => {
        const draft = appendCondition(null, leaf('a'))
        const next = wrapConditionAt(draft, 5, 'or')
        expect(next).toBe(draft)
    })

    it('duplicateConditionAt inserts a clone after the source', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('a'), leaf('b')],
        }
        const next = duplicateConditionAt(draft, 0) as any
        expect(next.children).toHaveLength(3)
        expect(next.children[0].value).toBe('a')
        expect(next.children[1].value).toBe('a')
        expect(next.children[2].value).toBe('b')
    })

    it('setRootGroupOp("not") wraps the whole tree in NOT', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('a'), leaf('b')],
        }
        const next = setRootGroupOp(draft, 'not') as any
        expect(next.op).toBe('not')
        expect(next.children).toHaveLength(1)
        expect(next.children[0].op).toBe('and')
    })

    it('setRootGroupOp toggles back out of NOT cleanly', () => {
        const draft: Predicate = {
            kind: 'group', op: 'not',
            children: [{
                kind: 'group', op: 'and',
                children: [leaf('a'), leaf('b')],
            }],
        }
        const next = setRootGroupOp(draft, 'or') as any
        expect(next.op).toBe('or')
        expect(next.children).toHaveLength(2)
    })
})


// ---------------------------------------------------------------------------
// Property predicates round-trip through Code mode — every operator, and the
// value's TYPE with it. The writer always emitted CONTAINS / STARTS WITH /
// IN / BETWEEN, but the parser only read = != < <= > >=, so opening Code mode
// turned `gvHash CONTAINS 74` into three text searches, and a text "15"
// came back as the number 15.
// ---------------------------------------------------------------------------

describe('predicateDsl — property operators round-trip', () => {
    const prop = (op: string, value: unknown, key = 'owner'): Predicate =>
        ({ kind: 'property', key, op, value } as Predicate)
    const roundTrip = (p: Predicate) => parsePredicate(stringifyPredicate(p)).predicate

    it.each([
        ['eq', 'fin'], ['neq', 'fin'], ['gt', 5], ['lte', 2.5],
        ['contains', 'fin'], ['startsWith', 'team-'], ['endsWith', 'ops'],
        ['in', ['gold', 'silver']], ['notIn', ['bronze']], ['between', [10, 20]],
    ])('%s survives', (op, value) => {
        expect(roundTrip(prop(op, value))).toEqual(prop(op, value))
    })

    it('keeps text that reads like a number, boolean or null as text', () => {
        for (const v of ['15', '007', 'true', 'null', '1.50']) {
            expect(roundTrip(prop('eq', v))).toEqual(prop('eq', v))
        }
    })

    it('keeps an integer too long for a double as its exact digits', () => {
        const r = parsePredicate('gvHash = -3746471915534727923')
        expect(r.predicate).toEqual(prop('eq', '-3746471915534727923', 'gvHash'))
    })

    it('quotes a key with spaces and reads it back', () => {
        const p = prop('eq', 'Bob', 'Asset Owner')
        expect(stringifyPredicate(p)).toBe('"Asset Owner" = Bob')
        expect(roundTrip(p)).toEqual(p)
    })

    it('reads BETWEEN low AND high as well as BETWEEN (low, high)', () => {
        expect(parsePredicate('rows BETWEEN 10 AND 20').predicate).toEqual(prop('between', [10, 20], 'rows'))
        expect(parsePredicate('rows BETWEEN (10, 20)').predicate).toEqual(prop('between', [10, 20], 'rows'))
    })

    it('an empty value survives as an empty (incomplete) row, not a parse error', () => {
        expect(roundTrip(prop('contains', ''))).toEqual(prop('contains', ''))
    })

    it('STARTS WITH on a name field is a prefix text match', () => {
        const p = parsePredicate('name STARTS WITH cust').predicate as any
        expect(p).toMatchObject({ kind: 'text', target: 'name', match: 'prefix', value: 'cust' })
    })

    it('plain words that happen to be operators stay a text search', () => {
        for (const q of ['sales contains', 'values between', 'starts with']) {
            const r = parsePredicate(q)
            expect(r.error).toBeUndefined()
            expect(JSON.stringify(r.predicate)).not.toContain('"kind":"property"')
        }
    })
})
