/**
 * Admin-tunable knobs for the insights worker's per-provider admission gate.
 *
 * The worker reads these on each acquire; absence of a row falls back
 * to module defaults. Editing here invalidates the worker's in-process
 * config cache so the change takes effect within a few jobs.
 */
import { fetchWithTimeout } from './fetchWithTimeout'

const BASE = '/api/v1/admin/insights/admission'
const CONFIG_BASE = '/api/v1/admin/insights/config'
const DISCOVERY_BASE = '/api/v1/admin/insights/discovery'

/**
 * Frontend-relevant runtime config from the backend. Mirrors
 * `InsightsConfigResponse` in `backend/app/api/v1/endpoints/insights.py`.
 * Read once at app mount via `useInsightsConfig`.
 */
export interface InsightsConfig {
    frontend_poll_interval_ms: number
    frontend_stale_time_ms: number
    job_poll_interval_ms: number
    job_max_retries: number
    discovery_refresh_interval_secs: number
    /** UI-only "Stale" threshold. StatusChip suppresses the amber pill
     *  for cache rows younger than this; default 86400s (24h). */
    ui_stale_threshold_secs: number
}

/**
 * Snapshot of the most recent discovery-scheduler tick. Mirrors
 * `DiscoverySchedulerStatusResponse` in
 * `backend/app/api/v1/endpoints/insights.py`. `last_tick_at` is null
 * until the first tick completes (after the bootstrap-delay elapses).
 */
export interface DiscoverySchedulerStatus {
    last_tick_at: string | null
    interval_secs: number
    next_tick_eta_secs: number | null
    providers: number | null
    list_jobs: number | null
    asset_jobs: number | null
    dedup_skipped: number | null
}

export interface DiscoveryTickTriggerResult {
    status: string
    providers: number
    list_jobs: number
    asset_jobs: number
    dedup_skipped: number
}

export interface ProviderAdmissionConfig {
    bucket_capacity: number
    refill_per_sec: number
}

export interface ProviderAdmissionConfigResponse extends ProviderAdmissionConfig {
    provider_id: string
    updated_at: string | null
    success_count: number
    failure_count: number
    consecutive_failures: number
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
    }
    return res.json()
}

export const insightsAdminService = {
    /** Read the current knobs + rolling-window health for a provider. */
    getAdmissionConfig(
        providerId: string,
    ): Promise<ProviderAdmissionConfigResponse> {
        return request<ProviderAdmissionConfigResponse>(`${BASE}/${providerId}`)
    },

    /** Update the knobs. Worker invalidates its in-process cache on receipt. */
    putAdmissionConfig(
        providerId: string,
        body: ProviderAdmissionConfig,
    ): Promise<ProviderAdmissionConfigResponse> {
        return request<ProviderAdmissionConfigResponse>(`${BASE}/${providerId}`, {
            method: 'PUT',
            body: JSON.stringify(body),
        })
    },

    /**
     * Read the env-driven frontend config. Cached forever in React
     * Query — see `useInsightsConfig`. Changing values requires a
     * backend restart but no frontend rebuild.
     */
    getInsightsConfig(): Promise<InsightsConfig> {
        return request<InsightsConfig>(CONFIG_BASE)
    },

    /**
     * Read the most recent discovery-scheduler tick snapshot. Used by
     * `useDiscoveryStatus` to render the auto-refresh pill in the UI.
     */
    getDiscoveryStatus(): Promise<DiscoverySchedulerStatus> {
        return request<DiscoverySchedulerStatus>(`${DISCOVERY_BASE}/status`)
    },

    /**
     * Force the discovery scheduler to run one tick right now. Same
     * dedup as the periodic tick — won't double-enqueue if workers
     * are already processing the same scope. Useful when a user wants
     * a global "recheck everything" from the ops UI.
     */
    triggerDiscoveryTick(): Promise<DiscoveryTickTriggerResult> {
        return request<DiscoveryTickTriggerResult>(`${DISCOVERY_BASE}/trigger`, {
            method: 'POST',
        })
    },
}
