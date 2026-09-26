import { describe, it, expect, beforeEach } from 'vitest'

import { useDisplayRuleMatchStore } from '../displayRuleMatchStore'
import type { DisplayRuleConfig } from '@/types/schema'


function reset() {
    useDisplayRuleMatchStore.getState().clear()
}

function rule(over: Partial<DisplayRuleConfig> & { id: string }): DisplayRuleConfig {
    return {
        name: over.id,
        color: '#6366f1',
        predicate: { kind: 'group', op: 'and', children: [] },
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        ...over,
    }
}

/** One membership answer in which ``ruleId`` matches exactly ``urns``. */
function tag(ruleId: string, urns: string[]) {
    useDisplayRuleMatchStore.getState().applyMembership([ruleId], urns, { [ruleId]: urns })
}

function matchesOf(ruleId: string): string[] {
    return [...(useDisplayRuleMatchStore.getState().matchUrnsByRule.get(ruleId) ?? [])].sort()
}

/** Replicates ``useDisplayRuleTags`` membership logic against current
 *  store state — lets us assert the per-URN chip resolution without a
 *  React renderer. */
function tagsFor(urn: string) {
    const { matchUrnsByRule, ruleMeta } = useDisplayRuleMatchStore.getState()
    return ruleMeta.filter((m) => matchUrnsByRule.get(m.id)?.has(urn))
}


describe('displayRuleMatchStore', () => {
    beforeEach(reset)

    it('applyMembership records the matches among the entities asked about', () => {
        useDisplayRuleMatchStore.getState().applyMembership(
            ['r1', 'r2'], ['urn:a', 'urn:b', 'urn:c'], { r1: ['urn:a', 'urn:b'], r2: [] },
        )
        expect(matchesOf('r1')).toEqual(['urn:a', 'urn:b'])
        expect(matchesOf('r2')).toEqual([])
    })

    it('applyMembership untags an evaluated entity that no longer matches, and keeps the rest', () => {
        tag('r1', ['urn:a', 'urn:b'])
        // A later batch re-asks about urn:b only (and a new urn:c).
        useDisplayRuleMatchStore.getState().applyMembership(
            ['r1'], ['urn:b', 'urn:c'], { r1: ['urn:c'] },
        )
        // urn:a was not asked about, so it keeps its tag; urn:b lost it.
        expect(matchesOf('r1')).toEqual(['urn:a', 'urn:c'])
    })

    it('applyMembership leaves rules it was not asked about untouched', () => {
        tag('r1', ['urn:a'])
        tag('r2', ['urn:b'])
        expect(matchesOf('r1')).toEqual(['urn:a'])
        expect(matchesOf('r2')).toEqual(['urn:b'])
    })

    it('setRuleMeta keeps only enabled rules and carries icon/color', () => {
        useDisplayRuleMatchStore.getState().setRuleMeta([
            rule({ id: 'on', color: '#ef4444', icon: 'Tag' }),
            rule({ id: 'off', enabled: false }),
        ])
        const meta = useDisplayRuleMatchStore.getState().ruleMeta
        expect(meta).toHaveLength(1)
        expect(meta[0]).toMatchObject({ id: 'on', color: '#ef4444', icon: 'Tag' })
    })

    it('clearRule drops only the targeted rule’s matches', () => {
        tag('r1', ['urn:a'])
        tag('r2', ['urn:b'])
        useDisplayRuleMatchStore.getState().clearRule('r1')
        const m = useDisplayRuleMatchStore.getState().matchUrnsByRule
        expect(m.has('r1')).toBe(false)
        expect(m.has('r2')).toBe(true)
    })

    it('retainRules prunes match sets and counts not in the keep-set', () => {
        const s = useDisplayRuleMatchStore.getState()
        tag('keep', ['urn:a'])
        tag('drop', ['urn:b'])
        s.setCounts(new Map([
            ['keep', { count: 1, complete: true, percent: 100 }],
            ['drop', { count: 1, complete: true, percent: 100 }],
        ]))
        s.retainRules(['keep'])
        const { matchUrnsByRule, countsByRule } = useDisplayRuleMatchStore.getState()
        expect(matchUrnsByRule.has('keep')).toBe(true)
        expect(matchUrnsByRule.has('drop')).toBe(false)
        expect([...countsByRule.keys()]).toEqual(['keep'])
    })

    it('retainRules is a no-op (same maps) when nothing is pruned', () => {
        tag('keep', ['urn:a'])
        const before = useDisplayRuleMatchStore.getState().matchUrnsByRule
        useDisplayRuleMatchStore.getState().retainRules(['keep'])
        expect(useDisplayRuleMatchStore.getState().matchUrnsByRule).toBe(before)
    })

    it('setCounts publishes each rule’s total in the view', () => {
        useDisplayRuleMatchStore.getState().setCounts(new Map([
            ['r1', { count: 48_203, complete: true, percent: 100 }],
            ['r2', { count: 12, complete: false, percent: 40 }],
        ]))
        const counts = useDisplayRuleMatchStore.getState().countsByRule
        expect(counts.get('r1')).toEqual({ count: 48_203, complete: true, percent: 100 })
        expect(counts.get('r2')?.complete).toBe(false)
    })

    it('resolves the chips for a URN across multiple enabled rules', () => {
        useDisplayRuleMatchStore.getState().setRuleMeta([
            rule({ id: 'pii', color: '#ef4444' }),
            rule({ id: 'gold', color: '#f59e0b' }),
        ])
        tag('pii', ['urn:a', 'urn:b'])
        tag('gold', ['urn:a'])
        // urn:a matches both rules; urn:b only PII.
        expect(tagsFor('urn:a').map((t) => t.id).sort()).toEqual(['gold', 'pii'])
        expect(tagsFor('urn:b').map((t) => t.id)).toEqual(['pii'])
        expect(tagsFor('urn:none')).toHaveLength(0)
    })

    it('a disabled rule contributes no chips even if matches exist', () => {
        // meta only includes enabled rules, so a disabled rule's matches
        // are invisible to the per-URN resolution.
        useDisplayRuleMatchStore.getState().setRuleMeta([rule({ id: 'off', enabled: false })])
        tag('off', ['urn:a'])
        expect(tagsFor('urn:a')).toHaveLength(0)
    })

    it('clear wipes matches, counts and meta', () => {
        const s = useDisplayRuleMatchStore.getState()
        s.setRuleMeta([rule({ id: 'r1' })])
        tag('r1', ['urn:a'])
        s.setCounts(new Map([['r1', { count: 1, complete: true, percent: 100 }]]))
        s.clear()
        const after = useDisplayRuleMatchStore.getState()
        expect(after.matchUrnsByRule.size).toBe(0)
        expect(after.countsByRule.size).toBe(0)
        expect(after.ruleMeta).toHaveLength(0)
    })
})
