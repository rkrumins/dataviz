import { describe, it, expect, beforeEach, vi } from 'vitest'

import { countMatches, countPropertyUsage } from '../propertyInsights'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { GroupPredicate, Predicate, SearchQuery, SearchResultPage } from '@/types/search'


function makeResult(over: Partial<SearchResultPage> = {}): SearchResultPage {
    return {
        candidateCount: 0, truncated: false, deadlineExceeded: false,
        elapsedMs: 1, cacheHit: false, ...over,
    } as SearchResultPage
}

function bucket(type: string, count: number) {
    return {
        ancestorUrn: `urn:${type}`, ancestorDisplayName: type, ancestorEntityType: type,
        ancestorDepthFromScopeRoot: 0, matchCount: count,
    } as never
}

beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] })
    useReferenceModelStore.setState({ layers: [] })
    useSchemaStore.setState({ schema: { containmentEdgeTypes: [], rootEntityTypes: [] } as never })
})


describe('propertyInsights', () => {
    it('returns empty usage for a non-remote provider', async () => {
        const usage = await countPropertyUsage({ name: 'fake' } as never, 'view-1', 'owner')
        expect(usage).toEqual({ total: 0, byEntityType: [] })
    })

    it('builds a hasProperty + entityType-aggregation query and parses buckets', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        let captured: SearchQuery | null = null
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            captured = q
            return makeResult({ aggregates: [[bucket('dataset', 7), bucket('container', 3)]] })
        })

        const usage = await countPropertyUsage(provider, 'view-1', 'owner')

        // Query shape: aggregate-only, faceted by entityType, view-scoped.
        expect(captured!.options?.results).toBe('aggregates')
        expect(captured!.options?.aggregations?.[0]?.by).toBe('entityType')
        expect(captured!.scope.viewId).toBe('view-1')
        const group = captured!.predicate as GroupPredicate
        expect(group.children[0]).toMatchObject({ kind: 'hasProperty', key: 'owner' })

        // Parsed: total = sum of buckets, sorted descending.
        expect(usage.total).toBe(10)
        expect(usage.byEntityType).toEqual([
            { type: 'dataset', count: 7 },
            { type: 'container', count: 3 },
        ])
    })

    it('falls back to candidateCount when there are no aggregate buckets', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        vi.spyOn(provider, 'searchAdvanced').mockResolvedValue(
            makeResult({ candidateCount: 42, aggregates: [[]] }),
        )
        const usage = await countPropertyUsage(provider, 'view-1', 'owner')
        expect(usage.total).toBe(42)
        expect(usage.byEntityType).toEqual([])
    })

    it('countMatches returns the summed total for an arbitrary predicate', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        vi.spyOn(provider, 'searchAdvanced').mockResolvedValue(
            makeResult({ aggregates: [[bucket('dataset', 5)]] }),
        )
        const n = await countMatches(
            provider, 'view-1',
            { kind: 'tag', op: 'hasAny', values: ['PII'] } as Predicate,
        )
        expect(n).toBe(5)
    })
})
