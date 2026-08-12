/**
 * Scoping a query to a container used to be hidden state inside
 * ``useAdvancedSearch``: clicking a result group pushed a drill frame
 * that ``stampScope`` gave absolute precedence over ``scope.rootUrns``,
 * and nothing ever popped it. Every query the user composed afterwards
 * was silently clamped to that one container and came back with 0
 * matches until the panel was closed and reopened.
 *
 * These tests pin the replacement: scope is a ``descendantOf`` row in
 * the draft, placed where the Cypher compiler will accept it, and it
 * leaves when the user removes it.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import { buildRunnablePredicate } from '../runnablePredicate'
import {
    findScopeCondition,
    setScopeCondition,
    type ScopeCondition,
} from '../predicateComposition'


const nameContains = (value: string): Predicate => ({
    kind: 'text', value, target: 'name',
    match: 'substring', caseSensitive: false, boost: 1,
} as Predicate)

const scopeTo = (urn: string): ScopeCondition => ({
    kind: 'descendantOf', urns: [urn], uiScope: 'any',
} as ScopeCondition)

const children = (p: Predicate | null) =>
    p && p.kind === 'group' ? p.children : []


describe('setScopeCondition', () => {
    it('adds the scope to an empty draft', () => {
        const next = setScopeCondition(null, scopeTo('urn:gold'))
        expect(next).toMatchObject({ kind: 'descendantOf', urns: ['urn:gold'] })
    })

    it('keeps existing filters, in order, and appends the scope', () => {
        const draft: Predicate = {
            kind: 'group', op: 'and',
            children: [nameContains('a'), nameContains('b')],
        }
        const next = setScopeCondition(draft, scopeTo('urn:gold'))
        expect(children(next).map((c) => c.kind))
            .toEqual(['text', 'text', 'descendantOf'])
    })

    it('replaces the previous scope rather than accumulating', () => {
        // Two descendantOf rows are ANDed as separate MATCH chains
        // server-side, so "inside A and inside B" is empty for any two
        // siblings — exactly the silent-zero this work removes.
        const scoped = setScopeCondition(
            { kind: 'group', op: 'and', children: [nameContains('a')] } as Predicate,
            scopeTo('urn:gold'),
        )
        const rescoped = setScopeCondition(scoped, scopeTo('urn:silver'))
        const scopes = children(rescoped).filter((c) => c.kind === 'descendantOf')
        expect(scopes).toHaveLength(1)
        expect(scopes[0]).toMatchObject({ urns: ['urn:silver'] })
    })

    it('nests an OR draft under a new AND root', () => {
        // DescendantOf is only legal in the top-level AND group; as a
        // sibling inside OR it is a hard CompileError.
        const draft: Predicate = {
            kind: 'group', op: 'or',
            children: [nameContains('a'), nameContains('b')],
        }
        const next = setScopeCondition(draft, scopeTo('urn:gold'))
        expect(next).toMatchObject({ kind: 'group', op: 'and' })
        expect(children(next).map((c) => c.kind)).toEqual(['group', 'descendantOf'])
        expect(children(next)[0]).toMatchObject({ op: 'or' })
    })

    it('removes the scope and leaves the rest of the query intact', () => {
        const scoped = setScopeCondition(
            { kind: 'group', op: 'and', children: [nameContains('a')] } as Predicate,
            scopeTo('urn:gold'),
        )
        const cleared = setScopeCondition(scoped, null)
        expect(cleared).toMatchObject({ kind: 'text', value: 'a' })
        expect(findScopeCondition(cleared)).toBeNull()
    })

    it('clears back to nothing when the scope was the only filter', () => {
        const scoped = setScopeCondition(null, scopeTo('urn:gold'))
        expect(setScopeCondition(scoped, null)).toBeNull()
    })
})


describe('findScopeCondition', () => {
    it('reports the active scope', () => {
        const scoped = setScopeCondition(null, scopeTo('urn:gold'))
        expect(findScopeCondition(scoped)).toMatchObject({ urns: ['urn:gold'] })
    })

    it('reports none for an unscoped draft', () => {
        expect(findScopeCondition(nameContains('a'))).toBeNull()
    })
})


describe('buildRunnablePredicate with a scope row', () => {
    it('hoists the scope out when the user flips the root to ANY', () => {
        // The row menu / root-op toggle can move a scope row into an OR
        // root after the fact, which the compiler rejects outright.
        // Reading it as "A or B, inside X" keeps the query runnable.
        const draft: Predicate = {
            kind: 'group', op: 'or',
            children: [nameContains('a'), nameContains('b'), scopeTo('urn:gold')],
        }
        const runnable = buildRunnablePredicate(draft)!
        expect(runnable.predicate).toMatchObject({ kind: 'group', op: 'and' })
        const top = children(runnable.predicate)
        expect(top.map((c) => c.kind)).toEqual(['group', 'descendantOf'])
        expect(top[0]).toMatchObject({ op: 'or' })
    })

    it('leaves an OR query with no scope row alone', () => {
        const draft: Predicate = {
            kind: 'group', op: 'or',
            children: [nameContains('a'), nameContains('b')],
        }
        expect(buildRunnablePredicate(draft)!.predicate)
            .toMatchObject({ kind: 'group', op: 'or' })
    })

    it('changes the hash when the scope changes, so the panel re-runs', () => {
        const unscoped = buildRunnablePredicate(nameContains('a'))!
        const scoped = buildRunnablePredicate(
            setScopeCondition(nameContains('a'), scopeTo('urn:gold')),
        )!
        expect(scoped.hash).not.toBe(unscoped.hash)
    })
})
