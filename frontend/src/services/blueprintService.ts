/**
 * Blueprint Service — CRUD for ontology blueprints.
 * Blueprints are standalone, versioned, reusable semantic configurations.
 */

const ADMIN_API = '/api/v1/admin/blueprints'

export interface BlueprintCreateRequest {
    name: string
    containmentEdgeTypes?: string[]
    lineageEdgeTypes?: string[]
    edgeTypeMetadata?: Record<string, unknown>
    entityTypeHierarchy?: Record<string, unknown>
    rootEntityTypes?: string[]
    visualOverrides?: Record<string, unknown>
}

export interface BlueprintUpdateRequest {
    name?: string
    containmentEdgeTypes?: string[]
    lineageEdgeTypes?: string[]
    edgeTypeMetadata?: Record<string, unknown>
    entityTypeHierarchy?: Record<string, unknown>
    rootEntityTypes?: string[]
    visualOverrides?: Record<string, unknown>
}

export interface BlueprintResponse {
    id: string
    name: string
    version: number
    containmentEdgeTypes: string[]
    lineageEdgeTypes: string[]
    edgeTypeMetadata: Record<string, unknown>
    entityTypeHierarchy: Record<string, unknown>
    rootEntityTypes: string[]
    visualOverrides: Record<string, unknown>
    isPublished: boolean
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
        throw new Error(`Blueprint API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

export const blueprintService = {
    list(allVersions = false): Promise<BlueprintResponse[]> {
        const url = allVersions ? `${ADMIN_API}?all_versions=true` : ADMIN_API
        return request<BlueprintResponse[]>(url)
    },

    get(id: string): Promise<BlueprintResponse> {
        return request<BlueprintResponse>(`${ADMIN_API}/${id}`)
    },

    create(req: BlueprintCreateRequest): Promise<BlueprintResponse> {
        return request<BlueprintResponse>(ADMIN_API, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    update(id: string, req: BlueprintUpdateRequest): Promise<BlueprintResponse> {
        return request<BlueprintResponse>(`${ADMIN_API}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    delete(id: string): Promise<void> {
        return request<void>(`${ADMIN_API}/${id}`, { method: 'DELETE' })
    },

    publish(id: string): Promise<BlueprintResponse> {
        return request<BlueprintResponse>(`${ADMIN_API}/${id}/publish`, {
            method: 'POST',
        })
    },
}
