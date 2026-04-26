/**
 * useInsightsConfig — read the backend-driven insights config once
 * at app mount, cache it forever client-side.
 *
 * Why a runtime endpoint instead of Vite env vars: changing polling
 * cadence or retry counts on a self-hosted enterprise deployment
 * shouldn't require rebuilding the frontend bundle. The backend
 * env vars are the single source of truth; this hook surfaces them
 * to React without coupling component code to the wire format.
 *
 * Components shouldn't await this hook — it returns sane defaults
 * synchronously while the request is in flight, so first-render
 * isn't blocked. Once the real config lands, components re-render
 * with the latest values (React Query handles the subscription).
 *
 * Defaults must match the backend defaults in
 * ``backend/app/config/resilience.py`` so a misconfigured / missing
 * /admin/insights/config endpoint degrades gracefully rather than
 * giving everyone a UI different from production.
 */
import { useQuery } from '@tanstack/react-query'
import { insightsAdminService, type InsightsConfig } from '@/services/insightsAdminService'

export const INSIGHTS_CONFIG_QUERY_KEY = ['insights-config'] as const

const DEFAULTS: InsightsConfig = {
    frontend_poll_interval_ms: 5_000,
    frontend_stale_time_ms: 60_000,
    job_poll_interval_ms: 2_000,
    job_max_retries: 4,
    discovery_refresh_interval_secs: 1_800,
    ui_stale_threshold_secs: 86_400,
}

/**
 * Returns the current insights config or sane defaults during the
 * first-render fetch. Always returns a value — never null/undefined —
 * so consumers never have to nullcheck.
 */
export function useInsightsConfig(): InsightsConfig {
    const query = useQuery<InsightsConfig, Error>({
        queryKey: [...INSIGHTS_CONFIG_QUERY_KEY],
        queryFn: () => insightsAdminService.getInsightsConfig(),
        // Config is read once and held forever. If ops changes a
        // backend env var and restarts, users pick up the new value
        // on next page load — that matches everyone's mental model
        // of how runtime config works on self-hosted platforms.
        staleTime: Infinity,
        gcTime: Infinity,
        retry: 1,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
    })

    return query.data ?? DEFAULTS
}

export { DEFAULTS as INSIGHTS_CONFIG_DEFAULTS }
