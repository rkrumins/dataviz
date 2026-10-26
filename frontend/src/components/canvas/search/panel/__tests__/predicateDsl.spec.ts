import { describe, it, expect } from 'vitest'
import { parsePredicate, stringifyPredicate } from '../predicateDsl'
import {
    appendCondition,
    duplicateConditionAt,
    setRootGroupOp,
    wrapConditionAt,
} from '../predicateComposition'
import fc from 'fast-check'

import type { Predicate, PropertyPredicate, RelatedPredicate } from '@/types/search'
import { OPERATOR_TABLE, type PropertyOperator } from '@/types/generated/searchOperators'

import { arityOf, isNegative, predicateType } from '../../typed/operators'
import { axisMeta } from '../relations'

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

describe('predicateDsl — a quoted value after a prefix', () => {
    it.each<[string, Predicate, string]>([
        ['tag:"PII data"', { kind: 'tag', op: 'hasAny', values: ['PII data'] }, 'tag:"PII data"'],
        ['tag:"a, b"', { kind: 'tag', op: 'hasAny', values: ['a, b'] }, 'tag:"a, b"'],
        ['type:"data set"', { kind: 'entityType', op: 'in', values: ['data set'] }, 'type:"data set"'],
        ['layer:"Reporting layer"', { kind: 'layer', layerAssignment: 'Reporting layer' }, 'layer:"Reporting layer"'],
        ['layer:"Reporting"', { kind: 'layer', layerAssignment: 'Reporting' }, 'layer:Reporting'],
        ['code:"007"', { kind: 'property', key: 'code', op: 'eq', value: '007' } as Predicate, 'code = "007"'],
    ])('reads %s as one value and writes it back', (text, predicate, written) => {
        expect(parsePredicate(text).predicate).toEqual(predicate)
        expect(stringifyPredicate(predicate)).toBe(written)
        expect(parsePredicate(written).predicate).toEqual(predicate)
    })

    it('writes several values, one of them quoted, in the IN form', () => {
        const p: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII data', 'GDPR'] }
        expect(stringifyPredicate(p)).toBe('tag IN ("PII data", GDPR)')
        expect(parsePredicate(stringifyPredicate(p)).predicate).toEqual(p)
    })

    it('reads one inside a relationship, and only right after the colon', () => {
        expect(parsePredicate('feeds*..3(layer:"Reporting layer")').predicate).toEqual({
            kind: 'related', axis: 'downstream', maxHops: 3,
            where: { kind: 'layer', layerAssignment: 'Reporting layer' },
        })
        // A space after the colon leaves the words a name search, as before.
        expect(parsePredicate('layer: "x"').predicate).toMatchObject({ kind: 'group', op: 'and' })
    })
})


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
        ['every entity', { kind: 'all' } as Predicate],
        ['a depth-bounded descendantOf', { kind: 'descendantOf', urns: ['urn:x'], maxDepth: 1 }],
        ['a graph shape with edge types still to pick', { kind: 'isRoot', edgeTypes: [] } as Predicate],
        ['an edge count with edge types still to pick', { kind: 'degree', direction: 'in', op: 'gt',
            value: 1, edgeTypes: [] } as Predicate],
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


describe('predicateDsl — relationships and names', () => {
    const parse = (text: string) => parsePredicate(text).predicate
    const roundTrip = (p: Predicate) => parsePredicate(stringifyPredicate(p)).predicate
    const type = (value: string): Predicate => ({ kind: 'entityType', op: 'in', values: [value] })
    const named = (...path: string[]): Predicate => ({ kind: 'is', refs: [{ path }] })

    it.each<[string, Predicate]>([
        ['parent(type:domain)', { kind: 'related', axis: 'parent', where: type('domain') }],
        ['root(@"Country")', { kind: 'related', axis: 'root', where: named('Country') }],
        ['every child(description IS NOT EMPTY)', { kind: 'related', axis: 'child', quantifier: 'all',
            where: { kind: 'property', key: 'description', op: 'isNotEmpty' } }],
        ['no fedBy()', { kind: 'related', axis: 'upstream', quantifier: 'none' }],
        ['count(child(type:column)) > 100', { kind: 'related', axis: 'child', where: type('column'),
            count: { op: 'gt', value: 100 } }],
        ['feeds*..3(type:dashboard).via(confidence >= 0.8)', { kind: 'related',
            axis: 'downstream', maxHops: 3, where: type('dashboard'),
            edge: { kind: 'edgeProperty', key: 'confidence', op: 'gte', value: 0.8 } }],
        ['fedBy*2()', { kind: 'related', axis: 'upstream', minHops: 2, maxHops: 2 }],
        ['ancestor*2..4(type:domain)', { kind: 'related', axis: 'ancestor', minHops: 2, maxHops: 4,
            where: type('domain') }],
        ['descendant*2..()', { kind: 'related', axis: 'descendant', minHops: 2 }],
        ['feeds(fedBy(@"Sales/orders"))', { kind: 'related', axis: 'downstream',
            where: { kind: 'related', axis: 'upstream', where: named('Sales', 'orders') } }],
        ['@"Country/United Kingdom"', named('Country', 'United Kingdom')],
        ['@"a\\/b/c"', named('a/b', 'c')],
        ['@"urn:li:dataset:1"', { kind: 'is', refs: [{ urn: 'urn:li:dataset:1' }] }],
        ['inside @"Country/**/London"', { kind: 'descendantOf', urns: [],
            refs: [{ path: ['Country', '**', 'London'] }], uiScope: 'name' } as Predicate],
    ])('reads and writes %s', (text, p) => {
        expect(parse(text)).toEqual(p)
        expect(stringifyPredicate(p)).toBe(text)
    })

    it('reads an edge filter as conditions on the edges walked', () => {
        expect(parse('upstream().via(has:transform OR NOT has:x)')).toEqual({
            kind: 'related', axis: 'upstream', edge: { kind: 'edgeGroup', op: 'or', children: [
                { kind: 'edgeHasProperty', key: 'transform' },
                { kind: 'edgeGroup', op: 'not', children: [{ kind: 'edgeHasProperty', key: 'x' }] },
            ] },
        })
    })

    it('keeps an axis word without its parenthesis a text search', () => {
        for (const text of ['root cause', 'parent (x)', 'every child', 'count', 'no upstream',
            'feeds', 'linked to', 'outgoing (x)', 'edges']) {
            const r = parsePredicate(text)
            expect(r.error).toBeUndefined()
            expect(JSON.stringify(r.predicate)).not.toContain('related')
        }
    })

    it.each([
        ['count(type:x) > 1', /takes a relationship/],
        ['count(child()) > -1', /whole number/],
        ['count(child()) > 1.5', /whole number/],
        ['parent*2(type:x)', /takes no hop range/],
        ['upstream*(type:x)', /how far/],
        ['parent(type:x).via(mode = stream)', /follows a connection/],
        ['type:x .via(mode = stream)', /follows a relationship/],
        ['upstream().via(type:x)', /edges walked/],
        ['parent(type:x', /Missing "\)"/],
    ])('refuses %s', (text, why) => {
        expect(parsePredicate(text).error).toMatch(why)
    })

    it.each<[string, Predicate]>([
        ['a relationship through edge types still to pick', { kind: 'related', axis: 'upstream',
            edgeTypes: [] }],
        ['a relationship naming both edge types and a class', { kind: 'related', axis: 'upstream',
            edgeTypes: ['FEEDS'], edgeClass: 'links' }],
        ['a reference narrowed by type', { kind: 'is', refs: [{ path: ['Sales'], entityType: 'domain' }] }],
        ['a case-insensitive reference', { kind: 'is', refs: [{ path: ['sales'], caseSensitive: false }] }],
        ['several references', { kind: 'is', refs: [{ path: ['a'] }, { path: ['b'] }] }],
        ['a name with a quote', named('say "hi"')],
        ['a depth-bounded subtree by name', { kind: 'descendantOf', urns: [], refs: [{ path: ['a'] }],
            maxDepth: 2 } as Predicate],
    ])('writes %s as JSON, which reads back as it is', (_, p) => {
        expect(stringifyPredicate(p)).toMatch(/^\{/)
        expect(roundTrip(p)).toEqual(p)
    })

    it('writes a subtree named by path in words, with or without its editor hint', () => {
        expect(stringifyPredicate({ kind: 'descendantOf', urns: [], refs: [{ path: ['Country', 'UK'] }] }))
            .toBe('inside @"Country/UK"')
    })

    it('any relationship the editor builds survives a round trip in words', () => {
        const segment = fc.constantFrom('Country', 'United Kingdom', 'a/b', 'Zürich', '東京', "O'Brien")
        const leaf: fc.Arbitrary<Predicate> = fc.oneof(
            fc.constantFrom('dataset', 'domain', 'column').map(type),
            fc.constantFrom('PII', 'gold').map((v): Predicate => ({ kind: 'tag', op: 'hasAny', values: [v] })),
            fc.constantFrom('owner', 'region').map((key): Predicate => ({ kind: 'hasProperty', key, negate: false })),
            fc.constantFrom('EMEA', 'Sales').map((value): Predicate => ({ kind: 'property', key: 'region',
                op: 'eq', value })),
            fc.tuple(segment, fc.boolean(), segment).map(([a, deep, b]) => deep ? named(a, '**', b) : named(a, b)),
        )
        const edge = fc.constantFrom<NonNullable<RelatedPredicate['edge']>>(
            { kind: 'edgeProperty', key: 'mode', op: 'eq', value: 'stream' },
            { kind: 'edgeHasProperty', key: 'transform' },
            { kind: 'edgeGroup', op: 'or', children: [
                { kind: 'edgeHasProperty', key: 'transform' },
                { kind: 'edgeProperty', key: 'confidence', op: 'gte', value: 0.8 }] },
        )
        const relation = (depth: number): fc.Arbitrary<Predicate> => fc.record({
            axis: fc.constantFrom<RelatedPredicate['axis']>('parent', 'child', 'ancestor', 'descendant', 'root',
                'upstream', 'downstream', 'neighbor'),
            lead: fc.constantFrom('any', 'none', 'all', 'count'),
            count: fc.record({ op: fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte'),
                value: fc.nat(1000) }),
            lo: fc.integer({ min: 1, max: 3 }),
            span: fc.option(fc.integer({ min: 0, max: 2 })),
            where: fc.option(depth < 3
                ? fc.oneof(leaf, relation(depth + 1), fc.tuple(leaf, fc.oneof(leaf, relation(depth + 1)),
                    fc.constantFrom<'and' | 'or'>('and', 'or')).map(([a, b, op]): Predicate => ({ kind: 'group', op,
                    children: [a, b] })))
                : leaf),
            edge: fc.option(edge),
            through: fc.constantFrom<'lineage' | 'links' | string[]>('lineage', 'links', ['PRODUCES'],
                ['TAGGED_WITH', 'DEFINED_BY'], ['produces']),
        }).map(({ axis, lead, count, lo, span, where, edge: e, through }) => {
            const meta = axisMeta(axis)
            const p: RelatedPredicate = { kind: 'related', axis }
            if (lead === 'count') p.count = count as RelatedPredicate['count']
            else if (lead !== 'any') p.quantifier = lead as 'none' | 'all'
            // The hops the editor writes: lineage always has a reach; a
            // tree axis may look any depth down or up.
            if (meta.hops) {
                const hi = span === null ? null : lo + span
                if (lo > 1) p.minHops = lo
                if (meta.lineage) {
                    const reach = hi ?? lo
                    if (reach > 1) p.maxHops = reach
                } else if (hi !== null) p.maxHops = hi
            }
            if (where) p.where = where
            if (e && meta.lineage) p.edge = e
            if (meta.lineage && through === 'links') p.edgeClass = 'links'
            else if (meta.lineage && Array.isArray(through)) p.edgeTypes = through
            return p
        })
        fc.assert(fc.property(relation(1), (p) => {
            const text = stringifyPredicate(p)
            expect(text).not.toContain('{')
            expect(parse(text)).toEqual(p)
        }), { numRuns: 400 })
    })
})


describe('predicateDsl — connections, edge types and edge counts', () => {
    const parse = (text: string) => parsePredicate(text).predicate
    const type = (value: string): Predicate => ({ kind: 'entityType', op: 'in', values: [value] })
    const tag = (value: string): Predicate => ({ kind: 'tag', op: 'hasAny', values: [value] })
    const both = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })

    it.each<[string, Predicate]>([
        // Lineage reads as what it does; any link, or edge types, in neutral words.
        ['linkedTo[lineage](type:dataset)', { kind: 'related', axis: 'neighbor', where: type('dataset') }],
        ['linkedTo(type:glossaryTerm)', { kind: 'related', axis: 'neighbor', edgeClass: 'links',
            where: type('glossaryTerm') }],
        ['outgoing(type:dataset)', { kind: 'related', axis: 'downstream', edgeClass: 'links',
            where: type('dataset') }],
        ['incoming*..2()', { kind: 'related', axis: 'upstream', maxHops: 2, edgeClass: 'links' }],
        ['outgoing[PRODUCES](type:dataset AND tag:PII)', { kind: 'related', axis: 'downstream',
            edgeTypes: ['PRODUCES'], where: both(type('dataset'), tag('PII')) }],
        ['incoming[PRODUCES, CONSUMES](type:dataJob)', { kind: 'related', axis: 'upstream',
            edgeTypes: ['PRODUCES', 'CONSUMES'], where: type('dataJob') }],
        ['no incoming[PRODUCES]()', { kind: 'related', axis: 'upstream', quantifier: 'none',
            edgeTypes: ['PRODUCES'] }],
        ['count(outgoing[PRODUCES](type:dataset)) > 10', { kind: 'related', axis: 'downstream',
            edgeTypes: ['PRODUCES'], where: type('dataset'), count: { op: 'gt', value: 10 } }],
        ['linkedTo[DEFINED_BY]*..2(type:glossaryTerm).via(confidence >= 0.8)', { kind: 'related',
            axis: 'neighbor', maxHops: 2, edgeTypes: ['DEFINED_BY'], where: type('glossaryTerm'),
            edge: { kind: 'edgeProperty', key: 'confidence', op: 'gte', value: 0.8 } }],
        // Containment at both ends: what is inside it feeds what is inside Finance.
        ['descendant(feeds*..3(type:dashboard AND ancestor(@"Finance")))', { kind: 'related',
            axis: 'descendant', where: { kind: 'related', axis: 'downstream', maxHops: 3,
                where: both(type('dashboard'), { kind: 'related', axis: 'ancestor',
                    where: { kind: 'is', refs: [{ path: ['Finance'] }] } }) } }],
        // Graph shapes, over the edges they name.
        ['noUpstream', { kind: 'isRoot', edgeClass: 'lineage' }],
        ['noIncoming', { kind: 'isRoot', edgeClass: 'links' }],
        ['noOutgoing', { kind: 'isLeaf', edgeClass: 'links' }],
        ['hasIncoming', { kind: 'hasIncoming', edgeClass: 'links' }],
        ['hasOutgoing[containment]', { kind: 'hasOutgoing', edgeClass: 'containment' }],
        ['noLinks', { kind: 'isOrphan', edgeClass: 'links' }],
        ['noEdges', { kind: 'isOrphan', edgeClass: 'any' }],
        ['noEdges[containment]', { kind: 'isOrphan', edgeClass: 'containment' }],
        ['noIncoming[any]', { kind: 'isRoot', edgeClass: 'any' }],
        ['noIncoming[DEFINED_BY]', { kind: 'isRoot', edgeTypes: ['DEFINED_BY'] }],
        ['noEdges[TAGGED_WITH, DEFINED_BY]', { kind: 'isOrphan', edgeTypes: ['TAGGED_WITH', 'DEFINED_BY'] }],
        // Edge counts: any link unless the brackets say otherwise.
        ['edges(out) > 10', { kind: 'degree', direction: 'out', op: 'gt', value: 10, edgeClass: 'links' }],
        ['edges[PRODUCES](in) >= 2', { kind: 'degree', direction: 'in', op: 'gte', value: 2,
            edgeTypes: ['PRODUCES'] }],
        ['edges[lineage](both) = 0', { kind: 'degree', direction: 'both', op: 'eq', value: 0,
            edgeClass: 'lineage' }],
        ['type:dataset AND edges[any](both) < 3', both(type('dataset'),
            { kind: 'degree', direction: 'both', op: 'lt', value: 3, edgeClass: 'any' })],
    ])('reads and writes %s', (text, p) => {
        expect(parse(text)).toEqual(p)
        expect(stringifyPredicate(p)).toBe(text)
    })

    it.each<[string, Predicate]>([
        ['no upstream()', { kind: 'related', axis: 'upstream', quantifier: 'none' }],
        ['downstream*..3(type:dashboard)', { kind: 'related', axis: 'downstream', maxHops: 3,
            where: type('dashboard') }],
        ['upstream*2()', { kind: 'related', axis: 'upstream', minHops: 2, maxHops: 2 }],
        ['neighbor(type:dataset)', { kind: 'related', axis: 'neighbor', where: type('dataset') }],
        ['downstream(upstream(type:x))', { kind: 'related', axis: 'downstream',
            where: { kind: 'related', axis: 'upstream', where: type('x') } }],
        ['noUpstreamLineage', { kind: 'isRoot', edgeClass: 'lineage' }],
        ['no_downstream', { kind: 'isLeaf', edgeClass: 'lineage' }],
        ['orphans', { kind: 'isOrphan', edgeClass: 'lineage' }],
        ['hasDownstream', { kind: 'hasOutgoing', edgeClass: 'lineage' }],
    ])('reads the older spelling %s the same', (text, p) => {
        expect(parse(text)).toEqual(p)
    })

    it.each<[string, Predicate]>([
        // A bracket on any connection word: feeding is what lineage does.
        ['feeds[links](type:x)', { kind: 'related', axis: 'downstream', edgeClass: 'links', where: type('x') }],
        ['fedBy[PRODUCES]()', { kind: 'related', axis: 'upstream', edgeTypes: ['PRODUCES'] }],
        ['outgoing[lineage]()', { kind: 'related', axis: 'downstream' }],
        ['noUpstream[DEFINED_BY]', { kind: 'isRoot', edgeTypes: ['DEFINED_BY'] }],
        // Any case; the edges before or after the steps; spaces in the brackets.
        ['FEEDS(type:x)', { kind: 'related', axis: 'downstream', where: type('x') }],
        ['LinkedTo()', { kind: 'related', axis: 'neighbor', edgeClass: 'links' }],
        ['outgoing*..3[ PRODUCES ,CONSUMES ](type:x)', { kind: 'related', axis: 'downstream', maxHops: 3,
            edgeTypes: ['PRODUCES', 'CONSUMES'], where: type('x') }],
        ['noincoming[Links]', { kind: 'isRoot', edgeClass: 'links' }],
        ['EDGES[produces](IN) != 1', { kind: 'degree', direction: 'in', op: 'neq', value: 1,
            edgeTypes: ['produces'] }],
    ])('reads %s', (text, p) => {
        expect(parse(text)).toEqual(p)
    })

    it.each<[string, Predicate, string]>([
        // A graph shape names the edges it counts; edge types make the class moot.
        ['a shape over named edges', { kind: 'isRoot', edgeClass: 'lineage', edgeTypes: ['FEEDS'] },
            'noIncoming[FEEDS]'],
        ['an edge count over lineage by default', { kind: 'degree', op: 'gt', value: 3, direction: 'out' },
            'edges[lineage](out) > 3'],
        ['an edge count both ways by default', { kind: 'degree', value: 0, edgeClass: 'links' } as Predicate,
            'edges(both) = 0'],
    ])('writes %s as words meaning the same', (_, p, text) => {
        expect(stringifyPredicate(p)).toBe(text)
    })

    it.each([
        ['parent[PRODUCES](type:x)', /follows the hierarchy, which takes no edge types/],
        ['child[links]()', /follows the hierarchy/],
        ['outgoing[](type:x)', /Name edge types between the brackets/],
        ['outgoing[ , ](type:x)', /Name edge types between the brackets/],
        ['outgoing[links, PRODUCES](x)', /not both/],
        ['linkedTo[any](x)', /\[lineage\], \[links\] or edge types, not \[any\]/],
        ['outgoing[PRODUCES]*..3[CONSUMES](x)', /once/],
        ['noIncoming[]', /Name edge types/],
        ['edges(sideways) > 1', /which way/],
        ['edges(out) > 1.5', /whole number/],
        ['edges(out)', /whole number/],
        ['edges[links, any](in) > 1', /not both/],
        ['count(edges(out) > 1) > 2', /takes a relationship/],
        ['outgoing[PRODUCES', /Close the edge types with \]/],
    ])('refuses %s', (text, why) => {
        expect(parsePredicate(text).error).toMatch(why)
    })

    it('points a bracket’s error at its word', () => {
        const input = 'type:x AND parent[PRODUCES](type:y)'
        const r = parsePredicate(input)
        expect(input.slice(r.errorAt!.from, r.errorAt!.to)).toBe('parent[PRODUCES](')
    })

    it('says what an edge word was read as', () => {
        const roles = (input: string) => parsePredicate(input).tokens.map((t) => `${t.text}:${t.role}`)
        expect(roles('outgoing[PRODUCES, CONSUMES](x) noEdges[any] edges(in) > 2')).toEqual([
            'outgoing[PRODUCES, CONSUMES](:function', 'x:text', '):punct', 'noEdges[any]:keyword',
            'edges(:function', 'in:keyword', '):punct', '>:operator', '2:value',
        ])
    })

    it('any edge count or graph shape the Form builds survives a round trip in words', () => {
        const set = fc.constantFrom<{ edgeClass?: 'lineage' | 'links' | 'any' | 'containment'; edgeTypes?: string[] }>(
            { edgeClass: 'lineage' }, { edgeClass: 'links' }, { edgeClass: 'any' }, { edgeClass: 'containment' },
            { edgeTypes: ['PRODUCES'] }, { edgeTypes: ['TAGGED_WITH', 'DEFINED_BY'] })
        const shape = fc.tuple(
            fc.constantFrom('isRoot', 'isLeaf', 'isOrphan', 'hasIncoming', 'hasOutgoing'), set,
        ).map(([kind, s]) => ({ kind, ...s }) as Predicate)
        const degree = fc.tuple(fc.record({
            direction: fc.constantFrom('in', 'out', 'both'),
            op: fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte'),
            value: fc.nat(1000),
        }), set).map(([d, s]) => ({ kind: 'degree', ...d, ...s }) as Predicate)
        fc.assert(fc.property(fc.oneof(shape, degree), (p) => {
            const text = stringifyPredicate(p)
            expect(text).not.toContain('{')
            expect(parse(text)).toEqual(p)
        }), { numRuns: 300 })
    })
})


describe('predicateDsl — one property against another', () => {
    const parse = (text: string) => parsePredicate(text).predicate
    const keyed = (over: Partial<PropertyPredicate>): Predicate =>
        ({ kind: 'property', key: 'freshnessHours', op: 'gt', valueKey: 'slaHours', ...over } as Predicate)

    it.each<[string, Predicate]>([
        ['freshnessHours > {slaHours}', keyed({})],
        ['freshnessHours <= {slaHours}', keyed({ op: 'lte' })],
        ['owner = {steward} MATCH CASE', keyed({ key: 'owner', op: 'eq', valueKey: 'steward', caseSensitive: true })],
        ['updatedAt >= {reviewedAt} AS DATE', keyed({ key: 'updatedAt', op: 'gte', valueKey: 'reviewedAt',
            valueType: 'date' })],
        // The type is written only where it isn't the one a key comparison takes anyway.
        ['freshnessHours > {slaHours} AS TEXT', keyed({ valueType: 'string' })],
        ['"Asset Owner" != {Steward Name}', keyed({ key: 'Asset Owner', op: 'neq', valueKey: 'Steward Name' })],
    ])('reads and writes %s', (text, p) => {
        expect(parse(text)).toEqual(p)
        expect(stringifyPredicate(p)).toBe(text)
    })

    it('leaves out a type the comparison takes anyway', () => {
        expect(stringifyPredicate(keyed({ valueType: 'number' }))).toBe('freshnessHours > {slaHours}')
        expect(stringifyPredicate(keyed({ op: 'eq', valueType: 'string' }))).toBe('freshnessHours = {slaHours}')
    })

    it.each([
        ['freshnessHours != {slaHours} INCLUDING MISSING', /needs both/],
        ['{slaHours}', /compares a property with another/],
        ['type:dataset AND {slaHours}', /freshnessHours > \{slaHours\}/],
    ])('refuses %s', (text, why) => {
        expect(parsePredicate(text).error).toMatch(why)
    })

    it('still reads braces holding a quote or a colon as a condition written as JSON', () => {
        expect(parse('{"kind": "all"}')).toEqual({ kind: 'all' })
    })

    it('says what each part was read as', () => {
        expect(parsePredicate('freshnessHours > {slaHours}').tokens.map((t) => `${t.text}:${t.role}`))
            .toEqual(['freshnessHours:field', '>:operator', '{slaHours}:field'])
    })
})


describe('predicateDsl — what an editor reads off a parse', () => {
    const roles = (input: string) => parsePredicate(input).tokens.map((t) => `${t.text}:${t.role}`)

    it('says what each token was read as, and where it is', () => {
        expect(roles('type:dataset AND owner = "alice" upstream*..3(@"Sales/orders").via(rows > 5)')).toEqual([
            'type:dataset:prefixed', 'AND:keyword', 'owner:field', '=:operator', '"alice":value',
            'upstream*..3(:function', '@"Sales/orders":ref', '):punct', '.via(:function',
            'rows:field', '>:operator', '5:value', '):punct',
        ])
        expect(roles('notes IS NOT EMPTY customer')).toEqual([
            'notes:field', 'IS:keyword', 'NOT:keyword', 'EMPTY:keyword', 'customer:text'])
        const [first, , second] = parsePredicate('tag:PII  AND x').tokens
        expect([first.from, first.to, second.from, second.to]).toEqual([0, 7, 13, 14])
    })

    it('points an error at where it is', () => {
        const at = (input: string) => {
            const r = parsePredicate(input)
            return { error: r.error, text: r.errorAt && input.slice(r.errorAt.from, r.errorAt.to),
                     predicate: r.predicate }
        }
        // A stray ")" once read "Unexpected token at end: [object Object]"
        // and handed back the half-parsed query.
        expect(at('foo )')).toEqual({ error: 'Unexpected )', text: ')', predicate: null })
        // A comparison with no value once threw a raw TypeError.
        expect(at('rowCount >')).toMatchObject({ error: 'Expected a value after rowCount >', text: '>' })
        expect(at('(a OR b')).toMatchObject({ error: 'Missing ")" to close this "("', text: '(' })
        expect(at('parent(type:x')).toMatchObject({ error: expect.stringMatching(/Missing "\)"/), text: '' })
        expect(at('count(type:x) > 1')).toMatchObject({ text: 'type:x' })
        expect(at('a AND')).toMatchObject({ predicate: { kind: 'text' } })   // a trailing AND is let go
    })

    it('reports an unclosed quote or name instead of reading to the end', () => {
        expect(parsePredicate('name CONTAINS "acc')).toMatchObject({
            predicate: null, error: 'Close the text with "', errorAt: { from: 14, to: 18 } })
        expect(parsePredicate('upstream(@"Sales/ord')).toMatchObject({
            predicate: null, error: 'Close the name with ": @"…"', errorAt: { from: 9, to: 20 } })
    })

    it('reads a comma list inside prefix:value as one condition', () => {
        expect(parsePredicate('tag:PII,GDPR type:dataset,schemaField').predicate).toEqual({
            kind: 'group', op: 'and', children: [
                { kind: 'tag', op: 'hasAny', values: ['PII', 'GDPR'] },
                { kind: 'entityType', op: 'in', values: ['dataset', 'schemaField'] },
            ],
        })
        // …so the writer spells several values as words again, not JSON.
        expect(stringifyPredicate({ kind: 'tag', op: 'hasAny', values: ['PII', 'GDPR'] })).toBe('tag:PII,GDPR')
        // A list in brackets is still its own tokens.
        expect(parsePredicate('type IN (a, b)').predicate).toEqual(
            { kind: 'entityType', op: 'in', values: ['a', 'b'] })
    })
})
