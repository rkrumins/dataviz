/**
 * The grammar tags each part of a condition's words with what it sets, so
 * the Sentence builder can make exactly those parts clickable — and the
 * read-only sentence (pinned word for word in predicateSentence.spec) can
 * print the same words.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate, RelatedPredicate } from '@/types/search'

import {
    connector, isOrInside, leafSegments, reachSegments, relationVerb, type Segment,
} from '../sentenceGrammar'


/** The segments' words, as the read-only sentence prints them (values
 *  quoted where they are), with a relative's condition as ⟨…⟩. */
function words(segs: Segment[]): string {
    return segs.map((s) => {
        switch (s.t) {
            case 'text': return s.text
            case 'value': return s.quoted ? `"${s.text}"` : s.text
            case 'gap': return '…'
            case 'em': return s.text
            case 'note': return s.text
            case 'cond': return '⟨cond⟩'
        }
    }).join('')
}

/** What each slot-tagged segment says, slot by slot. */
function slots(segs: Segment[]): Array<[string, string]> {
    return segs.flatMap((s): Array<[string, string]> => {
        if ((s.t === 'text' || s.t === 'value') && s.slot) return [[s.slot, s.text]]
        if (s.t === 'gap' && s.slot) return [[s.slot, '…']]
        return []
    })
}


describe('sentenceGrammar — the parts a token edits', () => {
    it('sets each tag apart, for the tags token', () => {
        const segs = leafSegments({ kind: 'tag', op: 'hasAny', values: ['PII', 'GDPR'] })
        expect(words(segs)).toBe('is tagged #PII, #GDPR')
        expect(slots(segs)).toEqual([['phrase', 'is tagged'], ['tags', '#PII'], ['tags', '#GDPR']])
    })

    it('splits a comparison into its key, its operator and its value', () => {
        const segs = leafSegments({ kind: 'property', key: 'rowCount', op: 'gt', value: 100 } as Predicate)
        expect(words(segs)).toBe('"rowCount" is greater than 100')
        expect(slots(segs)).toEqual([['key', 'rowCount'], ['phrase', 'is greater than'], ['value', '100']])
    })

    it('compares with another property of the same entity, edited in the Form', () => {
        const segs = leafSegments({ kind: 'property', key: 'freshnessHours', op: 'gt',
            valueKey: 'slaHours' } as Predicate)
        expect(words(segs)).toBe('"freshnessHours" is greater than its "slaHours"')
        // The other property is said, not a token of its own.
        expect(slots(segs)).toEqual([['key', 'freshnessHours'], ['phrase', 'is greater than']])
    })

    it('leaves a gap where a value is still to be picked', () => {
        const segs = leafSegments({ kind: 'property', key: 'owner', op: 'eq', value: '' } as Predicate)
        expect(slots(segs)).toContainEqual(['value', '…'])
    })

    it('makes a shape one choice', () => {
        expect(slots(leafSegments({ kind: 'isLeaf' }, true))).toEqual([['phrase', 'have no downstream lineage']])
    })

    it('reads a relationship as its head, its reach and its condition', () => {
        const p: Predicate = { kind: 'related', axis: 'downstream', maxHops: 3,
            where: { kind: 'entityType', op: 'in', values: ['dashboard'] } }
        const segs = leafSegments(p)
        expect(words(segs)).toBe('has a target within 1–3 hops ⟨cond⟩')
        expect(slots(segs)).toEqual([['relation', 'has a target'], ['hops', 'within 1–3 hops']])
        expect(segs.find((s) => s.t === 'cond')).toMatchObject({ lead: 'connector', many: false })
    })

    it('counts relatives with a number of its own', () => {
        const segs = leafSegments({ kind: 'related', axis: 'child', count: { op: 'gt', value: 100 } } as Predicate)
        expect(slots(segs)).toEqual([['relation', 'has more than'], ['count', '100']])
    })

    it('names the ends of a route as the route\'s source and target', () => {
        const segs = leafSegments({ kind: 'path', sourceUrns: [], targetUrns: [],
            sourceRefs: [{ path: ['a'] }], targetRefs: [{ path: ['b'] }], maxHops: 2 } as Predicate)
        expect(slots(segs)).toEqual([['phrase', 'lies on a route from'], ['source', 'a'], ['target', 'b'],
            ['hops', '(up to 2 hops)']])
    })
})


describe('sentenceGrammar — shared rules', () => {
    it('joins a verb with "that" and an attribute with "where"', () => {
        expect(connector({ kind: 'tag', op: 'hasAny', values: ['x'] })).toBe('that')
        expect(connector({ kind: 'entityType', op: 'in', values: ['x'] })).toBe('where')
    })

    it('says nothing of reach for one step', () => {
        expect(reachSegments({ kind: 'related', axis: 'upstream' })).toEqual([])
        expect(reachSegments({ kind: 'related', axis: 'ancestor', minHops: 2, maxHops: 4 }))
            .toEqual([{ t: 'text', text: ' ' }, { t: 'text', text: '2–4 levels away', slot: 'hops' }])
    })

    it('recognises "is or is inside X"', () => {
        const refs = [{ path: ['Sales'] }]
        expect(isOrInside({ kind: 'group', op: 'or', children: [{ kind: 'is', refs },
            { kind: 'related', axis: 'ancestor', where: { kind: 'is', refs } }] })).toEqual(refs)
        expect(isOrInside({ kind: 'is', refs })).toBeNull()
    })
})


describe('relationVerb — a relationship read as a verb', () => {
    const rel = (over: Partial<RelatedPredicate>): RelatedPredicate => ({ kind: 'related', axis: 'downstream', ...over })

    it.each<[Partial<RelatedPredicate>, boolean, string]>([
        [{}, true, 'feed'],
        [{}, false, 'feeds'],
        [{ axis: 'upstream' }, true, 'are fed by'],
        [{ axis: 'ancestor' }, false, 'is inside'],
        [{ axis: 'child' }, true, 'directly contain'],
        [{ quantifier: 'none' }, true, 'feed no'],
        [{ quantifier: 'all', where: { kind: 'isLeaf' } }, true, 'only feed'],
        [{ axis: 'upstream', quantifier: 'all', where: { kind: 'isLeaf' } }, true, 'are only fed by'],
        // Every link, or edge types named: feeding is what lineage does.
        [{ edgeClass: 'links' }, true, 'link to'],
        [{ axis: 'upstream', edgeTypes: ['PRODUCES'] }, false, 'is linked from'],
        [{ axis: 'neighbor', edgeClass: 'links', quantifier: 'none' }, true, 'are linked to no'],
        [{ axis: 'neighbor' }, false, 'is linked to'],
        // "every" means nothing without a condition on the relatives.
        [{ quantifier: 'all' }, true, 'feed'],
        [{ count: { op: 'gte', value: 2 } }, true, 'feed at least'],
    ])('%j, several: %s → %s', (over, many, words) => {
        expect(relationVerb(rel(over), many)).toBe(words)
    })
})
