import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
    countMatches, countPropertyUsage, countPropertyUsageWithinTarget,
    getAffectedSample, getCatalogOverview, getValueDistribution,
} from '../propertyInsights'
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

    it('getValueDistribution aggregates by:property and reads value buckets', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        let captured: SearchQuery | null = null
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            captured = q
            // For a property facet, ancestorDisplayName holds the VALUE.
            return makeResult({ aggregates: [[bucket('prod', 42), bucket('staging', 12)]] })
        })

        const d = await getValueDistribution(provider, 'view-1', 'environment')

        expect(captured!.options?.aggregations?.[0]?.by).toBe('property')
        expect(captured!.options?.aggregations?.[0]?.propertyKey).toBe('environment')
        const group = captured!.predicate as GroupPredicate
        expect(group.children[0]).toMatchObject({ kind: 'hasProperty', key: 'environment' })
        expect(d.values).toEqual([
            { value: 'prod', count: 42 },
            { value: 'staging', count: 12 },
        ])
    })

    it('getAffectedSample maps hit nodes to {urn, displayName, entityType}', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        vi.spyOn(provider, 'searchAdvanced').mockResolvedValue(makeResult({
            hits: [
                { node: { urn: 'urn:a', displayName: 'Table A', entityType: 'dataset' } } as never,
                { node: { urn: 'urn:b', displayName: 'Report B', entityType: 'report' } } as never,
            ],
        }))
        const s = await getAffectedSample(provider, 'view-1', { kind: 'tag', op: 'hasAny', values: ['PII'] } as Predicate, 8)
        expect(s.entities).toEqual([
            { urn: 'urn:a', displayName: 'Table A', entityType: 'dataset' },
            { urn: 'urn:b', displayName: 'Report B', entityType: 'report' },
        ])
        expect(s.truncated).toBe(false)
    })

    it('getCatalogOverview returns total + per-type from an empty-predicate facet', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        let captured: SearchQuery | null = null
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            captured = q
            return makeResult({ aggregates: [[bucket('dataset', 30), bucket('report', 10)]] })
        })
        const o = await getCatalogOverview(provider, 'view-1')
        // Empty AND group → matches all in scope.
        const group = captured!.predicate as GroupPredicate
        expect(group.op).toBe('and')
        expect(group.children).toHaveLength(0)
        expect(o.totalEntities).toBe(40)
        expect(o.byEntityType).toEqual([{ type: 'dataset', count: 30 }, { type: 'report', count: 10 }])
    })

    it('countPropertyUsageWithinTarget ANDs the target with hasProperty', async () => {
        const provider = new RemoteGraphProvider({ workspaceId: 'ws-1' })
        let captured: SearchQuery | null = null
        vi.spyOn(provider, 'searchAdvanced').mockImplementation(async (q: SearchQuery) => {
            captured = q
            return makeResult({ aggregates: [[bucket('dataset', 4)]] })
        })
        const n = await countPropertyUsageWithinTarget(
            provider, 'view-1', 'owner',
            { kind: 'entityType', op: 'in', values: ['dataset'] } as Predicate,
        )
        const group = captured!.predicate as GroupPredicate
        expect(group.op).toBe('and')
        expect(group.children).toHaveLength(2)
        expect(group.children[1]).toMatchObject({ kind: 'hasProperty', key: 'owner' })
        expect(n).toBe(4)
    })
})
