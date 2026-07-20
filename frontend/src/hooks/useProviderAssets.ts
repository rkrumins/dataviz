/**
 * useProviderAssets — React Query wrappers for the Data Sources tab's
 * provider list, per-provider physical-asset list, and catalog
 * registration state.
 *
 * Why this exists: `RegistryAssets` used to fetch these three things with
 * manual `useState` + `useEffect`, disconnected from the React Query cache
 * that per-asset stats already live in. That produced the reported bugs:
 *   * sidebar counts + Catalog Summary only filled in as you clicked each
 *     provider (counts were cached lazily, per selected provider);
 *   * a freshly-created graph needed several page reloads to appear
 *     (nothing re-listed the assets);
 *   * refresh felt delayed and left figures stale.
 *
 * Moving the list onto React Query makes the data eager (all providers'
 * counts fetch up front), self-updating (invalidate after a refresh; poll
 * while the backend is still computing a cold cache), and globally
 * consistent (the Catalog Summary sums real per-provider counts).
 *
 * Query keys are shared verbatim between the single-provider hooks and the
 * `useQueries` fan-out in `useAllProviderCounts`, so selecting a provider
 * hits the already-warmed cache instead of refetching.
 */
import { useQuery, useQueries, type UseQueryResult } from '@tanstack/react-query'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import type { Envelope, AssetListPayload } from '@/types/insights'

export const PROVIDERS_QUERY_KEY = 'providers' as const
export const PROVIDER_ASSETS_QUERY_KEY = 'provider-assets' as const
export const PROVIDER_CATALOG_QUERY_KEY = 'provider-catalog' as const

/** All configured providers. Shared by the sidebar rail + counts fan-out. */
export function useProviders(): UseQueryResult<ProviderResponse[], Error> {
    return useQuery<ProviderResponse[], Error>({
        queryKey: [PROVIDERS_QUERY_KEY],
        queryFn: () => providerService.list(),
        staleTime: 60_000,
        gcTime: 10 * 60_000,
        retry: 1,
        refetchOnWindowFocus: true,
    })
}

/**
 * Shared query options for one provider's physical-asset list. Kept in a
 * factory so the single-provider hook and the all-providers fan-out use an
 * identical key + refetch policy (React Query then dedupes them).
 *
 * `refetchInterval` polls only while the backend is still computing a cold
 * cache (`meta.status === 'computing'`) — so counts that start at 0 fill in
 * on their own without the user reloading — and stops once the list lands.
 */
function providerAssetsQueryOptions(providerId: string) {
    return {
        queryKey: [PROVIDER_ASSETS_QUERY_KEY, providerId] as const,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
            providerService.listAssets(providerId, signal),
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: 1,
        refetchOnWindowFocus: true,
        // Deliberately NO placeholderData/keepPreviousData here: the key
        // includes providerId, so keepPreviousData would serve provider A's
        // envelope under provider B's header while B's first fetch is in
        // flight (status reads 'success', isLoading false) — mis-attributed
        // assets, banners, and worse, registrable rows. Transient-null
        // envelopes are handled by assetListState below instead.
        refetchInterval: (query: { state: { data?: Envelope<AssetListPayload> } }) =>
            query.state.data?.meta?.status === 'computing' ? 5_000 : (false as const),
    }
}

/**
 * How the asset-list envelope should render when there is nothing to show.
 *
 * The insights endpoint answers 200 for every state; the payload alone can't
 * distinguish "this provider genuinely has no graphs" from "the cache has no
 * usable row yet". Only `ready` may render the true empty state:
 *  - loading     — no envelope yet, or the backend is computing a cold cache.
 *  - unavailable — data:null without a job in flight (`unavailable`, or a
 *                  cache row whose payload failed to parse).
 *  - error-stub  — the discovery worker's failure stub (payload `{}` with
 *                  `last_error` stamped): listing failed and there is no
 *                  last-known-good list to fall back on.
 *  - ready       — a fresh/stale envelope carrying a real assets array.
 */
export type AssetListState = 'loading' | 'unavailable' | 'error-stub' | 'ready'

export function assetListState(
    env: Envelope<AssetListPayload> | null | undefined,
): AssetListState {
    if (!env || env.meta?.status === 'computing') return 'loading'
    if (env.data == null) return 'unavailable'
    if (!Array.isArray(env.data.assets)) return 'error-stub'
    return 'ready'
}

function providerCatalogQueryOptions(providerId: string) {
    return {
        queryKey: [PROVIDER_CATALOG_QUERY_KEY, providerId] as const,
        queryFn: () => catalogService.list(providerId),
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: 1,
        refetchOnWindowFocus: true,
    }
}

/** One provider's physical-asset list envelope. */
export function useProviderAssets(
    providerId: string | null,
): UseQueryResult<Envelope<AssetListPayload>, Error> {
    return useQuery<Envelope<AssetListPayload>, Error>({
        ...providerAssetsQueryOptions(providerId ?? ''),
        enabled: !!providerId,
    })
}

/** One provider's registered catalog items. */
export function useProviderCatalog(
    providerId: string | null,
): UseQueryResult<CatalogItemResponse[], Error> {
    return useQuery<CatalogItemResponse[], Error>({
        ...providerCatalogQueryOptions(providerId ?? ''),
        enabled: !!providerId,
    })
}

export interface ProviderCounts {
    total: number
    registered: number
}

export interface AllProviderCounts {
    byProvider: Record<string, ProviderCounts>
    totals: { providers: number; total: number; registered: number }
    /** True until every provider's list + catalog has resolved at least once. */
    loading: boolean
}

/**
 * Eager per-provider counts for the sidebar badges + the global Catalog
 * Summary. Fans out list + catalog queries for every provider (reusing the
 * single-provider keys, so no double fetch), and sums the results.
 *
 * `registered` counts catalog entries that map to a *real* physical asset,
 * mirroring the original per-provider logic — not raw catalog length.
 */
export function useAllProviderCounts(providers: ProviderResponse[]): AllProviderCounts {
    const assetResults = useQueries({
        queries: providers.map(p => providerAssetsQueryOptions(p.id)),
    })
    const catalogResults = useQueries({
        queries: providers.map(p => providerCatalogQueryOptions(p.id)),
    })

    const byProvider: Record<string, ProviderCounts> = {}
    let total = 0
    let registered = 0
    providers.forEach((p, i) => {
        // Same classifier as the list panel — the sidebar badge and the
        // visible list must never disagree about what "has assets" means.
        const envelope = assetResults[i]?.data
        const assetList = assetListState(envelope) === 'ready'
            ? envelope!.data!.assets
            : []
        const catalog = catalogResults[i]?.data ?? []
        const existing = new Set(catalog.map(c => c.sourceIdentifier).filter(Boolean))
        const t = assetList.length
        const r = assetList.filter(a => existing.has(a)).length
        byProvider[p.id] = { total: t, registered: r }
        total += t
        registered += r
    })

    const loading = providers.length > 0
        && (assetResults.some(q => q.isLoading) || catalogResults.some(q => q.isLoading))

    return { byProvider, totals: { providers: providers.length, total, registered }, loading }
}
