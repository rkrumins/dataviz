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


// ---------------------------------------------------------------------------
// Value distribution — top values of a property key + their counts
// ---------------------------------------------------------------------------

export interface ValueBucket { value: string; count: number }
export interface ValueDistribution {
    values: ValueBucket[]
    /** True when there are likely more distinct values than ``limit``. */
    truncated: boolean
}

const EMPTY_DISTRIBUTION: ValueDistribution = { values: [], truncated: false }

/**
 * Distribution of a property's values: ``by:'property'`` buckets the
 * candidate set (nodes that have the key) by ``n.<key>`` value. For a
 * property facet the bucket's ``ancestorDisplayName`` holds the VALUE and
 * ``matchCount`` the number of entities with it (backend-confirmed). One
 * read-only round-trip; lazy on row expand.
 */
export async function getValueDistribution(
    provider: GraphDataProvider,
    viewId: string,
    key: string,
    limit = 12,
    signal?: AbortSignal,
): Promise<ValueDistribution> {
    if (!(provider instanceof RemoteGraphProvider) || !viewId || !key) return EMPTY_DISTRIBUTION
    const query = buildViewScopedQuery(
        viewId,
        { kind: 'hasProperty', key, negate: false } as Predicate,
        {
            results: 'aggregates',
            pageSize: 1,
            aggregations: [{ by: 'property', propertyKey: key, maxBuckets: limit }],
        },
    )
    const result = await provider.searchAdvanced(query)
    if (signal?.aborted) return EMPTY_DISTRIBUTION
    const buckets = result.aggregates?.[0] ?? []
    const values = buckets
        .map((b) => ({ value: String(b.ancestorDisplayName ?? ''), count: b.matchCount ?? 0 }))
        .filter((v) => v.count > 0)
    return { values, truncated: buckets.length >= limit }
}


// ---------------------------------------------------------------------------
// Affected-entity sample — preview which entities a bulk op will touch
// ---------------------------------------------------------------------------

export interface AffectedEntity { urn: string; displayName: string; entityType: string }
export interface AffectedSample { entities: AffectedEntity[]; truncated: boolean }

const EMPTY_SAMPLE: AffectedSample = { entities: [], truncated: false }

/**
 * A small sample of entities matched by ``predicate`` (the target set of a
 * bulk property op), for the dialog preview. Requests hit rows directly.
 */
export async function getAffectedSample(
    provider: GraphDataProvider,
    viewId: string,
    predicate: Predicate,
    limit = 8,
    signal?: AbortSignal,
): Promise<AffectedSample> {
    if (!(provider instanceof RemoteGraphProvider) || !viewId) return EMPTY_SAMPLE
    const query = buildViewScopedQuery(viewId, predicate, {
        results: 'hits',
        pageSize: limit + 1,
        includeAncestorPath: false,
    })
    const result = await provider.searchAdvanced(query)
    if (signal?.aborted) return EMPTY_SAMPLE
    const hits = result.hits ?? []
    const entities = hits.slice(0, limit).map((h) => ({
        urn: h.node?.urn ?? '',
        displayName: h.node?.displayName || h.node?.urn || '(unnamed)',
        entityType: h.node?.entityType ?? '',
    }))
    return { entities, truncated: hits.length > limit }
}


// ---------------------------------------------------------------------------
// Catalogue overview — eager, one call for the insights header
// ---------------------------------------------------------------------------

export interface CatalogOverview {
    totalEntities: number
    byEntityType: { type: string; count: number }[]
}

/** Total entity count + per-entity-type breakdown for the whole view. */
export async function getCatalogOverview(
    provider: GraphDataProvider,
    viewId: string,
    signal?: AbortSignal,
): Promise<CatalogOverview> {
    const usage = await aggregateByEntityType(
        provider,
        viewId,
        { kind: 'group', op: 'and', children: [] } as Predicate,
        signal,
    )
    return { totalEntities: usage.total, byEntityType: usage.byEntityType }
}


/**
 * How many entities in the target set ALREADY carry the key — drives the
 * "M of N will be overwritten" guidance for a Set op.
 */
export function countPropertyUsageWithinTarget(
    provider: GraphDataProvider,
    viewId: string,
    key: string,
    targetPredicate: Predicate,
    signal?: AbortSignal,
): Promise<number> {
    const combined: Predicate = {
        kind: 'group', op: 'and',
        children: [targetPredicate, { kind: 'hasProperty', key, negate: false } as Predicate],
    }
    return countMatches(provider, viewId, combined, signal)
}
