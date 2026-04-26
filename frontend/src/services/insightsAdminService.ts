/**
 * Admin-tunable knobs for the insights worker's per-provider admission gate.
 *
 * The worker reads these on each acquire; absence of a row falls back
 * to module defaults. Editing here invalidates the worker's in-process
 * config cache so the change takes effect within a few jobs.
 */
import { fetchWithTimeout } from './fetchWithTimeout'

const BASE = '/api/v1/admin/insights/admission'

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
}
