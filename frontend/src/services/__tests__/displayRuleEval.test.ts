import { describe, it, expect, beforeEach, vi } from 'vitest'

import { evaluateDisplayRule, resolveScopeRootUrns } from '../displayRuleEval'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { GroupPredicate, Predicate, SearchQuery, SearchResultPage } from '@/types/search'


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
        const group = captured!.predicate as GroupPredicate
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

        const group = captured!.predicate as GroupPredicate
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

    it('cursor-paginates and unions every page (not just the first)', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        const calls: SearchQuery[] = []
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            calls.push(q)
            if (!q.options?.cursor) {
                return makeResult({
                    hits: [{ node: { urn: 'urn:a' } } as never, { node: { urn: 'urn:b' } } as never],
                    cursor: 'c1',
                })
            }
            return makeResult({ hits: [{ node: { urn: 'urn:c' } } as never], cursor: null })
        })

        const urns = await evaluateDisplayRule(provider, 'view-1', TAG_PREDICATE)

        // Full union across both pages — the bug was tagging only page 1.
        expect([...urns].sort()).toEqual(['urn:a', 'urn:b', 'urn:c'])
        expect(calls).toHaveLength(2)
        // Page 1 requests the max page size + a raised candidate cap.
        expect(calls[0].options?.pageSize).toBe(5000)
        expect(calls[0].options?.candidateCap).toBe(100000)
        // Page 2 carries the cursor from page 1.
        expect(calls[1].options?.cursor).toBe('c1')
    })

    it('returns [] without scanning when the signal is already aborted', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        const spy = vi.spyOn(provider, 'searchAdvanced')
        const ac = new AbortController()
        ac.abort()
        const urns = await evaluateDisplayRule(provider, 'view-1', TAG_PREDICATE, ac.signal)
        expect(urns).toEqual([])
        expect(spy).not.toHaveBeenCalled()
    })

    it('invokes onPage with the cumulative set after each page (progressive)', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            if (!q.options?.cursor) {
                return makeResult({ hits: [{ node: { urn: 'urn:a' } } as never], cursor: 'c1' })
            }
            return makeResult({ hits: [{ node: { urn: 'urn:b' } } as never], cursor: null })
        })
        const pages: string[][] = []
        const all = await evaluateDisplayRule(provider, 'view-1', TAG_PREDICATE, undefined, (urns) => pages.push(urns))
        expect([...all].sort()).toEqual(['urn:a', 'urn:b'])
        expect(pages).toHaveLength(2)
        expect(pages[0]).toEqual(['urn:a'])                 // after page 1
        expect([...pages[1]].sort()).toEqual(['urn:a', 'urn:b']) // cumulative after page 2
    })
})


describe('resolveScopeRootUrns', () => {
    it('returns explicit layer-assignment URNs (capped at 256)', () => {
        const assignments = Array.from({ length: 300 }, (_, i) => ({ entityId: `urn:x:${i}` }))
        useReferenceModelStore.setState({ layers: [{ entityAssignments: assignments }] as never })
        const roots = resolveScopeRootUrns()
        expect(roots).toHaveLength(256)
        expect(roots[0]).toBe('urn:x:0')
        useReferenceModelStore.setState({ layers: [] })
    })

    it('returns [] when there are no layer assignments and no canvas roots', () => {
        useReferenceModelStore.setState({ layers: [] })
        useCanvasStore.setState({ nodes: [], edges: [] })
        expect(resolveScopeRootUrns()).toEqual([])
    })
})
