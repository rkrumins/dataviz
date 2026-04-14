/**
 * Provider Service — CRUD for registered database providers.
 * Providers are pure infrastructure: host/port/credentials, no graph or ontology.
 */

import { fetchWithTimeout } from './fetchWithTimeout'

const ADMIN_API = '/api/v1/admin/providers'

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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
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
        opts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<ConnectionTestResult> {
        const result = await request<ConnectionTestResult>(
            `${ADMIN_API}/${id}/test`,
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

    listAssets(id: string): Promise<{ assets: string[] }> {
        return request<{ assets: string[] }>(`${ADMIN_API}/${id}/assets`)
    },

    getAssetStats(providerId: string, assetName: string): Promise<any> {
        return request<any>(`${ADMIN_API}/${providerId}/assets/${assetName}/stats`)
    },

    discoverSchema(providerId: string, assetName?: string): Promise<SchemaDiscoveryResult> {
        return request<SchemaDiscoveryResult>(
            `${ADMIN_API}/${providerId}/discover-schema`,
            { method: 'POST', body: JSON.stringify({ assetName: assetName || null }) },
        )
    },
}
