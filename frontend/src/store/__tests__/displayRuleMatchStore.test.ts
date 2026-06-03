import { describe, it, expect, beforeEach } from 'vitest'

import {
    useDisplayRuleMatchStore,
    useRuleMatchCount,
} from '../displayRuleMatchStore'
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

/** Replicates ``useDisplayRuleTags`` membership logic against current
 *  store state — lets us assert the per-URN chip resolution without a
 *  React renderer. */
function tagsFor(urn: string) {
    const { matchUrnsByRule, ruleMeta } = useDisplayRuleMatchStore.getState()
    return ruleMeta.filter((m) => matchUrnsByRule.get(m.id)?.has(urn))
}


describe('displayRuleMatchStore', () => {
    beforeEach(reset)

    it('setRuleMatches stores a rule’s matched URNs', () => {
        useDisplayRuleMatchStore.getState().setRuleMatches('r1', ['urn:a', 'urn:b'])
        const set = useDisplayRuleMatchStore.getState().matchUrnsByRule.get('r1')
        expect(set).toBeDefined()
        expect(set!.has('urn:a')).toBe(true)
        expect(set!.has('urn:b')).toBe(true)
        expect(set!.size).toBe(2)
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
        const s = useDisplayRuleMatchStore.getState()
        s.setRuleMatches('r1', ['urn:a'])
        s.setRuleMatches('r2', ['urn:b'])
        s.clearRule('r1')
        const m = useDisplayRuleMatchStore.getState().matchUrnsByRule
        expect(m.has('r1')).toBe(false)
        expect(m.has('r2')).toBe(true)
    })

    it('retainRules prunes match sets not in the keep-set', () => {
        const s = useDisplayRuleMatchStore.getState()
        s.setRuleMatches('keep', ['urn:a'])
        s.setRuleMatches('drop', ['urn:b'])
        s.retainRules(['keep'])
        const m = useDisplayRuleMatchStore.getState().matchUrnsByRule
        expect(m.has('keep')).toBe(true)
        expect(m.has('drop')).toBe(false)
    })

    it('resolves the chips for a URN across multiple enabled rules', () => {
        const s = useDisplayRuleMatchStore.getState()
        s.setRuleMeta([
            rule({ id: 'pii', color: '#ef4444' }),
            rule({ id: 'gold', color: '#f59e0b' }),
        ])
        s.setRuleMatches('pii', ['urn:a', 'urn:b'])
        s.setRuleMatches('gold', ['urn:a'])
        // urn:a matches both rules; urn:b only PII.
        expect(tagsFor('urn:a').map((t) => t.id).sort()).toEqual(['gold', 'pii'])
        expect(tagsFor('urn:b').map((t) => t.id)).toEqual(['pii'])
        expect(tagsFor('urn:none')).toHaveLength(0)
    })

    it('a disabled rule contributes no chips even if matches exist', () => {
        const s = useDisplayRuleMatchStore.getState()
        // meta only includes enabled rules, so a disabled rule's matches
        // are invisible to the per-URN resolution.
        s.setRuleMeta([rule({ id: 'off', enabled: false })])
        s.setRuleMatches('off', ['urn:a'])
        expect(tagsFor('urn:a')).toHaveLength(0)
    })

    it('match count reflects the stored set size', () => {
        useDisplayRuleMatchStore.getState().setRuleMatches('r1', ['x', 'y', 'z'])
        const count = useDisplayRuleMatchStore.getState().matchUrnsByRule.get('r1')?.size ?? 0
        expect(count).toBe(3)
        // sanity: the exported selector hook is defined
        expect(typeof useRuleMatchCount).toBe('function')
    })
})
