/**
 * Regression: buildRunnablePredicate must preserve the draft's root
 * group op. The old implementation hard-coded `op: 'and'` when the
 * draft had 2+ top-level conditions, which silently rewrote OR-rooted
 * queries into AND at execution time while the explain panel kept
 * displaying the original OR Cypher. Net effect: complex queries like
 *
 *   t2 AND (account OR opp) OR NOT T1
 *
 * showed correct OR Cypher in /explain but the actual /search/advanced
 * call executed an AND of the children — usually returning 0 matches.
 */
import { describe, expect, it } from 'vitest'

import { parsePredicate } from '../predicateDsl'
import { buildRunnablePredicate } from '../runnablePredicate'


describe('buildRunnablePredicate — preserves root op', () => {
    it('OR-rooted draft stays OR-rooted in the runnable', () => {
        const draft = parsePredicate('t2 AND (account OR opp) OR NOT T1').predicate
        const r = buildRunnablePredicate(draft)
        expect(r).not.toBeNull()
        const pred = r!.predicate as any
        expect(pred.kind).toBe('group')
        expect(pred.op).toBe('or')
        expect(pred.children).toHaveLength(2)
        expect(pred.children[0].op).toBe('and')
        expect(pred.children[1].op).toBe('not')
    })

    it('simple OR (A OR B) stays OR', () => {
        const draft = parsePredicate('t2 OR account').predicate
        const r = buildRunnablePredicate(draft)
        const pred = r!.predicate as any
        expect(pred.op).toBe('or')
        expect(pred.children).toHaveLength(2)
    })

    it('AND-rooted draft stays AND', () => {
        const draft = parsePredicate('t2 AND account').predicate
        const r = buildRunnablePredicate(draft)
        const pred = r!.predicate as any
        expect(pred.op).toBe('and')
    })

    it('single-leaf draft is returned un-wrapped', () => {
        const draft = parsePredicate('orders').predicate
        const r = buildRunnablePredicate(draft)
        const pred = r!.predicate as any
        expect(pred.kind).toBe('text')
        expect(pred.value).toBe('orders')
    })

    it('NOT-rooted draft stays NOT', () => {
        const draft = parsePredicate('NOT silver').predicate
        const r = buildRunnablePredicate(draft)
        const pred = r!.predicate as any
        expect(pred.kind).toBe('group')
        expect(pred.op).toBe('not')
    })

    it('OR root with 3 children preserves OR', () => {
        const draft = parsePredicate('a OR b OR c').predicate
        const r = buildRunnablePredicate(draft)
        const pred = r!.predicate as any
        expect(pred.op).toBe('or')
        expect(pred.children).toHaveLength(3)
    })

    it('null draft returns null', () => {
        expect(buildRunnablePredicate(null)).toBeNull()
    })
})
