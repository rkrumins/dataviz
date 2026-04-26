/**
 * useDiscoveryStatus — read the discovery-scheduler tick snapshot.
 *
 * Powers the "Auto-refreshes every X · Last refresh Ym ago" pill in
 * RegistryAssets's RefreshControl. The backend exposes the snapshot at
 * /api/v1/admin/insights/discovery/status; this hook polls it on a
 * cadence derived from the configured refresh interval so the UI's
 * "Y minutes ago" stays approximately in sync with reality without
 * burning bandwidth on a tight loop.
 *
 * Polling cadence: half the configured discovery interval, clamped to
 * [15s, 60s]. The endpoint is cheap (one Redis-less in-memory read)
 * but still needn't be hit every second; clamping ensures both that
 * we don't poll faster than the scheduler can possibly tick, and that
 * we still update reasonably promptly when the cadence is short
 * (e.g. ops set DISCOVERY_REFRESH_INTERVAL_SECS=60 for testing).
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
    insightsAdminService,
    type DiscoverySchedulerStatus,
} from '@/services/insightsAdminService'
import { useInsightsConfig } from '@/hooks/useInsightsConfig'

export const DISCOVERY_STATUS_QUERY_KEY = ['insights-discovery-status'] as const

const MIN_POLL_MS = 15_000
const MAX_POLL_MS = 60_000

export function useDiscoveryStatus(): UseQueryResult<DiscoverySchedulerStatus, Error> {
    const config = useInsightsConfig()

    // Keep the UI's "last refresh Ym ago" reasonably current. Half-cadence
    // means we'll observe a new tick within at most one refresh-interval-half,
    // clamped so a 1800s cadence doesn't translate to a 15-minute UI lag.
    const pollMs = Math.min(
        MAX_POLL_MS,
        Math.max(MIN_POLL_MS, (config.discovery_refresh_interval_secs * 1000) / 2),
    )

    return useQuery<DiscoverySchedulerStatus, Error>({
        queryKey: [...DISCOVERY_STATUS_QUERY_KEY],
        queryFn: () => insightsAdminService.getDiscoveryStatus(),
        refetchInterval: pollMs,
        staleTime: MIN_POLL_MS,
        retry: 1,
        refetchOnWindowFocus: false,
    })
}
