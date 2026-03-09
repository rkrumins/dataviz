/**
 * Context Model API Service — Single source of truth for views & blueprints.
 *
 * Context models are the first-class entity for all view persistence:
 * - Layer configurations (how to organize graph nodes)
 * - View metadata (sharing, visibility, favourites, tags)
 * - Templates (reusable starting points)
 *
 * Two API scopes:
 * - Workspace-scoped: /api/v1/{wsId}/context-models  (blueprint CRUD)
 * - Top-level views:  /api/v1/views                   (cross-workspace discovery)
 */
import type {
    ViewLayerConfig, ScopeFilterConfig, EntityAssignmentConfig, ScopeEdgeConfig,
    ViewConfiguration,
} from '@/types/schema'

// ============================================
// Types
// ============================================

export interface ContextModel {
    id: string
    name: string
    description?: string
    workspaceId?: string
    dataSourceId?: string
    isTemplate: boolean
    category?: string
    layersConfig: ViewLayerConfig[]
    scopeFilter?: ScopeFilterConfig
    instanceAssignments: Record<string, EntityAssignmentConfig>
    scopeEdgeConfig?: ScopeEdgeConfig
    isActive: boolean
    // View metadata
    viewType?: string
    config?: Record<string, any>
    visibility: string
    createdBy?: string
    tags?: string[]
    isPinned: boolean
    favouriteCount: number
    isFavourited: boolean
    workspaceName?: string
    createdAt: string
    updatedAt: string
}

export interface ContextModelCreateRequest {
    name: string
    description?: string
    isTemplate?: boolean
    category?: string
    layersConfig: ViewLayerConfig[]
    scopeFilter?: ScopeFilterConfig | null
    instanceAssignments?: Record<string, EntityAssignmentConfig>
    scopeEdgeConfig?: ScopeEdgeConfig | null
    // View metadata
    viewType?: string
    config?: Record<string, any>
    visibility?: string
    tags?: string[]
    isPinned?: boolean
    workspaceId?: string
}

export interface ContextModelUpdateRequest {
    name?: string
    description?: string
    layersConfig?: ViewLayerConfig[]
    scopeFilter?: ScopeFilterConfig | null
    instanceAssignments?: Record<string, EntityAssignmentConfig>
    scopeEdgeConfig?: ScopeEdgeConfig | null
    // View metadata
    viewType?: string
    config?: Record<string, any>
    visibility?: string
    tags?: string[]
    isPinned?: boolean
}

export interface ViewListParams {
    visibility?: string
    workspaceId?: string
    search?: string
    tags?: string[]
    limit?: number
    offset?: number
}

// ============================================
// API Client
// ============================================

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...options?.headers },
        ...options,
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API Error ${response.status}: ${errorText || response.statusText}`)
    }
    // 204 No Content
    if (response.status === 204) return undefined as T
    return response.json()
}

// ============================================
// Workspace-Scoped Operations (Blueprints)
// ============================================

/** List all context models for a workspace */
export async function listContextModels(wsId: string): Promise<ContextModel[]> {
    return apiFetch<ContextModel[]>(`/api/v1/${wsId}/context-models`)
}

/** Get a single context model */
export async function getContextModel(wsId: string, id: string): Promise<ContextModel> {
    return apiFetch<ContextModel>(`/api/v1/${wsId}/context-models/${id}`)
}

/** Create a new context model (Save Blueprint) */
export async function createContextModel(
    wsId: string,
    data: ContextModelCreateRequest,
): Promise<ContextModel> {
    return apiFetch<ContextModel>(`/api/v1/${wsId}/context-models`, {
        method: 'POST',
        body: JSON.stringify(data),
    })
}

/** Update an existing context model (Save Blueprint) */
export async function updateContextModel(
    wsId: string,
    id: string,
    data: ContextModelUpdateRequest,
): Promise<ContextModel> {
    return apiFetch<ContextModel>(`/api/v1/${wsId}/context-models/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    })
}

/** Delete a context model */
export async function deleteContextModel(wsId: string, id: string): Promise<void> {
    return apiFetch<void>(`/api/v1/${wsId}/context-models/${id}`, { method: 'DELETE' })
}

/** Create a workspace context model from a Quick Start Template */
export async function instantiateTemplate(
    wsId: string,
    templateId: string,
    name: string,
): Promise<ContextModel> {
    return apiFetch<ContextModel>(`/api/v1/${wsId}/context-models/instantiate`, {
        method: 'POST',
        body: JSON.stringify({ templateId, name }),
    })
}

// ============================================
// Global Template Operations (Admin)
// ============================================

/** List all Quick Start Templates */
export async function listTemplates(category?: string): Promise<ContextModel[]> {
    const params = category ? `?category=${encodeURIComponent(category)}` : ''
    return apiFetch<ContextModel[]>(`/api/v1/admin/context-model-templates${params}`)
}

/** Create a Quick Start Template */
export async function createTemplate(data: ContextModelCreateRequest): Promise<ContextModel> {
    return apiFetch<ContextModel>('/api/v1/admin/context-model-templates', {
        method: 'POST',
        body: JSON.stringify({ ...data, isTemplate: true }),
    })
}

// ============================================
// Top-Level View Operations (cross-workspace)
// ============================================

/** List accessible views with optional filtering */
export async function listViews(params?: ViewListParams): Promise<ContextModel[]> {
    const searchParams = new URLSearchParams()
    if (params?.visibility) searchParams.set('visibility', params.visibility)
    if (params?.workspaceId) searchParams.set('workspaceId', params.workspaceId)
    if (params?.search) searchParams.set('search', params.search)
    if (params?.tags) params.tags.forEach(t => searchParams.append('tags', t))
    if (params?.limit) searchParams.set('limit', String(params.limit))
    if (params?.offset) searchParams.set('offset', String(params.offset))
    const qs = searchParams.toString()
    return apiFetch<ContextModel[]>(`/api/v1/views/${qs ? `?${qs}` : ''}`)
}

/** List the most-favourited enterprise-visible views */
export async function listPopularViews(limit = 20): Promise<ContextModel[]> {
    return apiFetch<ContextModel[]>(`/api/v1/views/popular?limit=${limit}`)
}

/** Create a new view (workspace_id required in data) */
export async function createView(data: ContextModelCreateRequest): Promise<ContextModel> {
    return apiFetch<ContextModel>('/api/v1/views/', {
        method: 'POST',
        body: JSON.stringify(data),
    })
}

/** Get a single view by ID (enriched with workspace name + favourite data) */
export async function getView(viewId: string): Promise<ContextModel> {
    return apiFetch<ContextModel>(`/api/v1/views/${viewId}`)
}

/** Update an existing view */
export async function updateView(viewId: string, data: ContextModelUpdateRequest): Promise<ContextModel> {
    return apiFetch<ContextModel>(`/api/v1/views/${viewId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    })
}

/** Delete a view */
export async function deleteView(viewId: string): Promise<void> {
    return apiFetch<void>(`/api/v1/views/${viewId}`, { method: 'DELETE' })
}

/** Change the visibility of a view */
export async function updateViewVisibility(viewId: string, visibility: string): Promise<ContextModel> {
    return apiFetch<ContextModel>(`/api/v1/views/${viewId}/visibility`, {
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
// ContextModel → ViewConfiguration converter
// ============================================

/**
 * Convert a ContextModel API response to the ViewConfiguration type
 * consumed by CanvasRouter, ViewSelector, and SidebarNav.
 */
export function contextModelToViewConfig(cm: ContextModel): ViewConfiguration {
    const cfg = cm.config ?? {}
    return {
        id: cm.id,
        name: cm.name,
        description: cm.description,
        icon: cfg.icon ?? 'Layout',
        content: cfg.content ?? {
            visibleEntityTypes: [],
            visibleRelationshipTypes: [],
            defaultDepth: 5,
            maxDepth: 10,
            rootEntityTypes: ['domain'],
        },
        layout: cfg.layout ?? {
            type: (cm.viewType ?? 'graph') as any,
            lod: { enabled: false, levels: [] },
        },
        filters: cfg.filters ?? {
            entityTypeFilters: [],
            fieldFilters: [],
            searchableFields: [],
            quickFilters: [],
        },
        entityOverrides: cfg.entityOverrides ?? {},
        isDefault: false,
        isPublic: cm.visibility !== 'private',
        createdBy: cm.createdBy ?? 'user',
        createdAt: cm.createdAt,
        updatedAt: cm.updatedAt,
    }
}

// ============================================
// Draft Save (Autosave)
// ============================================

/**
 * createOrUpdate — upsert helper.
 * If `existingId` provided → PATCH, otherwise POST.
 * Returns the full ContextModel (including the ID assigned by the backend).
 */
export async function createOrUpdate(
    wsId: string,
    data: ContextModelCreateRequest,
    existingId?: string | null
): Promise<ContextModel> {
    if (existingId) {
        return updateContextModel(wsId, existingId, {
            name: data.name,
            description: data.description,
            layersConfig: data.layersConfig,
            scopeFilter: data.scopeFilter,
            instanceAssignments: data.instanceAssignments,
            scopeEdgeConfig: data.scopeEdgeConfig,
        })
    }
    return createContextModel(wsId, data)
}

/**
 * makeDraftSave — closure factory that returns a debounced autosave function.
 *
 * `delayMs` defaults to 800 ms. The returned function can be called freely;
 * only the last call within the debounce window hits the network.
 *
 * The returned function also exposes `.flush()` to force an immediate write
 * (call on wizard submit / step change).
 *
 * Usage:
 *   const autosave = makeDraftSave(wsId, 800)
 *   autosave({ name, layersConfig, instanceAssignments }, draftIdRef)
 *   autosave.flush()
 */
export function makeDraftSave(wsId: string, delayMs = 800) {
    let timer: ReturnType<typeof setTimeout> | null = null
    let pending: (() => Promise<void>) | null = null

    async function run(
        data: ContextModelCreateRequest,
        draftIdRef: React.MutableRefObject<string | null>,
        onSaved?: (model: ContextModel) => void,
        onError?: (err: Error) => void
    ) {
        try {
            const saved = await createOrUpdate(wsId, data, draftIdRef.current)
            draftIdRef.current = saved.id
            onSaved?.(saved)
        } catch (err) {
            console.error('[draftSave] autosave failed:', err)
            onError?.(err instanceof Error ? err : new Error(String(err)))
        }
    }

    function schedule(
        data: ContextModelCreateRequest,
        draftIdRef: React.MutableRefObject<string | null>,
        onSaved?: (model: ContextModel) => void,
        onError?: (err: Error) => void
    ) {
        pending = () => run(data, draftIdRef, onSaved, onError)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            pending?.()
            pending = null
            timer = null
        }, delayMs)
    }

    schedule.flush = async () => {
        if (timer) {
            clearTimeout(timer)
            timer = null
        }
        if (pending) {
            await pending()
            pending = null
        }
    }

    return schedule
}

// React import needed for MutableRefObject typing — imported via the consumer.
// If tree-shaking strips this, consumers must import React themselves.
import type React from 'react'
