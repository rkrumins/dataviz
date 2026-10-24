/**
 * Smoke tests for the plain-English renderer that powers the
 * "What this means" disclosure. Verifies the human-readable phrases
 * for representative leaves + the structural framing of AND / OR /
 * NOT groups. Uses ``render`` + ``container.textContent`` to assert
 * on the rendered text without re-implementing the JSX tree.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { rememberUrnLabels } from '@/lib/urnLabels'
import type { Predicate } from '@/types/search'

import { formatPredicateAsSentence } from '../predicateSentence'
import { QuerySentence } from '../QuerySentence'


function leaf(value: string): Predicate {
    return {
        kind: 'text', value, target: 'name',
        match: 'substring', caseSensitive: false, boost: 1.0,
    }
}


function rendered(p: Predicate | null): string {
    const { container } = render(<>{formatPredicateAsSentence(p)}</>)
    return container.textContent ?? ''
}


describe('predicateSentence — plain-English summary', () => {
    it('handles null/empty draft with onboarding copy', () => {
        const text = rendered(null)
        expect(text).toContain('Show me entities')
        expect(text).toContain('no filters yet')
    })

    it('renders a single text leaf as a sentence', () => {
        const text = rendered(leaf('t2'))
        expect(text).toContain('Show me entities where')
        expect(text).toContain('name contains')
        expect(text).toContain('t2')
    })

    it('renders an OR root as "any of these is true"', () => {
        const draft: Predicate = {
            kind: 'group', op: 'or',
            children: [leaf('a'), leaf('b')],
        }
        const text = rendered(draft)
        expect(text).toContain('any of these is true')
        expect(text).toContain('a')
        expect(text).toContain('b')
    })

    it('renders an AND root as "all of these are true"', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('x'), leaf('y')],
        }
        const text = rendered(draft)
        expect(text).toContain('all of these are true')
    })

    it('renders NOT at root with "do NOT match"', () => {
        const draft: Predicate = {
            kind: 'group', op: 'not',
            children: [leaf('blocked')],
        }
        const text = rendered(draft)
        expect(text).toContain('do NOT match')
        expect(text).toContain('blocked')
    })

    it('renders NOT-of-OR as "do NOT match any of"', () => {
        const draft: Predicate = {
            kind: 'group', op: 'not',
            children: [{
                kind: 'group', op: 'or',
                children: [leaf('T1'), leaf('SILVER')],
            }],
        }
        const text = rendered(draft)
        expect(text).toContain('do NOT match')
        expect(text).toContain('any of')
        expect(text).toContain('T1')
        expect(text).toContain('SILVER')
    })

    it('renders the user example with mixed AND/OR', () => {
        // (t2 AND (account OR opp)) OR (T1 AND contacts)
        const draft: Predicate = {
            kind: 'group', op: 'or',
            children: [
                {
                    kind: 'group', op: 'and',
                    children: [
                        leaf('t2'),
                        {
                            kind: 'group', op: 'or',
                            children: [leaf('account'), leaf('opp')],
                        },
                    ],
                },
                {
                    kind: 'group', op: 'and',
                    children: [leaf('T1'), leaf('contacts')],
                },
            ],
        }
        const text = rendered(draft)
        expect(text).toContain('any of these is true')
        expect(text).toContain('t2')
        expect(text).toContain('account')
        expect(text).toContain('opp')
        expect(text).toContain('T1')
        expect(text).toContain('contacts')
    })

    it('reads a condition matching every entity as that, not as unknown', () => {
        const text = rendered({ kind: 'all' } as Predicate)
        expect(text).toContain('every entity')
        expect(text).not.toContain('unknown')
    })

    it('renders entityType leaf naturally', () => {
        const draft: Predicate = {
            kind: 'entityType', op: 'in',
            values: ['dataset', 'container'],
        }
        const text = rendered(draft)
        expect(text).toContain('type is one of')
        expect(text).toContain('dataset')
        expect(text).toContain('container')
    })

    it('renders tag leaf as "tagged"', () => {
        const draft: Predicate = {
            kind: 'tag', op: 'hasAny',
            values: ['PII'],
        }
        const text = rendered(draft)
        expect(text).toContain('tagged')
        expect(text).toContain('PII')
    })
})


describe('predicateSentence — property values read as what they are', () => {
    const prop = (op: string, value: unknown): Predicate =>
        ({ kind: 'property', key: 'gvHash', op, value } as Predicate)

    it('quotes text and leaves numbers bare', () => {
        expect(rendered(prop('eq', 'gold'))).toContain('"gvHash" is "gold"')
        expect(rendered(prop('eq', 15))).toContain('"gvHash" equals 15')
        expect(rendered(prop('gt', 15))).toContain('"gvHash" is greater than 15')
        expect(rendered(prop('eq', true))).toContain('"gvHash" is true')
    })

    it('reads a 64-bit integer as the number it is, though it travels as text', () => {
        const typed = (op: string, value: unknown, valueType: string): Predicate =>
            ({ kind: 'property', key: 'gvHash', op, value, valueType } as Predicate)
        expect(rendered(typed('eq', '-3746471915534727923', 'number')))
            .toContain('"gvHash" equals -3746471915534727923')
        expect(rendered(typed('between', ['1', '9007199254740993'], 'number')))
            .toContain('is between 1 and 9007199254740993')
        expect(rendered(typed('eq', 'true', 'boolean'))).toContain('"gvHash" is true')
        // A text operator on a number reads its digits: still quoted.
        expect(rendered(typed('contains', '74', 'number'))).toContain('"gvHash" contains "74"')
    })

    it('says each operator the way its type reads', () => {
        const typed = (op: string, value: unknown, valueType: string, extra = {}): Predicate =>
            ({ kind: 'property', key: 'updated', op, value, valueType, ...extra } as Predicate)
        expect(rendered(typed('gte', '2024-05-01', 'date'))).toContain('"updated" is on or after "2024-05-01"')
        expect(rendered(typed('withinLast', 'P30D', 'date'))).toContain('"updated" is within the last 30 days')
        expect(rendered(typed('isNotSet', undefined, 'string'))).toMatch(/"updated" is not set\.$/)
        expect(rendered(typed('neq', 'x', 'string', { includeMissing: true })))
            .toContain('"updated" is not "x" (or not set)')
        expect(rendered(typed('contains', 'Ab', 'string', { caseSensitive: true })))
            .toContain('contains "Ab" (match case)')
    })

    it('reads a search by property name', () => {
        expect(rendered({ kind: 'hasProperty', key: 'owner', keyMatch: 'contains' } as Predicate))
            .toContain('entities that have a property whose name contains "owner"')
        expect(rendered({ kind: 'hasProperty', key: 'pii', keyMatch: 'prefix', negate: true } as Predicate))
            .toContain('entities that do not have a property whose name starts with "pii"')
    })

    it('shows a range as both ends and a list as its items', () => {
        expect(rendered(prop('between', [10, 20]))).toContain('is between 10 and 20')
        expect(rendered(prop('in', ['a', 'b']))).toContain('is one of "a", "b"')
    })

    it('shows a missing value as a gap, not as the empty string', () => {
        const text = rendered(prop('contains', ''))
        expect(text).toContain('"gvHash" contains …')
        expect(text).not.toContain('""')
    })
})


describe('predicateSentence — relationships and names', () => {
    const type = (value: string): Predicate => ({ kind: 'entityType', op: 'in', values: [value] })
    const named = (...path: string[]): Predicate => ({ kind: 'is', refs: [{ path }] })
    const plain = (p: Predicate, opts?: Parameters<typeof formatPredicateAsSentence>[1]) => {
        const { container } = render(<>{formatPredicateAsSentence(p, opts)}</>)
        return (container.textContent ?? '').replace(/\s+/g, ' ').replace(/["“”]/g, '')
    }

    // As the panel's one-line summary reads them.
    it.each<[string, Predicate, string]>([
        ['a parent', { kind: 'related', axis: 'parent', where: type('domain') },
            'Anything that has a parent where type is domain.'],
        ['a named parent', { kind: 'related', axis: 'parent', where: named('Finance') },
            'Anything that has a parent that is Finance.'],
        ['the top-level container', { kind: 'related', axis: 'root', where: named('Country') },
            'Anything that has a top-level container that is Country.'],
        ['no source', { kind: 'related', axis: 'upstream', quantifier: 'none' }, 'Anything that has no source.'],
        ['every child', { kind: 'related', axis: 'child', quantifier: 'all', where: type('column') },
            'Anything that has children, every one where type is column.'],
        ['every child, by a verb', { kind: 'related', axis: 'child', quantifier: 'all',
            where: { kind: 'related', axis: 'upstream' } },
            'Anything that has children, and every one has a source.'],
        ['a count', { kind: 'related', axis: 'child', count: { op: 'gt', value: 100 }, where: type('column') },
            'Anything that has more than 100 children where type is column.'],
        ['a count, by a verb', { kind: 'related', axis: 'child', count: { op: 'gt', value: 2 },
            where: { kind: 'related', axis: 'upstream' } },
            'Anything that has more than 2 children that have a source.'],
        ['one of a count', { kind: 'related', axis: 'upstream', count: { op: 'eq', value: 1 } },
            'Anything that has exactly 1 source.'],
        ['hops and edges', { kind: 'related', axis: 'downstream', maxHops: 3,
            edge: { kind: 'edgeProperty', key: 'mode', op: 'eq', value: 'stream' } },
            'Anything that has a target within 1–3 hops through edges where mode is stream.'],
        ['edges after the condition', { kind: 'related', axis: 'downstream',
            where: { kind: 'related', axis: 'ancestor', where: named('Tableau') },
            edge: { kind: 'edgeProperty', key: 'logic', op: 'eq', value: 'Direct Query' } },
            'Anything that has a target that has an ancestor that is Tableau, through edges where logic is Direct Query.'],
        ['a container question', { kind: 'related', axis: 'upstream', maxHops: 3,
            where: { kind: 'group', op: 'or', children: [named('Sales'),
                { kind: 'related', axis: 'ancestor', where: named('Sales') }] } },
            'Anything that has a source within 1–3 hops that is or is inside Sales.'],
        ['edges after every one', { kind: 'related', axis: 'downstream', quantifier: 'all',
            where: type('column'), edge: { kind: 'edgeProperty', key: 'mode', op: 'eq', value: 'stream' } },
            'Anything that has targets, every one where type is column, through edges where mode is stream.'],
        ['levels', { kind: 'related', axis: 'ancestor', minHops: 2, maxHops: 4 },
            'Anything that has an ancestor 2–4 levels away.'],
        ['a named entity', named('Sales', 'orders'), 'Anything that is Sales / orders.'],
        ['named entities', { kind: 'is', refs: [{ path: ['a'] }, { path: ['b'] }] }, 'Anything that is one of a, b.'],
        ['inside by name', { kind: 'descendantOf', urns: [], refs: [{ path: ['Country', 'UK'] }] },
            'Anything that is inside Country / UK.'],
        ['lineage', { kind: 'hasIncoming' }, 'Anything that has incoming lineage edges.'],
        ['a tag', { kind: 'tag', op: 'hasAny', values: ['PII'] }, 'Anything that is tagged #PII.'],
        ['routes', { kind: 'path', sourceUrns: [], sourceRefs: [{ path: ['**', 'channel'] }], targetUrns: [],
            targetWhere: { kind: 'related', axis: 'ancestor', where: named('Commerce') }, maxHops: 2 },
            'Anything that lies on a route from ** / channel to anything that has an ancestor that is Commerce (up to 2 hops).'],
    ])('reads %s', (_, p, sentence) => {
        expect(plain(p, { leadIn: 'Anything', singular: true })).toBe(sentence)
    })

    it('makes its verbs agree with a lead-in naming several', () => {
        expect(plain({ kind: 'related', axis: 'parent', where: named('Finance') }))
            .toBe('Show me entities that have a parent that is Finance.')
        expect(plain({ kind: 'group', op: 'not', children: [type('column')] }, { leadIn: 'Anything', singular: true }))
            .toBe('Anything that does NOT match type is column.')
    })

    it('names an entity by the name it is remembered by, not its URN', () => {
        rememberUrnLabels([{ urn: 'urn:li:container:commerce_b2417b80', displayName: 'Commerce' }])
        expect(plain({ kind: 'related', axis: 'downstream', maxHops: 3,
            where: { kind: 'is', refs: [{ urn: 'urn:li:container:commerce_b2417b80' }] } },
        { leadIn: 'Anything', singular: true }))
            .toBe('Anything that has a target within 1–3 hops that is Commerce.')
    })
})


describe('predicateSentence — every kind, word for word', () => {
    const type = (value: string): Predicate => ({ kind: 'entityType', op: 'in', values: [value] })
    const text = (target: string, match: string, value: string): Predicate =>
        ({ kind: 'text', value, target, match, caseSensitive: false, boost: 1 } as Predicate)
    const plain = (p: Predicate, singular = true) => {
        const { container } = render(<>{formatPredicateAsSentence(p, singular
            ? { leadIn: 'Anything', singular: true } : {})}</>)
        return (container.textContent ?? '').replace(/\s+/g, ' ').replace(/["“”]/g, '')
    }

    it.each<[string, Predicate, string]>([
        ['name contains', text('name', 'substring', 't2'), 'Anything where name contains t2.'],
        ['qualified name exactly', text('qualifiedName', 'exact', 'a.b'),
            'Anything where qualified name is exactly a.b.'],
        ['description starts with', text('description', 'prefix', 'x'),
            'Anything where description starts with x.'],
        ['tags end with', text('tags', 'suffix', 'y'), 'Anything where tags ends with y.'],
        ['any field', text('any', 'substring', 'z'), 'Anything where any text field contains z.'],
        ['one type', type('dataset'), 'Anything where type is dataset.'],
        ['not these types', { kind: 'entityType', op: 'notIn', values: ['dataset', 'column'] },
            'Anything where type is not one of dataset / column.'],
        ['all of these tags', { kind: 'tag', op: 'hasAll', values: ['PII', 'GDPR'] },
            'Anything that is tagged with all of #PII, #GDPR.'],
        ['not tagged', { kind: 'tag', op: 'notHas', values: ['PII'] },
            'Anything that is NOT tagged with #PII.'],
        ['a layer', { kind: 'layer', layerAssignment: 'gold' }, 'Anything where layer is gold.'],
        ['a property set', { kind: 'hasProperty', key: 'owner' } as Predicate,
            'Anything that has a owner property.'],
        ['a property missing', { kind: 'hasProperty', key: 'owner', negate: true } as Predicate,
            'Anything that does not have a owner property.'],
        ['no upstream', { kind: 'isRoot' }, 'Anything that has no upstream lineage.'],
        ['no downstream', { kind: 'isLeaf' }, 'Anything that has no downstream lineage.'],
        ['no lineage', { kind: 'isOrphan' }, 'Anything that has no lineage edges.'],
        ['downstream lineage', { kind: 'hasOutgoing' }, 'Anything that has outgoing lineage edges.'],
        ['near, downstream', { kind: 'withinHops', urns: [], refs: [{ path: ['Sales'] }], hops: 2,
            direction: 'out' } as Predicate, 'Anything that is ≤ 2 hops downstream of Sales.'],
        ['near, either way', { kind: 'withinHops', urns: [], refs: [{ path: ['Sales'] }], hops: 1,
            direction: 'both' } as Predicate, 'Anything that is ≤ 1 hop within Sales.'],
        ['edge count', { kind: 'degree', direction: 'in', op: 'gte', value: 3 } as Predicate,
            'Anything that has in edges gte 3.'],
        ['no child', { kind: 'related', axis: 'child', quantifier: 'none', where: type('column') },
            'Anything that has no child where type is column.'],
        ['a descendant', { kind: 'related', axis: 'descendant', where: type('column') },
            'Anything that has a descendant where type is column.'],
        ['linked either way', { kind: 'related', axis: 'neighbor', maxHops: 2 },
            'Anything that has a linked entity within 1–2 hops.'],
        ['several subtrees', { kind: 'descendantOf', urns: [], refs: [{ path: ['a'] }, { path: ['b'] }] },
            'Anything that is inside 2 subtrees.'],
        ['routes between named', { kind: 'path', sourceUrns: [], targetUrns: [],
            sourceRefs: [{ path: ['a'] }, { path: ['b'] }], targetRefs: [{ path: ['c'] }] } as Predicate,
            'Anything that lies on a route from any of a, b to c (up to 4 hops).'],
        ['a NOT inside all', { kind: 'group', op: 'and', children: [type('dataset'),
            { kind: 'group', op: 'not', children: [{ kind: 'tag', op: 'hasAny', values: ['PII'] }] }] },
            'Anything where all of these are true:type is datasetNOT is tagged #PII'],
        ['an any-of inside all', { kind: 'group', op: 'and', children: [type('dataset'),
            { kind: 'group', op: 'or', children: [text('name', 'substring', 'a'), text('name', 'substring', 'b')] }] },
            'Anything where all of these are true:type is dataset(name contains a OR name contains b)'],
    ])('reads %s', (_, p, sentence) => {
        expect(plain(p)).toBe(sentence)
    })

    it('reads a shape for several entities', () => {
        expect(plain({ kind: 'isLeaf' }, false)).toBe('Show me entities that have no downstream lineage.')
    })
})


describe('QuerySentence — the container a query looks inside', () => {
    it('shows a container named by its path as the scope chip', () => {
        const { container } = render(<QuerySentence draftPredicate={{ kind: 'group', op: 'and', children: [
            leaf('orders'),
            { kind: 'descendantOf', urns: [], refs: [{ path: ['Country', 'UK'] }] },
        ] }} />)
        expect(container.textContent).toContain('inside Country / UK')
    })
})
