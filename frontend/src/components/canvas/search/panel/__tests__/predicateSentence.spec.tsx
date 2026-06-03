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
