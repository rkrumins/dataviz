/**
 * Tests for the multi-select "Group selected as AND / OR" mutator.
 *
 * The function wraps a subset of a group's children into a new
 * sub-group of the chosen op at the position of the first selected
 * index. Drives the floating BulkGroupActionBar.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import { groupChildrenAtPath } from '../predicateComposition'


function leaf(value: string): Predicate {
    return {
        kind: 'text', value, target: 'name',
        match: 'substring', caseSensitive: false, boost: 1.0,
    }
}


describe('groupChildrenAtPath — multi-select grouping', () => {
    it('wraps two root children into a new OR group at the first index', () => {
        // Start: AND(a, b, c)
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('a'), leaf('b'), leaf('c')],
        }
        // Select indices 0 and 2 → expect AND(OR(a, c), b)
        const next = groupChildrenAtPath(draft, '', [0, 2], 'or') as any
        expect(next.kind).toBe('group')
        expect(next.op).toBe('and')
        expect(next.children).toHaveLength(2)
        expect(next.children[0].op).toBe('or')
        expect(next.children[0].children[0].value).toBe('a')
        expect(next.children[0].children[1].value).toBe('c')
        expect(next.children[1].value).toBe('b')
    })

    it('wraps two adjacent children into AND at the first index', () => {
        const draft: Predicate = {
            kind: 'group', op: 'or',
            children: [leaf('x'), leaf('y'), leaf('z')],
        }
        // Select 0 and 1 → expect OR(AND(x, y), z)
        const next = groupChildrenAtPath(draft, '', [0, 1], 'and') as any
        expect(next.op).toBe('or')
        expect(next.children).toHaveLength(2)
        expect(next.children[0].op).toBe('and')
        expect(next.children[0].children.map((c: any) => c.value)).toEqual(['x', 'y'])
        expect(next.children[1].value).toBe('z')
    })

    it('walks into a nested group via the path', () => {
        // Start: OR(AND(a, b, c), d)
        const draft: Predicate = {
            kind: 'group', op: 'or',
            children: [
                {
                    kind: 'group', op: 'and',
                    children: [leaf('a'), leaf('b'), leaf('c')],
                },
                leaf('d'),
            ],
        }
        // Selection is inside the inner AND group at path "0", indices [1, 2]
        const next = groupChildrenAtPath(draft, '0', [1, 2], 'or') as any
        // Expect: OR(AND(a, OR(b, c)), d)
        expect(next.op).toBe('or')
        const inner = next.children[0]
        expect(inner.op).toBe('and')
        expect(inner.children).toHaveLength(2)
        expect(inner.children[0].value).toBe('a')
        expect(inner.children[1].op).toBe('or')
        expect(inner.children[1].children.map((c: any) => c.value)).toEqual(['b', 'c'])
    })

    it('returns draft unchanged when fewer than 2 indices', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('a'), leaf('b')],
        }
        expect(groupChildrenAtPath(draft, '', [], 'or')).toBe(draft)
        expect(groupChildrenAtPath(draft, '', [0], 'or')).toBe(draft)
    })

    it('returns draft unchanged when path resolves to a non-group', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('a'), leaf('b')],
        }
        // Path '0' points at a leaf, not a group → no-op.
        expect(groupChildrenAtPath(draft, '0', [0, 1], 'or')).toBe(draft)
    })

    it('returns draft unchanged when an index is out of range', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('a'), leaf('b')],
        }
        expect(groupChildrenAtPath(draft, '', [0, 5], 'or')).toBe(draft)
    })

    it('preserves insertion order of picked children', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [leaf('a'), leaf('b'), leaf('c')],
        }
        // User clicked c first, then a → indices = [2, 0]
        const next = groupChildrenAtPath(draft, '', [2, 0], 'or') as any
        // Insert position = min(2, 0) = 0 → expect OR(c, a), b
        expect(next.children[0].op).toBe('or')
        expect(next.children[0].children.map((c: any) => c.value)).toEqual(['c', 'a'])
        expect(next.children[1].value).toBe('b')
    })
})
