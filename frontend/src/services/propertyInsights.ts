/**
 * propertyInsights — the reads the bulk-property dialog makes about the
 * entities an operation would touch: how many a target set holds, how many
 * of them already carry a key, which values a key holds, and a sample of
 * the entities themselves. (The Properties tab reads the view's exact
 * property catalog instead — ``services/propertyCatalog``.)
 *
 * It is purely a READ — writes (bulk property apply) are deferred; only
 * persistence is gated, reads work against the live backend today.
 */
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { Predicate, SearchQuery, SearchScope } from '@/types/search'


/**
 * A view-scoped SearchQuery for an arbitrary predicate + options, shared
 * by every read below so they all scope identically.
 */
function buildViewScopedQuery(
    viewId: string,
    predicate: Predicate,
    options: SearchQuery['options'],
): SearchQuery {
    // No rootUrns: the backend resolves the view's own boundary from
    // ``viewId`` on every request and only ever NARROWS by a client hint.
    // The hint this sent was the canvas's guess at the roots, capped at 256,
    // so on a larger view it hid every match under root #257 — the reason
    // Advanced Search stopped sending one (see useAdvancedSearch).
    const scope: SearchScope = { viewId, scopeMode: 'view' }

    // The backend predicate compiler mishandles bare top-level leaf
    // predicates — wrap leaves in a single-child AND group (mirrors
    // stampScope's defensive normalisation).
    const wrapped: Predicate = predicate.kind === 'group'
        ? predicate
        : { kind: 'group', op: 'and', children: [predicate] }

    return { predicate: wrapped, scope, options }
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
    if (!(provider instanceof RemoteGraphProvider) || !viewId) return 0
    const query = buildViewScopedQuery(viewId, predicate, {
        results: 'aggregates',
        // We only need the count, not hit rows.
        pageSize: 1,
        aggregations: [{ by: 'entityType', maxBuckets: 50 }],
    })
    const result = await provider.searchAdvanced(query)
    if (signal?.aborted) return 0
    // An aggregates-only request makes the backend run the uncapped count
    // beside the (capped) facet, and ``totalCount`` is that answer. Summing
    // the facet buckets instead topped out at the candidate cap on any view
    // bigger than it.
    if (typeof result.totalCount === 'number') return result.totalCount
    const summed = (result.aggregates?.[0] ?? []).reduce((n, b) => n + (b.matchCount ?? 0), 0)
    return summed > 0 ? summed : (result.candidateCount ?? 0)
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
