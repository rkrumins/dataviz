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
 * The hook does NOT tune staleTime per envelope status — React
 * Query v5's staleTime is fixed at query-definition time. We pick
 * one value short enough to revalidate stale rows but long enough
 * that scrolling/filter toggles don't trigger spurious refetches.
 * Active refresh while a worker is mid-job is handled by
 * ``refetchInterval``, not staleTime.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { providerService } from '@/services/providerService'
import type { Envelope, AssetStatsPayload } from '@/types/insights'

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
    return useQuery<Envelope<AssetStatsPayload>, Error>({
        queryKey: [ASSET_STATS_QUERY_KEY_PREFIX, providerId, assetName],
        queryFn: () => providerService.getAssetStats(providerId, assetName),
        enabled: enabled && Boolean(providerId) && Boolean(assetName),
        // While the backend reports a refresh job is in flight, poll
        // every 5s. Once meta.refreshing flips to false (or status
        // settles to fresh/stale), refetchInterval returns false and
        // React Query stops polling automatically.
        refetchInterval: (q) => {
            const meta = q.state.data?.meta
            if (meta?.refreshing) return 5_000
            if (meta?.status === 'computing') return 5_000
            return false
        },
        // 60s is a compromise: short enough that a stale row gets
        // revalidated sometimes; long enough that a quick filter
        // toggle doesn't trigger a refetch. Active refresh is the
        // refetchInterval's job.
        staleTime: 60_000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
        retryDelay: 800,
    })
}
