/**
 * Smoke tests for the plain-English renderer that powers the
 * "What this means" disclosure. Verifies the human-readable phrases
 * for representative leaves + the structural framing of AND / OR /
 * NOT groups. Uses ``render`` + ``container.textContent`` to assert
 * on the rendered text without re-implementing the JSX tree.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import { formatPredicateAsSentence } from '../predicateSentence'


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
            .toContain('has a property whose name contains "owner"')
        expect(rendered({ kind: 'hasProperty', key: 'pii', keyMatch: 'prefix', negate: true } as Predicate))
            .toContain('does not have a property whose name starts with "pii"')
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
