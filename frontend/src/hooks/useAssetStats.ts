/**
 * useAssetStats — React Query wrapper around
 * ``providerService.getAssetStats``.
 *
 * Replaces the local ``useState<Envelope> + useEffect+fetch`` pattern
 * inside ``RegistryAssets``'s ``AssetRow`` so:
 *   * Filter toggles that unmount/remount rows reuse the cached
 *     envelope (gcTime window) instead of re-fetching from cold.
 *   * Multiple consumers for the same (providerId, assetName) share
 *     one in-flight request via the query key.
 *   * Backend recovery invalidation
 *     (``useBackendRecovery`` extends to ``insights-*`` keys) catches
 *     this hook automatically.
 *   * Polling cadence comes from ``refetchInterval`` driven by
 *     ``meta.refreshing`` rather than a parallel setTimeout loop.
 *
 * Polling cadence + staleTime are env-driven via
 * ``useInsightsConfig`` so ops can tune them at the backend without
 * a frontend rebuild. Defaults match
 * ``backend/app/config/resilience.py``.
 *
 * The ``refetchInterval`` predicate also fires on ``status === 'stale'``
 * — defensive against a backend that fails to set ``meta.refreshing``
 * for any reason. Today the backend always pairs ``stale`` with
 * ``refreshing=true`` so this is dead defense; tomorrow it costs
 * nothing.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { providerService } from '@/services/providerService'
import type { Envelope, AssetStatsPayload } from '@/types/insights'
import { useInsightsConfig } from '@/hooks/useInsightsConfig'

export const ASSET_STATS_QUERY_KEY_PREFIX = 'insights-asset-stats' as const

interface UseAssetStatsOptions {
    /** Defer the request until visible / ready. Default true. */
    enabled?: boolean
}

export function useAssetStats(
    providerId: string,
    assetName: string,
    { enabled = true }: UseAssetStatsOptions = {},
): UseQueryResult<Envelope<AssetStatsPayload>, Error> {
    const config = useInsightsConfig()

    return useQuery<Envelope<AssetStatsPayload>, Error>({
        queryKey: [ASSET_STATS_QUERY_KEY_PREFIX, providerId, assetName],
        queryFn: () => providerService.getAssetStats(providerId, assetName),
        enabled: enabled && Boolean(providerId) && Boolean(assetName),
        // While the backend reports the cache is non-fresh (mid-refresh,
        // computing, or stale), poll at the configured interval. Once
        // status settles to ``fresh``, refetchInterval returns false
        // and React Query stops polling automatically.
        refetchInterval: (q) => {
            const meta = q.state.data?.meta
            const interval = config.frontend_poll_interval_ms
            if (meta?.refreshing) return interval
            if (meta?.status === 'computing') return interval
            if (meta?.status === 'stale') return interval
            return false
        },
        // staleTime tuned via env. Short enough that a stale row gets
        // revalidated sometimes; long enough that a quick filter
        // toggle doesn't trigger a refetch. Active refresh is the
        // refetchInterval's job.
        staleTime: config.frontend_stale_time_ms,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
        retryDelay: 800,
    })
}
