/**
 * Provider Service — CRUD for registered database providers.
 * Providers are pure infrastructure: host/port/credentials, no graph or ontology.
 */

import { fetchWithTimeout } from './fetchWithTimeout'
import type { Envelope, AssetListPayload, AssetStatsPayload } from '@/types/insights'

const ADMIN_API = '/api/v1/admin/providers'

// Pre-registration discovery (asset list, per-asset stats) goes through
// the insights service. The web tier reads only from cache and never
// hits a provider directly; cache-miss enqueues a background job and
// returns a `computing` envelope.
const INSIGHTS_API = '/api/v1/admin/insights'

export type ProviderType = 'falkordb' | 'neo4j' | 'datahub' | 'mock'

export interface ProviderCreateRequest {
    name: string
    providerType: ProviderType
    host?: string
    port?: number
    credentials?: {
        username?: string
        password?: string
        token?: string
    }
    tlsEnabled?: boolean
    extraConfig?: Record<string, any>
    permittedWorkspaces?: string[]
}

export interface ProviderUpdateRequest {
    name?: string
    host?: string
    port?: number
    credentials?: {
        username?: string
        password?: string
        token?: string
    }
    tlsEnabled?: boolean
    isActive?: boolean
    extraConfig?: Record<string, any>
    permittedWorkspaces?: string[]
}

export interface ConnectionTestResult {
    success: boolean
    latencyMs?: number
    error?: string
}

export interface ImpactedEntity {
    id: string
    name: string
    type: string
}

export interface ProviderImpactResponse {
    catalogItems: ImpactedEntity[]
    workspaces: ImpactedEntity[]
    views: ImpactedEntity[]
}

export interface PhysicalGraphStatsResponse {
    nodeCount: number
    edgeCount: number
    entityTypeCounts: Record<string, number>
    edgeTypeCounts: Record<string, number>
}

export interface ProviderResponse {
    id: string
    name: string
    providerType: ProviderType
    host?: string
    port?: number
    tlsEnabled: boolean
    isActive: boolean
    extraConfig?: Record<string, any>
    permittedWorkspaces: string[]
    createdAt: string
    updatedAt: string
}

export interface ProviderStatusResponse {
    id: string
    name: string
    status: 'ready' | 'unavailable' | 'unknown'
    lastCheckedAt: string | null
    error?: string
}

export interface SchemaDiscoveryResult {
    labels: string[]
    relationshipTypes: string[]
    labelDetails: Record<string, {
        count: number
        propertyKeys: string[]
        samples: Record<string, any>[]
    }>
    suggestedMapping?: Record<string, any>
}

/**
 * Parse a raw backend error into a user-friendly message.
 * Handles common connection errors from Redis/FalkorDB/Neo4j drivers.
 */
function friendlyError(raw: string): string {
    // Try to extract the "detail" field from JSON responses
    let detail = raw
    try {
        const parsed = JSON.parse(raw)
        if (parsed.detail) detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail)
    } catch { /* not JSON, use raw */ }

    const lower = detail.toLowerCase()

    if (lower.includes('connection refused'))
        return `Connection refused — the server at the configured host/port is not reachable. Verify the address and that the database is running.`
    if (lower.includes('timed out') || lower.includes('timeout'))
        return `Connection timed out — the server did not respond. Check that the host is accessible from this network and firewalls allow the connection.`
    if (lower.includes('name or service not known') || lower.includes('nodename nor servname') || lower.includes('getaddrinfo'))
        return `Host not found — the configured hostname could not be resolved. Check for typos in the address.`
    if (lower.includes('authentication') || lower.includes('auth') || lower.includes('wrong password') || lower.includes('invalid credentials'))
        return `Authentication failed — the server rejected the provided credentials. Verify your username and password.`
    if (lower.includes('ssl') || lower.includes('tls') || lower.includes('certificate'))
        return `TLS/SSL error — could not establish a secure connection. Check that TLS settings match the server configuration.`
    if (lower.includes('connection reset') || lower.includes('broken pipe'))
        return `Connection was reset by the server. This may indicate a protocol mismatch or that TLS is required but not enabled.`

    // Fallback: return cleaned detail without the JSON wrapper
    return detail
}

async function request<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(friendlyError(text || res.statusText))
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

export const providerService = {
    list(): Promise<ProviderResponse[]> {
        return request<ProviderResponse[]>(ADMIN_API)
    },

    listStatus(): Promise<ProviderStatusResponse[]> {
        return request<ProviderStatusResponse[]>(`${ADMIN_API}/status`)
    },

    get(id: string): Promise<ProviderResponse> {
        return request<ProviderResponse>(`${ADMIN_API}/${id}`)
    },

    create(req: ProviderCreateRequest): Promise<ProviderResponse> {
        return request<ProviderResponse>(ADMIN_API, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    async testConnection(
        req: ProviderCreateRequest,
        opts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<ConnectionTestResult> {
        const result = await request<ConnectionTestResult>(`${ADMIN_API}/test-connection`, {
            method: 'POST',
            body: JSON.stringify(req),
            ...(opts?.signal ? { signal: opts.signal } : {}),
            ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        })
        if (!result.success && result.error) {
            result.error = friendlyError(result.error)
        }
        return result
    },

    update(id: string, req: ProviderUpdateRequest): Promise<ProviderResponse> {
        return request<ProviderResponse>(`${ADMIN_API}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    delete(id: string): Promise<void> {
        return request<void>(`${ADMIN_API}/${id}`, { method: 'DELETE' })
    },

    async test(
        id: string,
        opts?: { signal?: AbortSignal; timeoutMs?: number; fresh?: boolean },
    ): Promise<ConnectionTestResult> {
        // `fresh=true` bypasses the 10s server-side cache. Use it on
        // explicit user clicks so a dead/recovered provider is reflected
        // immediately instead of returning a cached prior result.
        const qs = opts?.fresh ? '?fresh=true' : ''
        const result = await request<ConnectionTestResult>(
            `${ADMIN_API}/${id}/test${qs}`,
            {
                method: 'POST',
                ...(opts?.signal ? { signal: opts.signal } : {}),
                ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            } as RequestInit,
        )
        // Clean up raw driver errors in the response
        if (!result.success && result.error) {
            result.error = friendlyError(result.error)
        }
        return result
    },

    getImpact(id: string): Promise<ProviderImpactResponse> {
        return request<ProviderImpactResponse>(`${ADMIN_API}/${id}/impact`)
    },

    /**
     * Cache-only list of physical assets on a provider. The returned
     * envelope's `meta.status` tells the caller whether the payload is
     * fresh, stale, computing, or unavailable. `data` is null on
     * computing / unavailable.
     */
    listAssets(id: string): Promise<Envelope<AssetListPayload>> {
        return request<Envelope<AssetListPayload>>(
            `${INSIGHTS_API}/providers/${id}/assets`,
        )
    },

    /**
     * Cache-only per-asset node/edge counts. `data` is null on
     * computing / unavailable; consumers needing live data should poll
     * `meta.poll_url` until status flips to `fresh`.
     */
    getAssetStats(
        providerId: string,
        assetName: string,
    ): Promise<Envelope<AssetStatsPayload>> {
        return request<Envelope<AssetStatsPayload>>(
            `${INSIGHTS_API}/providers/${providerId}/assets/${encodeURIComponent(assetName)}/stats`,
        )
    },

    /**
     * Force-refresh one asset's stats. Drops any in-flight dedup
     * claim on the backend and re-enqueues a discovery job. Idempotent
     * at the cache level (UPSERT). Caller should invalidate the
     * relevant React Query key after this resolves.
     */
    refreshAssetStats(
        providerId: string,
        assetName: string,
    ): Promise<{ provider_id: string; asset_name: string; job_id: string | null; status: string }> {
        return request(
            `${INSIGHTS_API}/providers/${providerId}/assets/${encodeURIComponent(assetName)}/refresh`,
            { method: 'POST' },
        )
    },

    /**
     * Force-refresh every cached asset for a provider, plus the
     * list-all sentinel. Backend caps fan-out at
     * INSIGHTS_MAX_PROVIDER_REFRESH (default 200); response includes
     * a `truncated` flag if so. Caller should invalidate every
     * `insights-asset-stats` query for this provider.
     */
    refreshAllAssets(
        providerId: string,
    ): Promise<{
        provider_id: string
        jobs_queued: number
        list_job_id: string | null
        asset_job_ids: (string | null)[]
        truncated: boolean
    }> {
        return request(
            `${INSIGHTS_API}/providers/${providerId}/assets/refresh`,
            { method: 'POST' },
        )
    },

    /**
     * Sniff a Neo4j/DataHub provider's schema for the onboarding wizard's
     * mapping-suggestion step. Synchronous live call — backend caps the
     * provider call at 15s (see providers.py); the client waits 20s so
     * the structured 504 surfaces here rather than a generic frontend
     * abort. Not on a hot path: only the wizard hits this, once per
     * provider creation.
     */
    discoverSchema(providerId: string, assetName?: string): Promise<SchemaDiscoveryResult> {
        return request<SchemaDiscoveryResult>(
            `${ADMIN_API}/${providerId}/discover-schema`,
            {
                method: 'POST',
                body: JSON.stringify({ assetName: assetName || null }),
                timeoutMs: 20_000,
            },
        )
    },
}
