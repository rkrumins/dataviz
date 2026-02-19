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
}

export interface ProviderResponse {
    id: string
    name: string
    providerType: ProviderType
    host?: string
    port?: number
    tlsEnabled: boolean
    isActive: boolean
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

    test(id: string): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
        return request<{ success: boolean; latencyMs?: number; error?: string }>(
            `${ADMIN_API}/${id}/test`,
            { method: 'POST' },
        )
    },

    listGraphs(id: string): Promise<{ graphs: string[] }> {
        return request<{ graphs: string[] }>(`${ADMIN_API}/${id}/graphs`)
    },
}
