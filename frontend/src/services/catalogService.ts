/**
 * Catalog Service — CRUD for Enterprise Catalog Items.
 * Catalog Items abstract a physical provider's namespace into a manageable entity.
 */

import { ProviderImpactResponse } from './providerService'
import { fetchWithTimeout } from './fetchWithTimeout'

const ADMIN_API = '/api/v1/admin/catalog'

export interface CatalogItemCreateRequest {
    providerId: string
    sourceIdentifier?: string
    name: string
    description?: string
    permittedWorkspaces?: string[]
}

export interface CatalogItemUpdateRequest {
    name?: string
    description?: string
    status?: string
    permittedWorkspaces?: string[]
}

export interface CatalogItemResponse {
    id: string
    providerId: string
    sourceIdentifier?: string
    name: string
    description?: string
    permittedWorkspaces: string[]
    status: string
    createdAt: string
    updatedAt: string
}

export interface CatalogItemBindingResponse {
    id: string
    providerId: string
    sourceIdentifier?: string
    name: string
    boundWorkspaceId?: string | null
    boundWorkspaceName?: string | null
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Catalog API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

export const catalogService = {
    async list(providerId?: string): Promise<CatalogItemResponse[]> {
        const url = providerId ? `${ADMIN_API}?providerId=${providerId}` : ADMIN_API
        const res = await fetchWithTimeout(url)
        if (!res.ok) throw new Error('Failed to load catalog items')
        return res.json()
    },

    get(id: string): Promise<CatalogItemResponse> {
        return request<CatalogItemResponse>(`${ADMIN_API}/${id}`)
    },

    async create(req: CatalogItemCreateRequest): Promise<CatalogItemResponse> {
        const res = await fetchWithTimeout(ADMIN_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
        })
        if (!res.ok) throw new Error('Failed to create catalog item')
        return res.json()
    },

    update(id: string, req: CatalogItemUpdateRequest): Promise<CatalogItemResponse> {
        return request<CatalogItemResponse>(`${ADMIN_API}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    delete(id: string, force: boolean = false): Promise<void> {
        return request<void>(`${ADMIN_API}/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' })
    },

    getImpact(id: string): Promise<ProviderImpactResponse> {
        return request<ProviderImpactResponse>(`${ADMIN_API}/${id}/impact`)
    },

    async listWithBindings(providerId?: string): Promise<CatalogItemBindingResponse[]> {
        const url = providerId
            ? `${ADMIN_API}/bindings?providerId=${providerId}`
            : `${ADMIN_API}/bindings`
        const res = await fetchWithTimeout(url)
        if (!res.ok) throw new Error('Failed to load catalog bindings')
        return res.json()
    },
}
