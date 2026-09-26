import { describe, it, expect } from 'vitest'
import { parsePredicate, stringifyPredicate } from '../predicateDsl'
import {
    appendCondition,
    duplicateConditionAt,
    setRootGroupOp,
    wrapConditionAt,
} from '../predicateComposition'
import fc from 'fast-check'

import type { Predicate, PropertyPredicate } from '@/types/search'
import { OPERATOR_TABLE, type PropertyOperator } from '@/types/generated/searchOperators'

import { arityOf, isNegative, predicateType } from '../../typed/operators'

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


// ---------------------------------------------------------------------------
// Typed comparisons in Code mode — a row must mean the same thing after
// Visual → Code → Visual: the operator, the value, the type it compares as,
// and its case / missing-key flags.
// ---------------------------------------------------------------------------

describe('predicateDsl — typed comparisons', () => {
    const roundTrip = (p: Predicate) => parsePredicate(stringifyPredicate(p)).predicate

    it.each([
        ['owner IS SET', { op: 'isSet' }],
        ['owner IS NOT SET', { op: 'isNotSet' }],
        ['owner IS EMPTY', { op: 'isEmpty' }],
        ['owner IS NOT EMPTY', { op: 'isNotEmpty' }],
        ['owner NOT CONTAINS test', { op: 'notContains', value: 'test' }],
        ['owner CONTAINS ALL (pii, gold)', { op: 'containsAll', value: ['pii', 'gold'] }],
        ['owner WITHIN LAST 30 days', { op: 'withinLast', value: 'P30D' }],
        ['owner WITHIN LAST 12 HOURS', { op: 'withinLast', value: 'PT12H' }],
        ['owner WITHIN LAST P1DT6H', { op: 'withinLast', value: 'P1DT6H' }],
    ])('parses %s', (text, expected) => {
        expect(parsePredicate(text).predicate).toEqual({ kind: 'property', key: 'owner', ...expected })
    })

    it('reads the suffixes', () => {
        expect(parsePredicate('created = "2024-05-01" AS DATE').predicate).toEqual({
            kind: 'property', key: 'created', op: 'eq', value: '2024-05-01', valueType: 'date',
        })
        expect(parsePredicate('owner != Bob MATCH CASE INCLUDING MISSING').predicate).toEqual({
            kind: 'property', key: 'owner', op: 'neq', value: 'Bob',
            caseSensitive: true, includeMissing: true,
        })
    })

    it('writes a type only where the value alone would read as another', () => {
        const p = (op: string, value: unknown, valueType: string) =>
            ({ kind: 'property', key: 'k', op, value, valueType } as Predicate)
        expect(stringifyPredicate(p('gt', 10, 'number'))).toBe('k > 10')
        expect(stringifyPredicate(p('eq', '2024-05-01', 'date'))).toBe('k = 2024-05-01 AS DATE')
        expect(stringifyPredicate(p('gt', '15', 'string'))).toBe('k > "15" AS TEXT')
        expect(stringifyPredicate(p('eq', '-3746471915534727923', 'number')))
            .toBe('k = "-3746471915534727923" AS NUMBER')
        expect(stringifyPredicate(p('contains', '74', 'number'))).toBe('k CONTAINS "74"')
    })

    it('NOT CONTAINS on a name field is NOT of the text match', () => {
        expect(parsePredicate('name NOT CONTAINS temp').predicate).toMatchObject({
            kind: 'group', op: 'not',
            children: [{ kind: 'text', target: 'name', match: 'substring', value: 'temp' }],
        })
    })

    it('searches property names with a glob', () => {
        for (const [text, keyMatch, key] of [
            ['has:owner*', 'prefix', 'owner'], ['has:*owner*', 'contains', 'owner'],
        ] as const) {
            const p = parsePredicate(text).predicate
            expect(p).toEqual({ kind: 'hasProperty', key, negate: false, keyMatch })
            expect(roundTrip(p!)).toEqual(p)
        }
    })

    it('plain words still read as a text search', () => {
        for (const q of ['is set', 'within last', 'contains all']) {
            const r = parsePredicate(q)
            expect(r.error).toBeUndefined()
            expect(JSON.stringify(r.predicate)).not.toContain('"kind":"property"')
        }
    })

    // Any typed comparison survives Visual → Code → Visual with its meaning.
    const KEYWORDS = /^(and|or|not|as|is|in|all|set|empty|match|case|including|missing|within|last|contains|between|starts|ends|with|null|true|false)$/i
    const word = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/).filter((w) => !KEYWORDS.test(w))
    const text = fc.oneof(word, fc.tuple(word, word).map(([a, b]) => `${a} ${b}`),
        fc.constantFrom('15', '007', 'true', '2024-05-01'))
    const valueOf: Record<string, fc.Arbitrary<unknown>> = {
        string: text,
        number: fc.oneof(fc.integer({ min: -1e9, max: 1e9 }), fc.constantFrom(1.5, -0.25),
            fc.constantFrom('-3746471915534727923', '9223372036854775807')),
        boolean: fc.boolean(),
        date: fc.constantFrom('2024-05-01', '2024-05-01T10:00:00Z'),
    }
    const comparison = fc.constantFrom(...(Object.keys(OPERATOR_TABLE) as PropertyOperator[]))
        .chain((op) => {
            const spec = OPERATOR_TABLE[op]
            const types = spec.types.length ? [...spec.types] : ['string']
            return fc.record({
                op: fc.constant(op),
                key: fc.constantFrom('owner', 'Asset Owner', 'gvHash'),
                valueType: fc.constantFrom(...types, 'auto'),
                caseSensitive: fc.boolean(),
                includeMissing: fc.boolean(),
            }).chain((c) => {
                const t = c.valueType === 'auto' ? types[0] : c.valueType
                const one = valueOf[spec.types.length === 1 ? spec.types[0] : t]
                const value = spec.arity === 'none' ? fc.constant(undefined)
                    : spec.arity === 'duration' ? fc.constantFrom('P30D', 'PT12H', 'P1Y', 'P1DT6H')
                        : spec.arity === 'pair' ? fc.tuple(one, one)
                            : spec.arity === 'many' ? fc.array(one, { minLength: 1, maxLength: 3 })
                                : one
                return value.map((v) => ({ kind: 'property', ...c, value: v } as PropertyPredicate))
            })
        })

    const meaning = (p: Predicate | null) => {
        const q = p as PropertyPredicate
        const op = q.op ?? 'eq'
        const arity = arityOf(op)
        return {
            key: q.key, op,
            value: arity === 'none' ? undefined
                : arity === 'duration' ? String(q.value).toUpperCase() : q.value,
            type: arity === 'none' || OPERATOR_TABLE[op].types.length === 1 ? null : predicateType(q),
            caseSensitive: arity !== 'none' && !!q.caseSensitive,
            includeMissing: isNegative(op) && !!q.includeMissing,
        }
    }

    it('any typed comparison survives a round trip', () => {
        fc.assert(fc.property(comparison, (p) => {
            expect(meaning(roundTrip(p))).toEqual(meaning(p))
        }), { numRuns: 400 })
    })
})


// ---------------------------------------------------------------------------
// Code mode shows every condition, and never changes one. A condition the
// words can't spell (within N hops, a path, a depth-bounded descendantOf…)
// used to print as `[withinHops]` and come back as a name search.
// ---------------------------------------------------------------------------

describe('predicateDsl — Code mode never rewrites a condition', () => {
    const roundTrip = (p: Predicate) => parsePredicate(stringifyPredicate(p)).predicate
    const text = (over: Record<string, unknown>): Predicate => ({
        kind: 'text', value: 'orders', target: 'name', match: 'substring',
        caseSensitive: false, boost: 1, ...over,
    } as Predicate)

    it.each<[string, Predicate]>([
        ['within hops', { kind: 'withinHops', urns: ['urn:a'], hops: 2, direction: 'both',
            edgeClass: 'lineage' } as Predicate],
        ['a path', { kind: 'path', sourceUrns: ['urn:a'], targetUrns: ['urn:b'], maxHops: 4,
            edgeClass: 'lineage', direction: 'outgoing' } as Predicate],
        ['a degree', { kind: 'degree', op: 'gt', value: 3, direction: 'out' } as Predicate],
        ['every entity', { kind: 'all' } as Predicate],
        ['a depth-bounded descendantOf', { kind: 'descendantOf', urns: ['urn:x'], maxDepth: 1 }],
        ['a lineage test on named edges', { kind: 'isRoot', edgeClass: 'lineage',
            edgeTypes: ['FEEDS'] } as Predicate],
        ['text in any field', text({ target: 'any' })],
        ['an exact name', text({ match: 'exact' })],
        ['a case-sensitive name', text({ value: 'Orders', caseSensitive: true })],
        ['text in tags', text({ value: 'pii', target: 'tags' })],
        ['a name that starts with', text({ match: 'prefix' })],
        ['a qualified name that ends with', text({ target: 'qualifiedName', match: 'suffix' })],
        ['a word that reads as a lineage test', text({ value: 'orphans' })],
        ['a value with spaces round it', text({ value: ' orders ' })],
    ])('keeps %s', (_, p) => {
        expect(roundTrip(p)).toEqual(p)
    })

    it('keeps a condition it cannot spell in its place in a group', () => {
        const p = { kind: 'group', op: 'and', children: [
            text({}), { kind: 'withinHops', urns: ['urn:a'], hops: 2 },
        ] } as Predicate
        expect(stringifyPredicate(p)).toMatch(/^orders AND \{/)
        expect(roundTrip(p)).toEqual(p)
    })

    it('still writes a condition it can spell as words', () => {
        expect(stringifyPredicate(text({}))).toBe('orders')
        expect(stringifyPredicate({ kind: 'descendantOf', urns: ['urn:x'] })).toBe('descendantOf IN ("urn:x")')
    })

    it('refuses JSON that is not a condition, never searching for it', () => {
        for (const input of ['{"urns": ["a"]}', '{"kind": "withinHops"', '[1, 2]']) {
            const r = parsePredicate(input)
            if (input.startsWith('[')) continue       // not JSON syntax: an ordinary word
            expect(r.error).toBeTruthy()
            expect(r.fallbackText).toEqual([])
        }
    })

    it('any text search survives a round trip', () => {
        const search = fc.record({
            value: fc.string({ maxLength: 12 }),
            target: fc.constantFrom('name', 'qualifiedName', 'description', 'tags', 'any'),
            match: fc.constantFrom('substring', 'prefix', 'suffix', 'exact'),
            caseSensitive: fc.boolean(),
        }).map((over) => text(over))
        fc.assert(fc.property(search, (p) => {
            expect(roundTrip(p)).toEqual(p)
        }), { numRuns: 400 })
    })
})
