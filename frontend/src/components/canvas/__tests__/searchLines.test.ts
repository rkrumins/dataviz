/**
 * searchLineIds — the Graph canvas lines a Connections search lights: a raw
 * line by id or by its ends and type, a projected line by the visible
 * containers and type, a roll-up by the containers alone; never a
 * containment match, and nothing for a match folded into one container.
 */
import { describe, expect, it } from 'vitest'

import type { MatchedEdge } from '@/store/searchStore'

import { type DrawnGraphLine, searchLineIds } from '../searchLines'


const match = (source: string, target: string, type = 'TRANSFORMS', id = `${source}|${type}|${target}`): MatchedEdge => ({
    key: id, id, source, target, edgeType: type, sourceChain: [], targetChain: [],
})

const line = (id: string, source: string, target: string, type = 'TRANSFORMS', more: Partial<DrawnGraphLine> = {}): DrawnGraphLine => ({
    id, source, target, _isContainment: false, data: { edgeType: type }, ...more,
})

// a1 and a2 fold into A, b1 into B; everything else is drawn as itself.
const FOLDS: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B' }
const visibleOf = (id: string) => FOLDS[id] ?? id
const isContainment = (type: string) => type.toUpperCase() === 'CONTAINS'

describe('searchLineIds', () => {
    it('finds a raw line by its id, or by its ends and type', () => {
        const lines = [line('e-1', 'x', 'y'), line('e-2', 'y', 'z', 'transforms')]
        expect([...searchLineIds([match('x', 'y', 'TRANSFORMS', 'e-1'), match('y', 'z')], lines, visibleOf, isContainment)])
            .toEqual(['e-1', 'e-2'])
    })

    it('finds the line between the visible containers its ends fold into, for its type', () => {
        const lines = [line('proj:e-7', 'A', 'B'), line('proj:e-8', 'A', 'B', 'PRODUCES')]
        expect([...searchLineIds([match('a1', 'b1', 'PRODUCES')], lines, visibleOf, isContainment)]).toEqual(['proj:e-8'])
    })

    it('falls back to the roll-up between them', () => {
        const lines = [line('agg:A->B', 'A', 'B', 'AGGREGATED', { data: { edgeType: 'AGGREGATED', isAggregated: true } })]
        expect([...searchLineIds([match('a1', 'b1'), match('a2', 'b1')], lines, visibleOf, isContainment)]).toEqual(['agg:A->B'])
    })

    it('lights nothing for containment, a match inside one container, or one with no line', () => {
        const lines = [line('c-1', 'A', 'B', 'CONTAINS', { _isContainment: true }), line('e-1', 'x', 'y')]
        expect(searchLineIds([match('A', 'B', 'CONTAINS', 'c-1'), match('a1', 'a2'), match('q', 'r')], lines, visibleOf, isContainment).size)
            .toBe(0)
    })
})
