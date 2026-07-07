import { describe, it, expect, beforeEach } from 'vitest'

import { useReferenceModelStore } from '../referenceModelStore'
import type { DisplayRuleConfig } from '@/types/schema'


function rule(id: string, over: Partial<DisplayRuleConfig> = {}): DisplayRuleConfig {
    return {
        id,
        name: id,
        color: '#6366f1',
        predicate: { kind: 'group', op: 'and', children: [] },
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        ...over,
    }
}

beforeEach(() => {
    useReferenceModelStore.setState({ displayRules: [] })
})


describe('referenceModelStore — display rules', () => {
    it('addDisplayRule appends the rule', () => {
        useReferenceModelStore.getState().addDisplayRule(rule('a'))
        const s = useReferenceModelStore.getState()
        expect(s.displayRules.map((r) => r.id)).toEqual(['a'])
    })

    it('updateDisplayRule patches a single rule by id', () => {
        const s = useReferenceModelStore.getState()
        s.setDisplayRules([rule('a'), rule('b')])
        s.updateDisplayRule('b', { name: 'B2', color: '#ef4444' })
        const b = useReferenceModelStore.getState().displayRules.find((r) => r.id === 'b')
        expect(b).toMatchObject({ name: 'B2', color: '#ef4444' })
        expect(useReferenceModelStore.getState().displayRules.find((r) => r.id === 'a')!.name).toBe('a')
    })

    it('toggleDisplayRule flips only the targeted rule', () => {
        const s = useReferenceModelStore.getState()
        s.setDisplayRules([rule('a'), rule('b')])
        s.toggleDisplayRule('a')
        const rules = useReferenceModelStore.getState().displayRules
        expect(rules.find((r) => r.id === 'a')!.enabled).toBe(false)
        expect(rules.find((r) => r.id === 'b')!.enabled).toBe(true)
    })

    it('removeDisplayRule deletes by id', () => {
        const s = useReferenceModelStore.getState()
        s.setDisplayRules([rule('a'), rule('b')])
        s.removeDisplayRule('a')
        expect(useReferenceModelStore.getState().displayRules.map((r) => r.id)).toEqual(['b'])
    })

    it('reorderDisplayRules reorders to the given id sequence', () => {
        const s = useReferenceModelStore.getState()
        s.setDisplayRules([rule('a'), rule('b'), rule('c')])
        s.reorderDisplayRules(['c', 'a', 'b'])
        expect(useReferenceModelStore.getState().displayRules.map((r) => r.id)).toEqual(['c', 'a', 'b'])
    })

    it('reorderDisplayRules appends rules missing from the sequence', () => {
        const s = useReferenceModelStore.getState()
        s.setDisplayRules([rule('a'), rule('b'), rule('c')])
        s.reorderDisplayRules(['b', 'a'])
        expect(useReferenceModelStore.getState().displayRules.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    })

    it('reorderDisplayRules ignores unknown ids', () => {
        const s = useReferenceModelStore.getState()
        s.setDisplayRules([rule('a'), rule('b')])
        s.reorderDisplayRules(['ghost', 'b', 'a'])
        expect(useReferenceModelStore.getState().displayRules.map((r) => r.id)).toEqual(['b', 'a'])
    })

    it('create-from-query: addDisplayRule stores the seed predicate verbatim', () => {
        // Mirrors the Advanced-Search "Create rule" flow: a rule built
        // from a live query carries that query's predicate unchanged.
        const queryPredicate = {
            kind: 'group', op: 'and', children: [
                { kind: 'tag', op: 'hasAny', values: ['PII'] },
                { kind: 'entityType', op: 'in', values: ['dataset'] },
            ],
        }
        useReferenceModelStore.getState().addDisplayRule(
            rule('from-query', { name: 'PII datasets', predicate: queryPredicate }),
        )
        const s = useReferenceModelStore.getState()
        const saved = s.displayRules.find((r) => r.id === 'from-query')!
        expect(saved.predicate).toEqual(queryPredicate)
    })
})
