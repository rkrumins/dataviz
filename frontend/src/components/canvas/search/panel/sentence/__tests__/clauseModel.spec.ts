/**
 * A query as the Sentence builder lays it out — the subject, one line per
 * clause, a relationship's relative named on its line and its conditions
 * below — and edits that land exactly where each line's condition lives.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import {
    andWith, buildSentence, getAt, insertAt, listedClauses, parentOf, pathKey, setAt, type SentenceLine,
} from '../clauseModel'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })
const tag = (...values: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values })
const all = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const any = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'or', children })
const named = (name: string): Predicate => ({ kind: 'is', refs: [{ path: ['**', name] }] })

/** Each line as "depth|kind|lead", the shape a reader sees. */
const shape = (lines: SentenceLine[]) => lines.map((l) => `${l.depth}|${l.kind}|${l.lead}`)


describe('buildSentence — the lines', () => {
    it('starts every query with what it finds', () => {
        const { lines } = buildSentence(null)
        expect(shape(lines)).toEqual(['0|subject|Find', '1|add|'])
        expect(lines[0]).toMatchObject({ types: [], path: null })
    })

    it('makes a leading "type is" the subject', () => {
        const { lines } = buildSentence(all(type('dataset'), tag('PII'), { kind: 'isLeaf' }))
        expect(shape(lines)).toEqual(['0|subject|Find', '1|clause|that', '1|clause|and', '1|add|'])
        expect(lines[0]).toMatchObject({ types: ['dataset'], topIndex: 0 })
        expect(lines[1]).toMatchObject({ topIndex: 1, path: [{ child: 1 }] })
    })

    it('finds anything when the query names no type first', () => {
        const { lines } = buildSentence(tag('PII'))
        expect(lines[0]).toMatchObject({ types: [], path: null, topIndex: null })
        expect(lines[1]).toMatchObject({ kind: 'clause', lead: 'that', topIndex: 0, path: [{ child: 0 }] })
    })

    it('joins attribute clauses with "where" and the rest with the operator', () => {
        const owner: Predicate = { kind: 'property', key: 'owner', op: 'eq', value: 'alice' }
        expect(shape(buildSentence(any(owner, tag('x'))).lines))
            .toEqual(['0|subject|Find', '1|clause|where', '1|clause|or', '1|add|'])
        expect(buildSentence(all(type('t'), tag('x'), owner)).lines[2].lead).toBe('and where')
    })

    it('names a relationship\'s relative on its line, and its other conditions below', () => {
        const feeds: Predicate = { kind: 'related', axis: 'downstream', maxHops: 3,
            where: all(type('chart'), { kind: 'related', axis: 'ancestor', where: named('Finance') }) }
        const { lines } = buildSentence(all(type('dataset'), feeds))
        // A named relative is what it's named: nothing to add to it.
        expect(shape(lines)).toEqual([
            '0|subject|Find', '1|relation|that', '2|relation|↳ that', '2|add|', '1|add|'])
        const relation = lines[1]
        expect(relation.kind === 'relation' && relation.relative)
            .toEqual({ kind: 'types', types: ['chart'], path: [{ child: 1 }, { where: true }, { child: 0 }] })
        const inside = lines[2]
        expect(inside.kind === 'relation' && inside.relative)
            .toMatchObject({ kind: 'names', orInside: false })
        expect(inside.relationDepth).toBe(1)
    })

    it('reads a container question as one relative: the container or anything inside it', () => {
        const refs = [{ path: ['**', 'Sales'] }]
        const q: Predicate = { kind: 'related', axis: 'upstream', maxHops: 3,
            where: any({ kind: 'is', refs }, { kind: 'related', axis: 'ancestor', where: { kind: 'is', refs } }) }
        const line = buildSentence(q).lines[1]
        expect(line.kind === 'relation' && line.relative).toMatchObject({ kind: 'names', orInside: true, refs })
    })

    it('lists a subject\'s any-of clauses as its own, joined by "or"', () => {
        const { lines, combine } = buildSentence(all(type('dataset'), any(tag('a'), tag('b'))))
        expect(combine).toBe('or')
        expect(shape(lines)).toEqual(['0|subject|Find', '1|clause|that', '1|clause|or', '1|add|'])
        expect(lines[1]).toMatchObject({ topIndex: 1, path: [{ child: 1 }, { child: 0 }] })
        expect(lines[2]).toMatchObject({ topIndex: 2, combines: true })
        expect(lines[3]).toMatchObject({ kind: 'add', into: [{ child: 1 }], joiner: 'or' })
    })

    it('marks the words that join the listed clauses — every one after the first', () => {
        const { lines } = buildSentence(all(type('dataset'), tag('a'), tag('b')))
        expect(lines.map((l) => !!l.combines)).toEqual([false, false, true, false])
    })

    it('shows a group among other clauses as a heading with its clauses beneath', () => {
        const { lines } = buildSentence(all(type('dataset'), tag('x'), any(tag('a'), tag('b'))))
        expect(shape(lines)).toEqual([
            '0|subject|Find', '1|clause|that', '1|group|and', '2|clause|that', '2|clause|or', '2|add|', '1|add|'])
        expect(lines[2]).toMatchObject({ op: 'or', topIndex: 2 })
    })

    it('hands a relationship nested past what the server allows to Code', () => {
        let p: Predicate = { kind: 'related', axis: 'parent' }
        for (let i = 0; i < 4; i++) p = { kind: 'related', axis: 'parent', where: p }
        expect(buildSentence(p).lines.some((l) => l.kind === 'code')).toBe(true)
    })
})


describe('listedClauses — what a sentence lists', () => {
    it('lists every top-level clause when there is no subject', () => {
        expect(listedClauses(any(tag('a'), tag('b')))).toEqual({
            subject: null, combine: 'or', into: [],
            clauses: [{ predicate: tag('a'), path: [{ child: 0 }] }, { predicate: tag('b'), path: [{ child: 1 }] }],
        })
    })

    it('takes a leading type as the subject, of an all-of query only', () => {
        expect(listedClauses(all(type('t'), tag('a'))).subject).toEqual({ types: ['t'], predicate: type('t') })
        expect(listedClauses(any(type('t'), tag('a'))).subject).toBeNull()
    })

    it('keeps a container question one clause, not an any-of list', () => {
        const refs = [{ path: ['**', 'Sales'] }]
        const inside = any({ kind: 'is', refs }, { kind: 'related', axis: 'ancestor', where: { kind: 'is', refs } })
        const listed = listedClauses(all(type('t'), inside))
        expect(listed).toMatchObject({ combine: 'and', into: [] })
        expect(listed.clauses).toEqual([{ predicate: inside, path: [{ child: 1 }] }])
    })
})


describe('clauseModel — edits', () => {
    const draft = all(type('dataset'), tag('PII'),
        { kind: 'related', axis: 'downstream', where: all(type('chart'), tag('Finance')) })

    it('reads what a path points at', () => {
        expect(getAt(draft, [{ child: 1 }])).toEqual(tag('PII'))
        expect(getAt(draft, [{ child: 2 }, { where: true }, { child: 1 }])).toEqual(tag('Finance'))
        expect(getAt(tag('x'), [{ child: 0 }])).toEqual(tag('x'))
        expect(getAt(draft, [{ child: 9 }])).toBeNull()
    })

    it('replaces a clause where it stands', () => {
        const next = setAt(draft, [{ child: 1 }], tag('GDPR'))
        expect(getAt(next, [{ child: 1 }])).toEqual(tag('GDPR'))
        expect(getAt(next, [{ child: 0 }])).toEqual(type('dataset'))
    })

    it('removes a clause, and the query collapses as the builders keep it', () => {
        expect(setAt(all(type('a'), tag('b')), [{ child: 1 }], null)).toEqual(type('a'))
        expect(setAt(tag('x'), [{ child: 0 }], null)).toBeNull()
    })

    it('tidies a relationship\'s condition as parts go', () => {
        const left = setAt(draft, [{ child: 2 }, { where: true }, { child: 1 }], null)
        expect(getAt(left, [{ child: 2 }])).toEqual({ kind: 'related', axis: 'downstream', where: type('chart') })
        const bare = setAt(left, [{ child: 2 }, { where: true }], null)
        expect(getAt(bare, [{ child: 2 }])).toEqual({ kind: 'related', axis: 'downstream' })
    })

    it('adds a clause to the query, a group or a relationship\'s condition', () => {
        expect(getAt(insertAt(draft, [], { kind: 'isLeaf' }), [{ child: 3 }])).toEqual({ kind: 'isLeaf' })
        const into = [{ child: 2 }, { where: true }] as const
        expect(getAt(insertAt(draft, into, tag('Certified')), [...into, { child: 2 }])).toEqual(tag('Certified'))
        const bare: Predicate = { kind: 'related', axis: 'upstream' }
        expect(insertAt(bare, [{ child: 0 }, { where: true }], type('dataset')))
            .toEqual({ kind: 'related', axis: 'upstream', where: type('dataset') })
        expect(insertAt(null, [], tag('x'))).toEqual(tag('x'))
    })

    it('names a line by its path, and finds its group', () => {
        expect(pathKey([{ child: 2 }, { where: true }, { child: 0 }])).toBe('2.w.0')
        expect(parentOf([{ child: 2 }, { where: true }, { child: 1 }]))
            .toEqual({ into: [{ child: 2 }, { where: true }], index: 1 })
        expect(parentOf([{ child: 2 }, { where: true }])).toBeNull()
    })

    it('adds a condition every match must meet, whatever joins the query\'s own', () => {
        expect(andWith(null, tag('x'))).toEqual(tag('x'))
        expect(andWith(type('dataset'), tag('x'))).toEqual(all(type('dataset'), tag('x')))
        expect(andWith(all(type('dataset'), tag('a')), tag('x'))).toEqual(all(type('dataset'), tag('a'), tag('x')))
        expect(andWith(any(tag('a'), tag('b')), tag('x'))).toEqual(all(any(tag('a'), tag('b')), tag('x')))
    })
})
