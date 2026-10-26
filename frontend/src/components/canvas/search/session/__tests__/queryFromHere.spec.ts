import { describe, expect, it } from 'vitest'

import type { Predicate, RelatedPredicate } from '@/types/search'

import { FROM_HERE_MAX_SHARED, howItMatches, questionsFromHere } from '../queryFromHere'


const named = (axis: RelatedPredicate['axis'], urn: string, maxHops?: number): RelatedPredicate => ({
    kind: 'related', axis, ...(maxHops ? { maxHops } : {}), where: { kind: 'is', refs: [{ urn }] },
})


describe('questionsFromHere', () => {
    it('asks about one entity by walking from it', () => {
        const qs = questionsFromHere(['urn:x'])
        expect(qs.map((q) => q.id)).toEqual(['inside', 'children', 'sources', 'targets', 'linked', 'routes'])
        const by = Object.fromEntries(qs.map((q) => [q.id, q]))
        expect(by.children.predicate).toEqual(named('parent', 'urn:x'))
        // Its tags, glossary terms, jobs: any link, one step, either way.
        expect(by.linked.predicate).toEqual({ ...named('neighbor', 'urn:x'), edgeClass: 'links' })
        // What feeds X: entities whose targets include X — and the reverse.
        expect(by.sources.predicate).toEqual(named('downstream', 'urn:x', 3))
        expect(by.targets.predicate).toEqual(named('upstream', 'urn:x', 3))
        expect(by.routes).toMatchObject({ refine: true, predicate: { kind: 'path', sourceUrns: ['urn:x'] } })
    })

    it('asks what several all feed, and what feeds them all', () => {
        const [targets, sources] = questionsFromHere(['urn:a', 'urn:b'])
        expect(targets.label).toBe('What all 2 feed')
        expect(targets.predicate).toEqual({ kind: 'group', op: 'and', children: [
            named('upstream', 'urn:a', 3), named('upstream', 'urn:b', 3)] })
        expect(sources.predicate).toEqual({ kind: 'group', op: 'and', children: [
            named('downstream', 'urn:a', 3), named('downstream', 'urn:b', 3)] })
        const many = Array.from({ length: FROM_HERE_MAX_SHARED + 1 }, (_, i) => `urn:${i}`)
        expect(questionsFromHere(many)).toEqual([])
    })

    it('keeps a shared link inside its view', () => {
        expect(questionsFromHere(['urn:x'], { readOnly: true }).map((q) => q.id)).toEqual(['inside'])
        expect(questionsFromHere(['urn:a', 'urn:b'], { readOnly: true })).toEqual([])
    })

    it('takes in what is inside a container, whose lineage runs through it', () => {
        const isOrInside = (urn: string): Predicate => ({
            kind: 'group', op: 'or', children: [
                { kind: 'is', refs: [{ urn }] },
                { kind: 'related', axis: 'ancestor', where: { kind: 'is', refs: [{ urn }] } },
            ],
        })
        const by = Object.fromEntries(
            questionsFromHere(['urn:ds'], { containers: new Set(['urn:ds']) }).map((q) => [q.id, q]),
        )
        expect(by.targets.predicate).toEqual({
            kind: 'related', axis: 'upstream', maxHops: 3, where: isOrInside('urn:ds') })
        expect(by.sources.predicate).toEqual({
            kind: 'related', axis: 'downstream', maxHops: 3, where: isOrInside('urn:ds') })
        // Its children are still its own.
        expect(by.children.predicate).toEqual(named('parent', 'urn:ds'))
        // Routes start from a condition, so both ends are conditions: 3 hops.
        expect(by.routes.predicate).toMatchObject({
            kind: 'path', sourceUrns: [], sourceWhere: isOrInside('urn:ds'), maxHops: 3 })

        const [targets] = questionsFromHere(['urn:ds', 'urn:col'], { containers: new Set(['urn:ds']) })
        expect(targets.predicate).toEqual({ kind: 'group', op: 'and', children: [
            { kind: 'related', axis: 'upstream', maxHops: 3, where: isOrInside('urn:ds') },
            named('upstream', 'urn:col', 3)] })
    })
})


describe('howItMatches', () => {
    const DASHBOARD: Predicate = { kind: 'entityType', op: 'in', values: ['dashboard'] }

    it('routes along every link when that is what the relationship walked', () => {
        const TAG: Predicate = { kind: 'entityType', op: 'in', values: ['tag'] }
        expect(howItMatches({ kind: 'related', axis: 'neighbor', edgeClass: 'links', where: TAG }, 'urn:h'))
            .toEqual({ kind: 'path', sourceUrns: ['urn:h'], targetUrns: [], direction: 'any',
                edgeClass: 'links', maxHops: 1, targetWhere: TAG })
    })

    it('routes from the match to what its lineage relationship found', () => {
        const query: Predicate = { kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['dataset'] },
            { kind: 'related', axis: 'downstream', maxHops: 3, where: DASHBOARD,
              edge: { kind: 'edgeProperty', key: 'mode', op: 'eq', value: 'stream' } },
        ] }
        expect(howItMatches(query, 'urn:h')).toEqual({
            kind: 'path', sourceUrns: ['urn:h'], targetUrns: [], direction: 'outgoing',
            edgeClass: 'lineage', maxHops: 3, targetWhere: DASHBOARD,
            edgePredicate: { kind: 'edgeProperty', key: 'mode', op: 'eq', value: 'stream' },
        })
    })

    it('walks against lineage to sources, at most four hops, to anything when unconditioned', () => {
        expect(howItMatches(named('upstream', 'urn:s', 10), 'urn:h')).toMatchObject({
            direction: 'incoming', maxHops: 4, targetWhere: { kind: 'is', refs: [{ urn: 'urn:s' }] } })
        expect(howItMatches({ kind: 'related', axis: 'neighbor' }, 'urn:h')).toMatchObject({
            direction: 'any', maxHops: 1, targetWhere: { kind: 'all' } })
    })

    it('has nothing to show without relatives found through lineage', () => {
        expect(howItMatches(null, 'urn:h')).toBeNull()
        expect(howItMatches(DASHBOARD, 'urn:h')).toBeNull()
        expect(howItMatches({ kind: 'related', axis: 'parent', where: DASHBOARD }, 'urn:h')).toBeNull()
        expect(howItMatches({ kind: 'related', axis: 'upstream', quantifier: 'none' }, 'urn:h')).toBeNull()
        expect(howItMatches({ kind: 'group', op: 'or', children: [
            { kind: 'related', axis: 'upstream' }, DASHBOARD] }, 'urn:h')).toBeNull()
    })
})
