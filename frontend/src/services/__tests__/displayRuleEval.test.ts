import { describe, it, expect, beforeEach, vi } from 'vitest'

import { evaluateDisplayRule } from '../displayRuleEval'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { Predicate, SearchQuery, SearchResultPage } from '@/types/search'


function makeResult(over: Partial<SearchResultPage> = {}): SearchResultPage {
    return {
        candidateCount: 0,
        truncated: false,
        deadlineExceeded: false,
        elapsedMs: 1,
        cacheHit: false,
        ...over,
    } as SearchResultPage
}

const TAG_PREDICATE: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }

beforeEach(() => {
    // Minimal, deterministic store state — no canvas roots, no layer
    // assignments — so the query carries just viewId + scopeMode.
    useCanvasStore.setState({ nodes: [], edges: [] })
    useReferenceModelStore.setState({ layers: [] })
    useSchemaStore.setState({
        schema: { containmentEdgeTypes: [], rootEntityTypes: [] } as never,
    })
})


describe('evaluateDisplayRule', () => {
    it('returns [] when the provider is not the remote backend', async () => {
        const fake = { name: 'fake' } as never
        const urns = await evaluateDisplayRule(fake, 'view-1', TAG_PREDICATE)
        expect(urns).toEqual([])
    })

    it('returns [] when no viewId is supplied', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        const spy = vi.spyOn(provider, 'searchAdvanced')
        const urns = await evaluateDisplayRule(provider, '', TAG_PREDICATE)
        expect(urns).toEqual([])
        expect(spy).not.toHaveBeenCalled()
    })

    it('builds a view-scoped query and collects hit URNs', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        let captured: SearchQuery | null = null
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            captured = q
            return makeResult({
                hits: [
                    { node: { urn: 'urn:a' } } as never,
                    { node: { urn: 'urn:b' } } as never,
                ],
            })
        })

        const urns = await evaluateDisplayRule(provider, 'view-1', TAG_PREDICATE)

        expect(urns).toEqual(['urn:a', 'urn:b'])
        expect(captured).not.toBeNull()
        // Scope is stamped with the viewId in 'view' mode.
        expect(captured!.scope.viewId).toBe('view-1')
        expect(captured!.scope.scopeMode).toBe('view')
        // Options request hits (not the aggregate-only default).
        expect(captured!.options?.results).toBe('hits')
    })

    it('wraps a bare leaf predicate in a top-level AND group', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        let captured: SearchQuery | null = null
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            captured = q
            return makeResult({ hits: [] })
        })

        await evaluateDisplayRule(provider, 'view-1', TAG_PREDICATE)

        // Leaf predicate must be normalised to group{ and: [leaf] } so the
        // backend compiler handles it correctly.
        expect(captured!.predicate.kind).toBe('group')
        const group = captured!.predicate as Extract<Predicate, { kind: 'group' }>
        expect(group.op).toBe('and')
        expect(group.children).toHaveLength(1)
        expect(group.children[0]).toMatchObject({ kind: 'tag' })
    })

    it('passes an already-grouped predicate through unwrapped', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        let captured: SearchQuery | null = null
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            captured = q
            return makeResult({ hits: [] })
        })

        const grouped: Predicate = { kind: 'group', op: 'or', children: [TAG_PREDICATE] }
        await evaluateDisplayRule(provider, 'view-1', grouped)

        const group = captured!.predicate as Extract<Predicate, { kind: 'group' }>
        // Not re-wrapped — the existing OR group is preserved.
        expect(group.op).toBe('or')
        expect(group.children).toHaveLength(1)
    })

    it('also collects URNs from aggregate sample hits', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        vi.spyOn(provider, 'searchAdvanced').mockResolvedValue(makeResult({
            aggregates: [[
                {
                    ancestorUrn: 'urn:root',
                    ancestorDisplayName: 'Root',
                    ancestorEntityType: 'domain',
                    ancestorDepthFromScopeRoot: 0,
                    matchCount: 1,
                    sampleHits: [{ node: { urn: 'urn:c' } } as never],
                } as never,
            ]],
        }))

        const urns = await evaluateDisplayRule(provider, 'view-1', TAG_PREDICATE)
        expect(urns).toContain('urn:c')
    })
})
