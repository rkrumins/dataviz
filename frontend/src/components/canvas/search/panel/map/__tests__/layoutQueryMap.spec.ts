/**
 * A query's shape as a diagram: what it finds in the middle, lineage left
 * to right, containers above, routes through it — each node and edge
 * opening its own token in the sentence.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import { buildSentence } from '../../sentence/clauseModel'
import { layoutQueryMap, MAP_GAP_X, MAP_NODE_H, MAP_NODE_W } from '../layoutQueryMap'


const type = (...values: string[]): Predicate => ({ kind: 'entityType', op: 'in', values })
const tag = (...values: string[]): Predicate => ({ kind: 'tag', op: 'hasAny', values })
const all = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'and', children })
const any = (...children: Predicate[]): Predicate => ({ kind: 'group', op: 'or', children })
const named = (name: string): Predicate => ({ kind: 'is', refs: [{ path: ['**', name] }] })

const mapOf = (p: Predicate | null) => layoutQueryMap(buildSentence(p))
const at = (map: ReturnType<typeof mapOf>, id: string) => map.nodes.find((n) => n.id === id)!


describe('layoutQueryMap', () => {
    it('draws one node — what the query finds — with its conditions as chips', () => {
        const map = mapOf(all(type('dataset'), tag('PII'), { kind: 'isLeaf' }))
        expect(map.nodes).toHaveLength(1)
        expect(map.edges).toEqual([])
        expect(map.nodes[0]).toMatchObject({
            id: 'subject', kind: 'subject', types: ['dataset'], token: 'subject:types', count: { of: 'total' },
            chips: ['is tagged #PII', 'has no downstream lineage'], chipsJoin: 'and',
        })
        expect([map.width, map.height]).toEqual([MAP_NODE_W, MAP_NODE_H])
    })

    it('puts what a node feeds to its right, and what feeds it to its left', () => {
        const map = mapOf(all(type('dataset'),
            { kind: 'related', axis: 'downstream', maxHops: 3, where: type('chart') },
            { kind: 'related', axis: 'upstream', where: type('table') }))
        const subject = at(map, 'subject')
        const chart = at(map, '1')
        const table = at(map, '2')
        expect(chart.x).toBeGreaterThan(subject.x)
        expect(table.x).toBeLessThan(subject.x)
        expect(chart).toMatchObject({ kind: 'relative', types: ['chart'], token: '1:rel', count: { of: 'where', clause: 1 } })
        const [feeds, fedBy] = map.edges
        expect(feeds).toMatchObject({ from: 'subject', to: '1', label: 'feeds', reach: '1–3 hops', arrow: 'end',
            tone: 'accent', dashed: false, token: '1:verb', vertical: false })
        expect(fedBy).toMatchObject({ label: 'is fed by', reach: null, arrow: 'start' })
        expect(map.width).toBe(3 * MAP_NODE_W + 2 * MAP_GAP_X)
    })

    it('sets a container above what it holds, without an arrow', () => {
        const feeds: Predicate = { kind: 'related', axis: 'downstream', maxHops: 3,
            where: all(type('chart'), { kind: 'related', axis: 'ancestor', where: named('Finance') }) }
        const map = mapOf(all(type('dataset'), feeds))
        const chart = at(map, '1')
        const finance = at(map, '1.w.1')
        expect(finance).toMatchObject({ kind: 'named', names: ['Finance'], count: null })
        expect(finance.x).toBe(chart.x)
        expect(finance.y).toBeLessThan(chart.y)
        expect(map.edges[1]).toMatchObject({ from: '1', to: '1.w.1', label: 'is inside', arrow: 'none',
            tone: 'muted', vertical: true })
    })

    it('stacks a node\'s relatives on the same side rather than overlapping them', () => {
        const map = mapOf(all(type('dataset'),
            { kind: 'related', axis: 'downstream', where: type('chart') },
            { kind: 'related', axis: 'downstream', where: type('dashboard') }))
        const [a, b] = [at(map, '1'), at(map, '2')]
        expect(a.x).toBe(b.x)
        expect(b.y).toBeGreaterThan(a.y)
    })

    it('chips a relative\'s own conditions onto it', () => {
        const map = mapOf(all(type('dataset'),
            { kind: 'related', axis: 'downstream', where: all(type('chart'), tag('Finance')) }))
        expect(at(map, '1').chips).toEqual(['is tagged #Finance'])
        expect(at(map, 'subject').chips).toEqual([])
    })

    it('dashes the alternatives of "any of", and draws an exclusion in rose', () => {
        const map = mapOf(all(type('dataset'), any(
            { kind: 'related', axis: 'downstream', where: type('chart') },
            { kind: 'related', axis: 'downstream', quantifier: 'none', where: type('dashboard') })))
        expect(at(map, 'subject').chipsJoin).toBe('or')
        expect(map.edges.map((e) => [e.dashed, e.tone])).toEqual([[true, 'accent'], [true, 'rose']])
        expect(map.edges[1].label).toBe('feeds no')
    })

    it('reads a group among other clauses as one chip, its relationships still drawn', () => {
        const map = mapOf(all(type('dataset'), tag('x'), any(tag('a'),
            { kind: 'related', axis: 'upstream', where: type('table') })))
        expect(at(map, 'subject').chips).toEqual(['is tagged #x', 'any of 2 conditions'])
        expect(map.edges).toHaveLength(1)
        expect(map.edges[0]).toMatchObject({ dashed: true, from: 'subject' })
    })

    it('draws a route from its source, through what lies on it, to its target', () => {
        const route: Predicate = { kind: 'path', sourceRefs: [{ path: ['**', 'orders'] }],
            targetRefs: [{ path: ['**', 'CFO'] }], maxHops: 5 } as Predicate
        const map = mapOf(all(type('dataset'), route))
        const source = at(map, '1:source')
        const target = at(map, '1:target')
        expect(source).toMatchObject({ kind: 'named', names: ['orders'], token: '1:0' })
        expect(source.x).toBeLessThan(at(map, 'subject').x)
        expect(target.x).toBeGreaterThan(at(map, 'subject').x)
        expect(map.edges.map((e) => [e.label, e.reach, e.dashed])).toEqual([
            ['lies on a route', 'up to 5 hops', true], ['', null, true]])
    })

    it('finds anything when the query names no type', () => {
        const map = mapOf({ kind: 'related', axis: 'child' })
        expect(at(map, 'subject').types).toEqual([])
        expect(at(map, '0')).toMatchObject({ kind: 'relative', types: [] })
        expect(at(map, '0').y).toBeGreaterThan(at(map, 'subject').y)
    })
})
