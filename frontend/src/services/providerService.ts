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

export type ProviderType = 'falkordb' | 'neo4j' | 'datahub' | 'spanner' | 'mock'

export interface ProviderCreateRequest {
    name: string
    providerType: ProviderType
    host?: string
    port?: number
    credentials?: {
        username?: string
        password?: string
        token?: string
        // Spanner: GCP project + service-account JSON. service_account_json
        // is optional when extraConfig.useEmulator is true.
        project_id?: string
        service_account_json?: string
        // FalkorDB legacy dedicated cache Redis URL (deprecated — new saves
        // no longer emit this; kept for backward-compat parsing only).
        cache_redis_url?: string
        // FalkorDB dedicated CACHE endpoint credentials (Fernet-encrypted,
        // never returned). The non-secret half (host/port/db/tls paths)
        // rides extraConfig.cacheConnection.
        cache_username?: string
        cache_password?: string
        cache_sentinel_username?: string
        cache_sentinel_password?: string
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
        project_id?: string
        service_account_json?: string
        cache_redis_url?: string
        cache_username?: string
        cache_password?: string
        cache_sentinel_username?: string
        cache_sentinel_password?: string
    }
    // Explicitly remove a credential key from the stored blob (an omitted
    // field just leaves its existing value in place on merge). Used by the
    // cache "Convert to structured config" flow to drop the superseded
    // legacy cache_redis_url once its fields have been migrated.
    credentialsClear?: string[]
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
 *
 * P4.4 — code-keyed map for the stable codes the BE emits via the
 * preflight classifier (``dns_unresolvable``, ``tcp_refused``, etc.).
 * Without this, raw codes leaked to the UI as English-substring matches
 * fell through ("dns_unresolvable" doesn't contain "name or service not
 * known"). Falls through to the legacy substring matcher for unstructured
 * driver error strings still emitted by some paths.
 */
const FRIENDLY_BY_CODE: Record<string, string> = {
    dns_unresolvable: "Host not found — the configured hostname could not be resolved. Check for typos in the address.",
    tcp_refused: "Connection refused — the server at the configured host/port is not reachable. Verify the address and that the database is running.",
    connect_timeout: "Connection timed out — the server did not respond within the budget. Check that the host is accessible from this network.",
    tls_handshake: "TLS/SSL error — could not establish a secure connection. Check certificates and that TLS settings match the server configuration.",
    auth_required: "This server requires authentication, but no credentials were provided. Add a username and password, then test again.",
    auth_failed: "Authentication failed — the server rejected the provided credentials. Verify that the username and password are correct.",
    network_unreachable: "Network unreachable — the host is on a network this service cannot route to.",
    empty_reply: "The server accepted the connection but sent no reply — likely a protocol mismatch.",
    warmup_wall_clock_exceeded: "The connectivity probe exceeded its wall-clock budget. The provider may be overloaded.",
    preflight_not_implemented: "This provider type does not yet support fast connectivity probing.",
    httpx_not_installed: "Internal: the HTTP client library is not available.",
    db_unavailable: "The database is busy right now — too many open connections. Please try again in a moment.",
    provider_unavailable: "This provider is temporarily unavailable — it may be restarting or under load. Try again shortly.",
    out_of_memory: "The provider ran low on memory and is recovering. Give it a moment, then try again.",
    provider_loading: "This provider is still warming up — its data is loading and will appear shortly.",
}

export function friendlyError(raw: string): string {
    // Try to extract the "detail" / "reason" fields from JSON responses.
    let detail = raw
    let code: string | null = null
    try {
        const parsed = JSON.parse(raw)
        if (parsed.detail) {
            detail = typeof parsed.detail === 'string'
                ? parsed.detail
                : JSON.stringify(parsed.detail)
            // P4.4 — the BE's structured error envelopes may carry a
            // code field (e.g. {detail: {code: 'PROVIDER_UNAVAILABLE',
            // reason: 'dns_unresolvable'}}).
            if (typeof parsed.detail === 'object') {
                if (typeof parsed.detail.reason === 'string') code = parsed.detail.reason
                else if (typeof parsed.detail.code === 'string') code = parsed.detail.code
            }
        }
        // The /test endpoint returns {success: false, error: 'dns_unresolvable'}
        if (typeof parsed.error === 'string' && !code) code = parsed.error
        // Top-level structured errors, e.g. the async-refresh enqueue
        // failure {"code":"DB_UNAVAILABLE","reason":"Too many connections"}.
        // Without this, the raw JSON leaked into toasts and banners.
        if (!code && typeof parsed.code === 'string') code = parsed.code
        if (!code && typeof parsed.reason === 'string') code = parsed.reason
        // If there's a human 'reason' but no mapped code, prefer it over
        // the raw JSON wrapper as the fallback detail.
        if (detail === raw && typeof parsed.reason === 'string') detail = parsed.reason
    } catch { /* not JSON, use raw */ }

    if (code) {
        const lookup = FRIENDLY_BY_CODE[code.toLowerCase()]
        if (lookup) return lookup
    }

    const lower = detail.toLowerCase()

    // Code-keyed match against the raw string (some paths return just
    // the code without a JSON envelope).
    for (const [key, msg] of Object.entries(FRIENDLY_BY_CODE)) {
        if (lower.startsWith(key) || lower === key) return msg
    }

    // Legacy substring matchers for unstructured driver error strings.
    if (lower.includes('connection refused'))
        return FRIENDLY_BY_CODE.tcp_refused
    if (lower.includes('timed out') || lower.includes('timeout'))
        return FRIENDLY_BY_CODE.connect_timeout
    if (lower.includes('name or service not known') || lower.includes('nodename nor servname') || lower.includes('getaddrinfo'))
        return FRIENDLY_BY_CODE.dns_unresolvable
    // Distinguish "credentials rejected" from "server requires auth, none
    // given" for legacy raw driver strings (the BE now sends auth_failed /
    // auth_required codes directly, handled by the code lookup above).
    if (lower.includes('wrongpass') || lower.includes('invalid username-password') || lower.includes('wrong password') || lower.includes('invalid credentials') || lower.includes('invalid password'))
        return FRIENDLY_BY_CODE.auth_failed
    if (lower.includes('noauth') || lower.includes('authentication required') || lower.includes('authentication is required'))
        return FRIENDLY_BY_CODE.auth_required
    if (lower.includes('authentication') || lower.includes('auth'))
        return FRIENDLY_BY_CODE.auth_failed
    if (lower.includes('ssl') || lower.includes('tls') || lower.includes('certificate'))
        return FRIENDLY_BY_CODE.tls_handshake
    if (lower.includes('connection reset') || lower.includes('broken pipe'))
        return `Connection was reset by the server. This may indicate a protocol mismatch or that TLS is required but not enabled.`
    // Redis/FalkorDB operational states that used to leak raw driver text
    // into the UI (issues: stale "Out of Memory", raw "-LOADING", the
    // async-refresh "too many connections" enqueue failure).
    if (lower.includes('too many connections') || lower.includes('max number of clients'))
        return FRIENDLY_BY_CODE.db_unavailable
    if (lower.includes('out of memory') || lower.includes('oom command') || lower.includes("'maxmemory'"))
        return FRIENDLY_BY_CODE.out_of_memory
    if (lower.includes('loading the dataset') || lower.includes('-loading') || lower.includes('is loading'))
        return FRIENDLY_BY_CODE.provider_loading

    // Fallback: return cleaned detail without the JSON wrapper.
    return detail
}

/**
 * True when a provider error describes a *transient warming/loading*
 * state (the DB is reachable but still loading its dataset) rather than
 * a hard failure. Callers use this to show a calm "warming up" affordance
 * instead of an alarming red "unreachable" banner.
 */
export function isWarmingError(raw: string | null | undefined): boolean {
    if (!raw) return false
    const lower = raw.toLowerCase()
    return lower.includes('loading the dataset')
        || lower.includes('-loading')
        || lower.includes('is loading')
        || lower.includes('warming up')
}

async function request<T>(
    url: string,
    init?: RequestInit & { timeoutMs?: number; silent403?: boolean },
): Promise<T> {
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

// Reads are tier-gated (system:admin) at the router. Non-admin pages
// (Ingestion, Workspaces) probe these endpoints to render counts and
// pipeline nudges — surface failures to the caller but suppress the
// global access-denied modal so a viewer never sees an admin-tier
// error. Writes deliberately stay loud — those are user-initiated
// and the user needs feedback when they're blocked.
const SILENT_READ = { silent403: true } as const

export const providerService = {
    list(): Promise<ProviderResponse[]> {
        return request<ProviderResponse[]>(ADMIN_API, SILENT_READ)
    },

    listStatus(): Promise<ProviderStatusResponse[]> {
        return request<ProviderStatusResponse[]>(`${ADMIN_API}/status`, SILENT_READ)
    },

    get(id: string): Promise<ProviderResponse> {
        return request<ProviderResponse>(`${ADMIN_API}/${id}`, SILENT_READ)
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
    listAssets(id: string, signal?: AbortSignal): Promise<Envelope<AssetListPayload>> {
        return request<Envelope<AssetListPayload>>(
            `${INSIGHTS_API}/providers/${id}/assets`,
            { signal },
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
        signal?: AbortSignal,
    ): Promise<Envelope<AssetStatsPayload>> {
        return request<Envelope<AssetStatsPayload>>(
            `${INSIGHTS_API}/providers/${providerId}/assets/${encodeURIComponent(assetName)}/stats`,
            { signal },
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
        assetNames?: string[],
    ): Promise<{
        provider_id: string
        jobs_queued: number
        list_job_id: string | null
        asset_job_ids: (string | null)[]
        truncated: boolean
    }> {
        return request(
            `${INSIGHTS_API}/providers/${providerId}/assets/refresh`,
            {
                method: 'POST',
                // Scope the per-asset fan-out to what the user is
                // looking at; omitting the body keeps the legacy
                // refresh-everything behavior.
                ...(assetNames
                    ? { body: JSON.stringify({ asset_names: assetNames }) }
                    : {}),
            },
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
