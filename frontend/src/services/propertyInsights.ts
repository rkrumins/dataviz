/**
 * propertyInsights — read-only usage analytics for entity properties.
 *
 * Discovery (``useDiscovery``) tells us WHICH keys exist and a few sample
 * values, but not HOW MANY entities carry a key. This service answers
 * that with a single ``searchAdvanced`` call per key: a view-scoped
 * ``hasProperty`` query aggregated ``by: 'entityType'``. Summing the
 * facet buckets' ``matchCount`` gives the exact total + a per-type
 * breakdown in one round-trip (``candidateCount`` is used as a fallback
 * total when the aggregation comes back empty).
 *
 * It is purely a READ — writes (bulk property apply) are deferred; only
 * persistence is gated, reads work against the live backend today.
 */
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { Predicate } from '@/types/search'

import { buildViewScopedQuery } from './displayRuleEval'


export interface PropertyUsage {
    /** Total entities in the view that match the predicate. */
    total: number
    /** Per-entity-type breakdown, descending by count. */
    byEntityType: { type: string; count: number }[]
}


const EMPTY_USAGE: PropertyUsage = { total: 0, byEntityType: [] }


/**
 * Run a view-scoped aggregate-only search and parse the entity-type
 * facet into a usage breakdown. Shared by ``countPropertyUsage`` (which
 * targets a single ``hasProperty`` key) and ``countMatches`` (arbitrary
 * predicate, total only).
 */
async function aggregateByEntityType(
    provider: GraphDataProvider,
    viewId: string,
    predicate: Predicate,
    signal?: AbortSignal,
): Promise<PropertyUsage> {
    if (!(provider instanceof RemoteGraphProvider) || !viewId) return EMPTY_USAGE
    const query = buildViewScopedQuery(viewId, predicate, {
        results: 'aggregates',
        // We only need the counts, not hit rows.
        pageSize: 1,
        aggregations: [{ by: 'entityType', maxBuckets: 50 }],
    })
    const result = await provider.searchAdvanced(query)
    if (signal?.aborted) return EMPTY_USAGE

    const buckets = result.aggregates?.[0] ?? []
    const byEntityType = buckets
        .map((b) => ({
            type: b.ancestorDisplayName || b.ancestorEntityType || 'unknown',
            count: b.matchCount ?? 0,
        }))
        .filter((x) => x.count > 0)
        .sort((a, b) => b.count - a.count)

    const summed = byEntityType.reduce((s, x) => s + x.count, 0)
    const total = summed > 0 ? summed : (result.candidateCount ?? 0)
    return { total, byEntityType }
}


/**
 * Exact usage of a single property key across the view: total entities
 * carrying the key + a per-entity-type breakdown.
 */
export function countPropertyUsage(
    provider: GraphDataProvider,
    viewId: string,
    key: string,
    signal?: AbortSignal,
): Promise<PropertyUsage> {
    if (!key) return Promise.resolve(EMPTY_USAGE)
    return aggregateByEntityType(
        provider,
        viewId,
        { kind: 'hasProperty', key, negate: false } as Predicate,
        signal,
    )
}


/**
 * Total count of entities matching an arbitrary predicate (the target
 * set for a bulk property operation). Uses the same aggregate trick so
 * the count is exact (not capped at the hits page size).
 */
export async function countMatches(
    provider: GraphDataProvider,
    viewId: string,
    predicate: Predicate,
    signal?: AbortSignal,
): Promise<number> {
    const usage = await aggregateByEntityType(provider, viewId, predicate, signal)
    return usage.total
}
