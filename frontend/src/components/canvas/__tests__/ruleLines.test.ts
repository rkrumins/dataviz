/**
 * ruleLineLooks — the Graph canvas lines the relationship rules paint: a
 * relationship drawn as itself paints its line; one folded into a line
 * between visible containers paints that line, whichever of its members
 * matched; a roll-up is never painted. The first rule in the list gives the
 * look, every rule showing its chip adds it; entity rules paint no line.
 */
import { describe, expect, it } from 'vitest'

import type { DisplayRuleTag } from '@/store/displayRuleMatchStore'

import { dashArrayOf, type HeldRelationship, RULE_LINE_WIDTH, ruleLineLooks } from '../ruleLines'
import type { DrawnGraphLine } from '../searchLines'


const rel = (id: string, source: string, target: string, edgeType = 'TRANSFORMS'): HeldRelationship => ({
    id, source, target, data: { edgeType },
})

const line = (id: string, source: string, target: string, more: Partial<DrawnGraphLine> = {}): DrawnGraphLine => ({
    id, source, target, _isContainment: false, data: { edgeType: 'TRANSFORMS' }, ...more,
})

const rule = (id: string, over: Partial<DisplayRuleTag> = {}): DisplayRuleTag => ({
    id, name: id, color: '#ef4444', target: 'relationships', ...over,
})

// a1 and a2 fold into A, b1 into B; x and y are drawn as themselves.
const FOLDS: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B' }
const visibleOf = (id: string) => FOLDS[id] ?? id
const isContainment = (type: string) => type.toUpperCase() === 'CONTAINS'

const RELATIONSHIPS = [rel('e-1', 'x', 'y'), rel('e-2', 'a1', 'b1'), rel('e-3', 'a2', 'b1'), rel('e-4', 'a1', 'b1', 'CONTAINS')]
// e-2 and e-3 are bundled into one line between A and B, under e-2's id.
const LINES = [
    line('e-1', 'x', 'y'),
    line('proj:e-2', 'A', 'B'),
    line('agg:A->B', 'A', 'B', { data: { edgeType: 'AGGREGATED', isAggregated: true } }),
]

const looks = (rules: DisplayRuleTag[], matches: Record<string, string[]>, lines = LINES) =>
    ruleLineLooks(rules, new Map(Object.entries(matches).map(([k, v]) => [k, new Set(v)])),
        RELATIONSHIPS, lines, visibleOf, isContainment)


describe('ruleLineLooks', () => {
    it('paints the line a relationship is drawn on as itself, in the rule’s look', () => {
        const out = looks([rule('fast', { style: { dash: 'dotted', width: 4 } })], { fast: ['e-1'] })
        expect([...out.keys()]).toEqual(['e-1'])
        expect(out.get('e-1')).toMatchObject({ color: '#ef4444', dash: 'dotted', width: 4 })
        expect(out.get('e-1')!.chips.map((c) => c.id)).toEqual(['fast'])
    })

    it('paints a bundled line when any relationship it stands for matches', () => {
        expect([...looks([rule('r')], { r: ['e-3'] }).keys()]).toEqual(['proj:e-2'])
    })

    it('never paints a roll-up, nor a containment relationship', () => {
        const rolledUp = LINES.filter((l) => !l.id.startsWith('proj:'))
        expect(looks([rule('r')], { r: ['e-2', 'e-3', 'e-4'] }, rolledUp).size).toBe(0)
    })

    it('takes the first rule’s look, and every chip shown', () => {
        const out = looks([
            rule('first', { color: '#10b981' }),
            rule('quiet', { color: '#3b82f6', style: { chip: false, dash: 'dashed' } }),
            rule('second', { color: '#f59e0b' }),
        ], { first: ['e-1'], quiet: ['e-1'], second: ['e-1'] })
        const look = out.get('e-1')!
        expect(look).toMatchObject({ color: '#10b981', width: RULE_LINE_WIDTH })
        expect(look.dash).toBeUndefined()
        expect(look.chips.map((c) => c.id)).toEqual(['first', 'second'])
    })

    it('leaves lines to the rules that style relationships', () => {
        expect(looks([rule('tags', { target: undefined })], { tags: ['e-1'] }).size).toBe(0)
    })

    it('scales a dash to the line’s width', () => {
        expect(dashArrayOf('dashed', 2)).toBe('6 4')
        expect(dashArrayOf('dotted', 3)).toBe('0 6')
        expect(dashArrayOf(undefined, 3)).toBeUndefined()
    })
})
