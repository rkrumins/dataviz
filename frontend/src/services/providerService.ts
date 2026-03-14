/**
 * Provider Service — CRUD for registered database providers.
 * Providers are pure infrastructure: host/port/credentials, no graph or ontology.
 */

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
    permittedWorkspaces: string[]
    createdAt: string
    updatedAt: string
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Provider API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

export const providerService = {
    list(): Promise<ProviderResponse[]> {
        return request<ProviderResponse[]>(ADMIN_API)
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

    test(id: string): Promise<ConnectionTestResult> {
        return request<ConnectionTestResult>(
            `${ADMIN_API}/${id}/test`,
            { method: 'POST' },
        )
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
}
