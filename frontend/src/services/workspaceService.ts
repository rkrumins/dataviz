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
    catalogItemId?: string
    ontologyId?: string
    label?: string
    // Manual/blank data sources bind a provider + graph name directly instead
    // of a catalog item; the backend accepts either shape.
    providerId?: string
    graphName?: string
    /** URN-equivalent node-identity property. Omit for the default "urn". */
    identityProperty?: string
    /** Node display-name property. Omit for the default "name". */
    nameProperty?: string
}

export interface DataSourceUpdateRequest {
    catalogItemId?: string
    ontologyId?: string
    label?: string
    accessLevel?: string
    isActive?: boolean
    projectionMode?: string | null  // null | "in_source" | "dedicated"
    dedicatedGraphName?: string | null  // graph name when mode is "dedicated"
    /** URN-equivalent node-identity property. "" clears back to the default "urn". */
    identityProperty?: string
    /** Node display-name property. "" clears back to the default "name". */
    nameProperty?: string
}

export interface DataSourceResponse {
    id: string
    workspaceId: string
    /** Absent on manual (blank) models — they have no catalog item. */
    catalogItemId?: string
    /** Provider connection + physical graph key (sent by the backend; the only
     *  provider resolution for catalog-less manual models). */
    providerId?: string
    graphName?: string
    ontologyId?: string
    label?: string
    accessLevel: string
    isPrimary: boolean
    isActive: boolean
    projectionMode?: string | null  // null = inherit from provider
    dedicatedGraphName?: string | null  // graph name when dedicated
    /** URN-equivalent node-identity property. Always populated ("urn" by default). */
    identityProperty?: string
    /** Node display-name property. Always populated ("name" by default). */
    nameProperty?: string
    /** Provenance: 'managed' = fully managed in-app graph (blank/versioned),
     *  'federated' = external system of record. Null/absent on legacy rows —
     *  resolve with {@link resolveSourceMode}. */
    sourceMode?: 'managed' | 'federated' | null
    /** Federated only: overlay edits are pushed back to the external system. */
    writeBackEnabled?: boolean
    createdAt: string
    updatedAt: string

    // Aggregation state
    aggregationStatus: 'none' | 'pending' | 'running' | 'ready' | 'failed' | 'skipped'
    lastAggregatedAt?: string
    aggregationEdgeCount: number
    aggregationSchedule?: string
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
    /** People/groups with access. Rides along with the list — asking per card
     *  would be one request per workspace. */
    memberCount?: number
    /** Live (non-deleted) views built on this workspace. */
    viewCount?: number
    /** Convenience: from primary data source (backward compat) */
    providerId?: string
    graphName?: string
}

/**
 * What deleting a data source destroys in its VERSIONED graph — and what it does not.
 *
 * `falkorGraphOwned` is the important one, and it is a recorded fact rather than a guess: we own
 * a graph if and only if we generated its name. When it is false the source is pinned to the
 * customer's own graph (`nexus_lineage`), which the purge will not touch — and the user is
 * entitled to know that BEFORE they click, not after.
 *
 * There is deliberately no grace period here. The delete is a hard delete with no restore, and a
 * dialog offering a 30-day undo would be offering something the backend cannot do.
 */
export interface VersioningImpact {
    versioned: boolean
    commits: number
    /** `owner` is a resolved human name, never a user id. Drafts are almost all "Untitled". */
    openDrafts: { id: string; name: string; owner: string }[]
    openReviews: number
    /** Entities a HUMAN edited. Machine-imported rows don't count — they can be re-imported. */
    curatedEntities: number
    storageBytes: number
    falkorGraphName: string | null
    falkorGraphOwned: boolean
}

export interface WorkspaceDataSourceImpactResponse {
    views: { id: string; name: string; type: string }[]
    versioning?: VersioningImpact | null
    /** How long a delete can be undone for. The dialog's register depends on it. */
    restoreWindowDays: number
}

/** A data source in the trash. */
export interface DeletedDataSource {
    id: string
    label: string
    deletedAt: string | null
    /** A human name, never a user id. */
    deletedBy: string
    daysLeft: number
    restoreWindowDays: number
    /** The purge has started. There is nothing left to bring back. */
    purging: boolean
    /** The ONLY field the UI may act on. Never offer Restore when this is false. */
    restorable: boolean
}

export interface ImpactedEntity {
    id: string
    name: string
    type: string
}

/**
 * What deleting a WORKSPACE destroys.
 *
 * This is not a soft delete of a container. `views.workspace_id` is
 * ON DELETE CASCADE, so every view inside is HARD-deleted — including ones
 * already in the trash awaiting restore. Data sources, every member's access
 * (workspace role bindings) and workspace-scoped custom roles go with it.
 */
export interface WorkspaceImpactResponse {
    views: ImpactedEntity[]
    dataSources: ImpactedEntity[]
    memberCount: number
    customRoleCount: number
}

/**
 * Resolve a data source's provenance when `sourceMode` is null/absent
 * (legacy rows). Mirrors the backend ORM comment: a source with no
 * catalog item is a manual/blank in-app model → managed; anything
 * onboarded from the catalog is federated by default.
 */
export function resolveSourceMode(
    ds: Pick<DataSourceResponse, 'sourceMode' | 'catalogItemId'>,
): 'managed' | 'federated' {
    return ds.sourceMode ?? (ds.catalogItemId ? 'federated' : 'managed')
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

    /**
     * One page of workspaces, filtered + RBAC-scoped + counted server-side.
     *
     * The unpaged {@link list} still exists (the workspaces store needs the
     * whole set), but any UI that just shows a list of rows should page instead
     * of pulling every workspace and its data sources to render ten of them.
     */
    async listPage(params: { limit: number; offset?: number; search?: string }): Promise<{
        items: WorkspaceResponse[]
        totalCount: number
    }> {
        const query = new URLSearchParams({
            limit: String(params.limit),
            offset: String(params.offset ?? 0),
        })
        if (params.search?.trim()) query.set('search', params.search.trim())

        const res = await fetchWithTimeout(`${ADMIN_API}?${query}`, {
            headers: { 'Content-Type': 'application/json' },
        })
        if (!res.ok) {
            const text = await res.text()
            throw new Error(`Workspace API ${res.status}: ${text || res.statusText}`)
        }
        const items: WorkspaceResponse[] = await res.json()
        // Older servers don't send the header — fall back to the page length so
        // the pager degrades to "what we can see" instead of breaking.
        const header = res.headers.get('X-Total-Count')
        return { items, totalCount: header ? Number(header) : items.length }
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

    /**
     * Move a data source to the trash. REVERSIBLE — nothing is destroyed, and `restoreDataSource`
     * puts it and its views back. Pass `permanent` only from the "delete permanently" flow, which
     * queues the purge and cannot be undone.
     */
    removeDataSource(wsId: string, dsId: string, permanent = false): Promise<void> {
        const q = permanent ? '?permanent=true' : ''
        return request<void>(`${ADMIN_API}/${wsId}/data-sources/${dsId}${q}`, {
            method: 'DELETE',
        })
    },

    restoreDataSource(wsId: string, dsId: string): Promise<DataSourceResponse> {
        return request<DataSourceResponse>(`${ADMIN_API}/${wsId}/data-sources/${dsId}/restore`, {
            method: 'POST',
        })
    },

    /** The trash. Obey `restorable` — it is False once the purge has started. */
    listDeletedDataSources(wsId: string): Promise<DeletedDataSource[]> {
        return request<DeletedDataSource[]>(`${ADMIN_API}/${wsId}/data-sources/deleted`)
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

    /**
     * Re-home a data source into another workspace.
     *
     * The server refuses (409) unless ZERO views are built on it — including
     * trashed ones. That isn't caution: views.data_source_id is ON DELETE SET
     * NULL, and a view left in workspace A pointing at a source now owned by
     * workspace B would read B's data through A's RBAC check.
     */
    moveDataSource(workspaceId: string, dataSourceId: string, targetWorkspaceId: string): Promise<DataSourceResponse> {
        return request<DataSourceResponse>(
            `${ADMIN_API}/${workspaceId}/data-sources/${dataSourceId}/move`,
            { method: 'POST', body: JSON.stringify({ targetWorkspaceId }) },
        )
    },

    /** Blast radius of deleting the whole workspace. */
    getImpact(workspaceId: string): Promise<WorkspaceImpactResponse> {
        return request<WorkspaceImpactResponse>(`${ADMIN_API}/${workspaceId}/impact`)
    },

    getDataSourceImpact(workspaceId: string, dataSourceId: string): Promise<WorkspaceDataSourceImpactResponse> {
        return request<WorkspaceDataSourceImpactResponse>(`${ADMIN_API}/${workspaceId}/data-sources/${dataSourceId}/impact`)
    },
}
