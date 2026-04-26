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
}
