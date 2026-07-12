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
 * The ``refetchInterval`` also keeps a slow recovery poll running while
 * the provider is offline (``provider_health === 'down'``) so a "Cached"
 * row re-fetches and returns to fresh once the provider is reachable
 * again — see ``assetStatsRefetchInterval``.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { providerService } from '@/services/providerService'
import type { Envelope, AssetStatsPayload, InsightsMeta } from '@/types/insights'
import { useInsightsConfig } from '@/hooks/useInsightsConfig'

export const ASSET_STATS_QUERY_KEY_PREFIX = 'insights-asset-stats' as const

/**
 * How often to re-check an asset whose provider is currently offline.
 * The row is showing cached figures (the "Cached" chip); we poll slowly
 * so it flips back to fresh once the provider recovers — see
 * ``assetStatsRefetchInterval``. Deliberately much slower than the
 * active-refresh cadence: recovery isn't urgent, and the read is cheap.
 */
export const PROVIDER_DOWN_RECOVERY_POLL_MS = 30_000

/**
 * Refetch cadence for an asset-stats envelope, given its ``meta`` and the
 * configured active-refresh interval. Extracted as a pure function so the
 * recovery behaviour is unit-testable without a live QueryClient.
 *
 *  - A refresh job genuinely in flight, or a first-ever compute
 *    (``computing``): poll fast at the configured interval until it settles.
 *  - Provider offline while we're showing cached figures
 *    (``provider_health === 'down'``): poll at the slow recovery cadence so
 *    the "Cached" chip re-fetches and returns to fresh once the provider is
 *    reachable again. The backend read is a cheap cached lookup — it does
 *    NOT probe the provider live — and React Query pauses ``refetchInterval``
 *    while the tab is hidden, so this detects recovery without reintroducing
 *    the request storm a fast per-row poll would cause.
 *  - Otherwise (fresh/stale with a healthy provider): no polling. A stale-
 *    but-healthy row has no pending job (reads never enqueue provider work);
 *    its refresh is owned by the background sweep and the explicit /refresh.
 */
export function assetStatsRefetchInterval(
    meta: InsightsMeta | undefined,
    pollIntervalMs: number,
): number | false {
    if (!meta) return false
    if (meta.refreshing) return pollIntervalMs
    if (meta.status === 'computing') return pollIntervalMs
    if (meta.provider_health === 'down') return PROVIDER_DOWN_RECOVERY_POLL_MS
    return false
}

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
        // React Query aborts the signal when the query unmounts or is
        // cancelled — switching providers now cancels superseded
        // requests instead of letting them run to completion.
        queryFn: ({ signal }) => providerService.getAssetStats(providerId, assetName, signal),
        enabled: enabled && Boolean(providerId) && Boolean(assetName),
        // Cadence lives in ``assetStatsRefetchInterval`` (pure + tested):
        // fast while a job is in flight or first-ever computing; a slow
        // recovery poll while the provider is offline so a "Cached" row
        // notices the provider coming back; no poll for a healthy
        // fresh/stale row (its refresh is the background sweep's job).
        refetchInterval: (q) =>
            assetStatsRefetchInterval(q.state.data?.meta, config.frontend_poll_interval_ms),
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
