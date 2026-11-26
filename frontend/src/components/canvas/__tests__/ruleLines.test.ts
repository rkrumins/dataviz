/**
 * ruleLineLooks — the Graph canvas lines the relationship rules paint: a
 * relationship drawn as itself paints its line; one folded into a line
 * between visible containers paints that line, whichever of its members
 * matched; a roll-up is never painted. The first rule in the list gives the
 * look, every rule showing its chip adds it; entity rules paint no line.
 */
import { describe, expect, it } from 'vitest'

import type { DisplayRuleTag } from '@/store/displayRuleMatchStore'

import { dashArrayOf, type HeldRelationship, type MemberLine, memberRuleLooks, RULE_LINE_WIDTH, ruleLineLooks } from '../ruleLines'
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


// The Context View's lines: each stands for its members — raw relationships by
// their own ids, roll-ups (aggregated) and a Connections search's stand-ins.
const member = (id: string, more: Record<string, unknown> = {}) => ({ id, data: { edgeType: 'TRANSFORMS', ...more } })
const rollup = (id: string) => ({ id, data: { edgeType: 'AGGREGATED', isAggregated: true } })
const CV_LINES: MemberLine[] = [
    { id: 'bundle-x->y', data: { members: [member('e-1')] } },
    { id: 'bundle-A->B', data: { members: [member('e-2'), member('e-3')] } },           // two, one row pair
    { id: 'bundle-P->Q', data: { members: [rollup('agg-1'), member('e-5')] } },         // a roll-up and a real one
    { id: 'bundle-R->S', data: { members: [rollup('agg-2')] } },                        // only a roll-up
    { id: 'bundle-bi-M->N', data: { members: [member('e-6'), member('e-7')] } },        // both directions
    { id: 'bundle-U->V', data: { members: [{ id: 'search:k', data: {} }] } },           // a search's stand-in
]
const memberLooks = (rules: DisplayRuleTag[], matches: Record<string, string[]>, lines = CV_LINES) =>
    memberRuleLooks(rules, new Map(Object.entries(matches).map(([k, v]) => [k, new Set(v)])), lines)


describe('memberRuleLooks', () => {
    it('paints a line when any relationship it stands for matches, in the rule’s look', () => {
        const out = memberLooks([rule('r', { style: { dash: 'dotted', width: 3 } })], { r: ['e-3', 'e-7'] })
        expect([...out.keys()].sort()).toEqual(['bundle-A->B', 'bundle-bi-M->N'])
        expect(out.get('bundle-A->B')).toMatchObject({ color: '#ef4444', dash: 'dotted', width: 3 })
    })

    it('paints a line that holds a roll-up for its real relationship, never for the roll-up', () => {
        expect([...memberLooks([rule('r')], { r: ['e-5'] }).keys()]).toEqual(['bundle-P->Q'])
        expect(memberLooks([rule('r')], { r: ['agg-1', 'agg-2'] }).size).toBe(0)
    })

    it('never paints a search’s stand-in', () => {
        expect(memberLooks([rule('r')], { r: ['search:k'] }).size).toBe(0)
    })

    it('takes the first rule’s look in the view’s order, and every chip shown', () => {
        const out = memberLooks([
            rule('first', { color: '#10b981' }),
            rule('quiet', { color: '#3b82f6', style: { chip: false } }),
            rule('second', { color: '#f59e0b', style: { dash: 'dashed' } }),
        ], { first: ['e-1'], quiet: ['e-1'], second: ['e-1', 'e-2'] })
        expect(out.get('bundle-x->y')).toMatchObject({ color: '#10b981', width: RULE_LINE_WIDTH })
        expect(out.get('bundle-x->y')!.chips.map((c) => c.id)).toEqual(['first', 'second'])
        expect(out.get('bundle-A->B')).toMatchObject({ color: '#f59e0b', dash: 'dashed' })
    })

    it('leaves lines to the rules that style relationships, and to those with matches', () => {
        expect(memberLooks([rule('tags', { target: undefined })], { tags: ['e-1'] }).size).toBe(0)
        expect(memberLooks([rule('r')], { r: [] }).size).toBe(0)
    })
})
