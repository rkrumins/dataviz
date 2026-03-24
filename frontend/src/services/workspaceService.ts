/**
 * Workspace Service — CRUD for workspaces and their data sources.
 * A workspace is an operational context containing one or more data sources,
 * each binding a Provider + Graph Name + Ontology.
 */

import { fetchWithTimeout } from './fetchWithTimeout'

const ADMIN_API = '/api/v1/admin/workspaces'

// ============================================================
// Data Source types
// ============================================================

export interface DataSourceCreateRequest {
    catalogItemId: string
    ontologyId?: string
    label?: string
}

export interface DataSourceUpdateRequest {
    catalogItemId?: string
    ontologyId?: string
    label?: string
    accessLevel?: string
    isActive?: boolean
    projectionMode?: string | null  // null | "in_source" | "dedicated"
    dedicatedGraphName?: string | null  // graph name when mode is "dedicated"
}

export interface DataSourceResponse {
    id: string
    workspaceId: string
    catalogItemId: string
    ontologyId?: string
    label?: string
    accessLevel: string
    isPrimary: boolean
    isActive: boolean
    projectionMode?: string | null  // null = inherit from provider
    dedicatedGraphName?: string | null  // graph name when dedicated
    createdAt: string
    updatedAt: string
}

// ============================================================
// Workspace types
// ============================================================

export interface WorkspaceCreateRequest {
    name: string
    description?: string
    dataSources: DataSourceCreateRequest[]
}

export interface WorkspaceUpdateRequest {
    name?: string
    description?: string
    isActive?: boolean
}

export interface WorkspaceResponse {
    id: string
    name: string
    description?: string
    dataSources: DataSourceResponse[]
    isDefault: boolean
    isActive: boolean
    createdAt: string
    updatedAt: string
    /** Convenience: from primary data source (backward compat) */
    providerId?: string
    graphName?: string
}

export interface WorkspaceDataSourceImpactResponse {
    views: { id: string; name: string; type: string }[]
}

// ============================================================
// HTTP helper
// ============================================================

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Workspace API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

// ============================================================
// Service
// ============================================================

export const workspaceService = {
    // ── Workspace CRUD ────────────────────────────────────────

    list(): Promise<WorkspaceResponse[]> {
        return request<WorkspaceResponse[]>(ADMIN_API)
    },

    get(id: string): Promise<WorkspaceResponse> {
        return request<WorkspaceResponse>(`${ADMIN_API}/${id}`)
    },

    create(req: WorkspaceCreateRequest): Promise<WorkspaceResponse> {
        return request<WorkspaceResponse>(ADMIN_API, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    update(id: string, req: WorkspaceUpdateRequest): Promise<WorkspaceResponse> {
        return request<WorkspaceResponse>(`${ADMIN_API}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    delete(id: string): Promise<void> {
        return request<void>(`${ADMIN_API}/${id}`, { method: 'DELETE' })
    },

    setDefault(id: string): Promise<WorkspaceResponse> {
        return request<WorkspaceResponse>(`${ADMIN_API}/${id}/set-default`, {
            method: 'POST',
        })
    },

    // ── Data Source CRUD ──────────────────────────────────────

    listDataSources(wsId: string): Promise<DataSourceResponse[]> {
        return request<DataSourceResponse[]>(`${ADMIN_API}/${wsId}/data-sources`)
    },

    async addDataSource(wsId: string, req: DataSourceCreateRequest): Promise<DataSourceResponse> {
        const url = `${ADMIN_API}/${wsId}/data-sources`
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
        })
        if (res.status === 409) {
            // Data source already exists — return the existing one
            const existing = await this.listDataSources(wsId)
            const match = existing.find(
                ds => ds.catalogItemId === req.catalogItemId
                    || (ds.providerId === req.providerId && ds.graphName === req.graphName)
            )
            if (match) return match
        }
        if (!res.ok) {
            const text = await res.text()
            throw new Error(`Workspace API ${res.status}: ${text || res.statusText}`)
        }
        return res.json()
    },

    updateDataSource(wsId: string, dsId: string, req: DataSourceUpdateRequest): Promise<DataSourceResponse> {
        return request<DataSourceResponse>(`${ADMIN_API}/${wsId}/data-sources/${dsId}`, {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    removeDataSource(wsId: string, dsId: string): Promise<void> {
        return request<void>(`${ADMIN_API}/${wsId}/data-sources/${dsId}`, {
            method: 'DELETE',
        })
    },

    setPrimaryDataSource(wsId: string, dsId: string): Promise<DataSourceResponse> {
        return request<DataSourceResponse>(`${ADMIN_API}/${wsId}/data-sources/${dsId}/set-primary`, {
            method: 'POST',
        })
    },

    setProjectionMode(workspaceId: string, dataSourceId: string, mode: string | null): Promise<DataSourceResponse> {
        return request<DataSourceResponse>(`${ADMIN_API}/${workspaceId}/data-sources/${dataSourceId}/projection-mode`, {
            method: 'PATCH',
            body: JSON.stringify({ mode: mode === null ? "" : mode }) // Backend treats "" as null override
        })
    },

    getDataSourceImpact(workspaceId: string, dataSourceId: string): Promise<WorkspaceDataSourceImpactResponse> {
        return request<WorkspaceDataSourceImpactResponse>(`${ADMIN_API}/${workspaceId}/data-sources/${dataSourceId}/impact`)
    },
}
