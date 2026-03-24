/**
 * View API Service — First-class view persistence (de-coupled from Context Models).
 *
 * Views are visual renderings stored in the `views` table.
 * `View.config` stores the FULL `ViewConfiguration` — no lossy conversion needed.
 *
 * API scope: /api/v1/views (top-level, cross-workspace)
 */
import type { ViewConfiguration } from '@/types/schema'
import { fetchWithTimeout } from './fetchWithTimeout'

// ============================================
// Types
// ============================================

export interface View {
    id: string
    name: string
    description?: string
    contextModelId?: string
    contextModelName?: string
    workspaceId: string
    workspaceName?: string
    dataSourceId?: string
    dataSourceName?: string
    viewType: string
    config: Record<string, any>    // Full ViewConfiguration shape
    visibility: 'private' | 'workspace' | 'enterprise'
    createdBy?: string
    tags?: string[]
    isPinned: boolean
    favouriteCount: number
    isFavourited: boolean
    createdAt: string
    updatedAt: string
    deletedAt?: string | null
}

export interface ViewCreateRequest {
    name: string
    description?: string
    contextModelId?: string
    workspaceId: string
    dataSourceId?: string
    viewType?: string
    config?: Record<string, any>
    visibility?: string
    tags?: string[]
    isPinned?: boolean
}

export interface ViewUpdateRequest {
    name?: string
    description?: string
    contextModelId?: string
    viewType?: string
    config?: Record<string, any>
    visibility?: string
    tags?: string[]
    isPinned?: boolean
}

export interface ViewListParams {
    visibility?: string
    workspaceId?: string
    contextModelId?: string
    dataSourceId?: string
    search?: string
    tags?: string[]
    limit?: number
    offset?: number
    /** Return only views the current user has bookmarked/favourited. */
    favouritedOnly?: boolean
    /** Include soft-deleted views in the results. */
    includeDeleted?: boolean
    /** Return only soft-deleted views. */
    deletedOnly?: boolean
}

// ============================================
// API Client
// ============================================

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetchWithTimeout(url, {
        headers: { 'Content-Type': 'application/json', ...options?.headers },
        ...options,
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API Error ${response.status}: ${errorText || response.statusText}`)
    }
    if (response.status === 204) return undefined as T
    return response.json()
}

// ============================================
// CRUD
// ============================================

/** List accessible views with optional filtering */
export async function listViews(params?: ViewListParams): Promise<View[]> {
    const sp = new URLSearchParams()
    if (params?.visibility) sp.set('visibility', params.visibility)
    if (params?.workspaceId) sp.set('workspaceId', params.workspaceId)
    if (params?.contextModelId) sp.set('contextModelId', params.contextModelId)
    if (params?.dataSourceId) sp.set('dataSourceId', params.dataSourceId)
    if (params?.search) sp.set('search', params.search)
    if (params?.tags) params.tags.forEach(t => sp.append('tags', t))
    if (params?.limit) sp.set('limit', String(params.limit))
    if (params?.offset) sp.set('offset', String(params.offset))
    if (params?.favouritedOnly) sp.set('favouritedOnly', 'true')
    if (params?.includeDeleted) sp.set('includeDeleted', 'true')
    if (params?.deletedOnly) sp.set('deletedOnly', 'true')
    const qs = sp.toString()
    return apiFetch<View[]>(`/api/v1/views/${qs ? `?${qs}` : ''}`)
}

/** List the most-favourited enterprise-visible views */
export async function listPopularViews(limit = 20): Promise<View[]> {
    return apiFetch<View[]>(`/api/v1/views/popular?limit=${limit}`)
}

/** Create a new view (workspaceId required) */
export async function createView(data: ViewCreateRequest): Promise<View> {
    return apiFetch<View>('/api/v1/views/', {
        method: 'POST',
        body: JSON.stringify(data),
    })
}

/** Get a single view by ID (enriched with workspace name + favourite data) */
export async function getView(viewId: string): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}`)
}

/** Update an existing view */
export async function updateView(viewId: string, data: ViewUpdateRequest): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    })
}

/** Delete a view. Soft-deletes by default; pass permanent=true to remove from DB. */
export async function deleteView(viewId: string, permanent = false): Promise<void> {
    const qs = permanent ? '?permanent=true' : ''
    return apiFetch<void>(`/api/v1/views/${viewId}${qs}`, { method: 'DELETE' })
}

/** Restore a soft-deleted view */
export async function restoreView(viewId: string): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}/restore`, { method: 'POST' })
}

/** Change the visibility of a view */
export async function updateViewVisibility(viewId: string, visibility: string): Promise<View> {
    return apiFetch<View>(`/api/v1/views/${viewId}/visibility`, {
        method: 'PUT',
        body: JSON.stringify({ visibility }),
    })
}

/** Favourite a view */
export async function favouriteView(viewId: string): Promise<void> {
    return apiFetch<void>(`/api/v1/views/${viewId}/favourite`, { method: 'POST' })
}

/** Unfavourite a view */
export async function unfavouriteView(viewId: string): Promise<void> {
    return apiFetch<void>(`/api/v1/views/${viewId}/favourite`, { method: 'DELETE' })
}

// ============================================
// View → ViewConfiguration converter
// ============================================

/**
 * Convert a View API response to the ViewConfiguration type
 * consumed by CanvasRouter, ViewSelector, and SidebarNav.
 *
 * View.config stores the FULL ViewConfiguration shape — we just
 * overlay the top-level identity fields.
 */
export function viewToViewConfig(view: View): ViewConfiguration {
    const cfg = view.config ?? {}
    // Derive scopeKey from the authoritative workspaceId + dataSourceId on the API
    // response, matching the format used by setActiveScopeKey() in the schema store
    // (`${wsId}/${dsId}` or `${wsId}/default`). The stored cfg.scopeKey is unreliable
    // because it was a frontend-only field and is absent on server-created views.
    const scopeKey = view.workspaceId
        ? view.dataSourceId
            ? `${view.workspaceId}/${view.dataSourceId}`
            : `${view.workspaceId}/default`
        : cfg.scopeKey ?? null
    return {
        id: view.id,
        name: view.name,
        description: view.description,
        icon: cfg.icon ?? 'Layout',
        scopeKey,
        workspaceId: view.workspaceId,
        dataSourceId: view.dataSourceId ?? null,
        workspaceName: view.workspaceName,
        isFavourited: view.isFavourited,
        content: cfg.content ?? {
            visibleEntityTypes: [],
            visibleRelationshipTypes: [],
            defaultDepth: 5,
            maxDepth: 10,
            rootEntityTypes: ['domain'],
        },
        layout: cfg.layout ?? {
            type: (view.viewType ?? 'graph') as any,
            lod: { enabled: false, levels: [] },
        },
        filters: cfg.filters ?? {
            entityTypeFilters: [],
            fieldFilters: [],
            searchableFields: [],
            quickFilters: [],
        },
        entityOverrides: cfg.entityOverrides ?? {},
        grouping: cfg.grouping,
        isDefault: false,
        isPublic: view.visibility !== 'private',
        createdBy: view.createdBy ?? 'user',
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
    }
}
