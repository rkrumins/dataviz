/**
 * useDisplayRuleEngine — the canvas asks the server about what it has
 * loaded, never downloads a rule's whole match set:
 *   - membership in batches of ≤ 1,000 entities × ≤ 32 rules, each entity
 *     once per rule set, later loads asked about as they arrive, the lot
 *     re-asked when a rule's criteria change;
 *   - each enabled rule's exact count, published to the match store;
 *   - the store wiped on unmount.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { countRules } from '@/services/ruleCounts'
import { type LineageNode, useCanvasStore } from '@/store/canvas'
import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate, SearchMembershipRequest } from '@/types/search'

import { useDisplayRuleEngine } from '../useDisplayRuleEngine'


const provider = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@/providers/GraphProviderContext', async () => {
    const { RemoteGraphProvider } = await import('@/providers/RemoteGraphProvider')
    provider.current = Object.assign(Object.create(RemoteGraphProvider.prototype), {
        searchMembership: vi.fn(),
    })
    return { useGraphProvider: () => provider.current }
})

vi.mock('@/services/ruleCounts', () => ({
    countRules: vi.fn(async () => new Map()),
}))


const leaf: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }

function rule(id: string, over: Partial<DisplayRuleConfig> = {}): DisplayRuleConfig {
    return {
        id, name: id, color: '#6366f1', predicate: leaf, enabled: true,
        createdAt: '2026-01-01T00:00:00Z', ...over,
    }
}

function nodes(count: number, offset = 0): LineageNode[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `urn:n${i + offset}`, position: { x: 0, y: 0 }, data: {},
    }) as unknown as LineageNode)
}

function membership() {
    return vi.mocked((provider.current as RemoteGraphProvider).searchMembership)
}

function asked(): SearchMembershipRequest[] {
    return membership().mock.calls.map(([body]) => body)
}


beforeEach(() => {
    useDisplayRuleMatchStore.getState().clear()
    useReferenceModelStore.setState({ displayRules: [], layers: [] })
    useCanvasStore.setState({ nodes: [] })
    // Every entity whose URN ends in 0 matches every rule asked about.
    membership().mockReset()
    membership().mockImplementation(async (body) => ({
        matches: Object.fromEntries(body.items.map((item) => [
            item.id, body.urns.filter((u) => u.endsWith('0')),
        ])),
        errors: {},
    }))
    vi.mocked(countRules).mockReset()
    vi.mocked(countRules).mockImplementation(async () => new Map())
})

afterEach(() => {
    vi.clearAllMocks()
})


describe('useDisplayRuleEngine', () => {
    it('asks about the loaded entities in batches of 1,000 and tags the matches', async () => {
        useReferenceModelStore.setState({ displayRules: [rule('pii')] })
        useCanvasStore.setState({ nodes: nodes(1500) })
        renderHook(() => useDisplayRuleEngine('view-1'))

        await waitFor(() => expect(membership()).toHaveBeenCalledTimes(2))
        const [first, second] = asked()
        expect(first.urns).toHaveLength(1000)
        expect(second.urns).toHaveLength(500)
        expect(first.scope).toEqual({ viewId: 'view-1', scopeMode: 'view' })
        // A bare leaf goes over AND-wrapped, as every search does.
        expect(first.items).toEqual([
            { id: 'pii', predicate: { kind: 'group', op: 'and', children: [leaf] } },
        ])
        await waitFor(() => expect(
            useDisplayRuleMatchStore.getState().matchUrnsByRule.get('pii')?.size,
        ).toBe(150))
    })

    it('asks about at most 32 rules a request', async () => {
        useReferenceModelStore.setState({
            displayRules: Array.from({ length: 40 }, (_, i) => rule(`r${i}`)),
        })
        useCanvasStore.setState({ nodes: nodes(10) })
        renderHook(() => useDisplayRuleEngine('view-1'))

        await waitFor(() => expect(membership()).toHaveBeenCalledTimes(2))
        expect(asked().map((b) => b.items.length)).toEqual([32, 8])
    })

    it('asks only about entities that load later, and everything again when criteria change', async () => {
        useReferenceModelStore.setState({ displayRules: [rule('pii')] })
        useCanvasStore.setState({ nodes: nodes(5) })
        renderHook(() => useDisplayRuleEngine('view-1'))
        await waitFor(() => expect(membership()).toHaveBeenCalledTimes(1))

        act(() => { useCanvasStore.setState({ nodes: [...nodes(5), ...nodes(2, 5)] }) })
        await waitFor(() => expect(membership()).toHaveBeenCalledTimes(2))
        expect(asked()[1].urns).toEqual(['urn:n5', 'urn:n6'])

        // A rename or recolour is not a reason to ask again…
        act(() => { useReferenceModelStore.setState({ displayRules: [rule('pii', { name: 'PII', color: '#ef4444' })] }) })
        await new Promise((r) => setTimeout(r, 250))
        expect(membership()).toHaveBeenCalledTimes(2)
        // …a change of criteria is.
        act(() => {
            useReferenceModelStore.setState({ displayRules: [rule('pii', {
                name: 'PII', predicate: { kind: 'tag', op: 'hasAny', values: ['GDPR'] },
            })] })
        })
        await waitFor(() => expect(membership()).toHaveBeenCalledTimes(3))
        expect(asked()[2].urns).toHaveLength(7)
    })

    it('never asks about disabled rules, nor when there are none', async () => {
        useReferenceModelStore.setState({ displayRules: [rule('off', { enabled: false })] })
        useCanvasStore.setState({ nodes: nodes(5) })
        renderHook(() => useDisplayRuleEngine('view-1'))
        await new Promise((r) => setTimeout(r, 250))
        expect(membership()).not.toHaveBeenCalled()
        expect(countRules).not.toHaveBeenCalled()
    })

    it("publishes each enabled rule's count in the view", async () => {
        vi.mocked(countRules).mockImplementation(async (_p, _v, _rules, opts) => {
            const counts = new Map([['pii', { count: 48_203, complete: true, percent: 100 }]])
            opts?.onUpdate?.(counts)
            return counts
        })
        useReferenceModelStore.setState({ displayRules: [rule('pii'), rule('off', { enabled: false })] })
        renderHook(() => useDisplayRuleEngine('view-1'))

        await waitFor(() => expect(
            useDisplayRuleMatchStore.getState().countsByRule.get('pii')?.count,
        ).toBe(48_203))
        const [, viewId, rules] = vi.mocked(countRules).mock.calls[0]
        expect(viewId).toBe('view-1')
        expect(rules.map((r) => r.id)).toEqual(['pii'])
    })

    it("never sends a rule the library flagged, or one without criteria, and says why it can't be counted", async () => {
        // A bundle import or a version restore stores rules as given: sent
        // with the others, one bad predicate would fail their whole batch.
        vi.mocked(countRules).mockImplementation(async (_p, _v, _rules, opts) => {
            const counts = new Map([['pii', { count: 7, complete: true, percent: 100 }]])
            opts?.onUpdate?.(counts)
            return counts
        })
        useReferenceModelStore.setState({ displayRules: [
            rule('pii'),
            rule('near', { invalid: "A rule can't use 'within hops' or a path." }),
            rule('bare', { predicate: undefined }),
        ] })
        useCanvasStore.setState({ nodes: nodes(10) })
        renderHook(() => useDisplayRuleEngine('view-1'))

        await waitFor(() => expect(membership()).toHaveBeenCalledTimes(1))
        expect(asked()[0].items.map((i) => i.id)).toEqual(['pii'])
        await waitFor(() => expect(useDisplayRuleMatchStore.getState().countsByRule.size).toBe(3))
        expect(vi.mocked(countRules).mock.calls[0][2].map((r) => r.id)).toEqual(['pii'])
        const counts = useDisplayRuleMatchStore.getState().countsByRule
        expect(counts.get('pii')).toEqual({ count: 7, complete: true, percent: 100 })
        expect(counts.get('near')).toMatchObject({ complete: true, error: expect.stringContaining('within hops') })
        expect(counts.get('bare')).toMatchObject({ complete: true, error: expect.any(String) })
    })

    it("says why a rule can't be counted even when no rule can be", async () => {
        useReferenceModelStore.setState({ displayRules: [rule('bare', { predicate: null })] })
        renderHook(() => useDisplayRuleEngine('view-1'))

        await waitFor(() => expect(
            useDisplayRuleMatchStore.getState().countsByRule.get('bare')?.error,
        ).toBeTruthy())
        expect(countRules).not.toHaveBeenCalled()
        expect(membership()).not.toHaveBeenCalled()
    })

    it('wipes the match store on unmount', async () => {
        useReferenceModelStore.setState({ displayRules: [rule('pii')] })
        useCanvasStore.setState({ nodes: nodes(10) })
        const { unmount } = renderHook(() => useDisplayRuleEngine('view-1'))
        await waitFor(() => expect(
            useDisplayRuleMatchStore.getState().matchUrnsByRule.get('pii')?.size,
        ).toBe(1))
        unmount()
        expect(useDisplayRuleMatchStore.getState().matchUrnsByRule.size).toBe(0)
        expect(useDisplayRuleMatchStore.getState().ruleMeta).toHaveLength(0)
    })
})
