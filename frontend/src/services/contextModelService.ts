/**
 * Context Model API Service — Data governance layer.
 *
 * Context models define HOW to organize graph data (layers, assignments, scope).
 * Views (visual rendering) are handled by viewApiService.ts.
 *
 * Two API scopes:
 * - Workspace-scoped: /api/v1/{wsId}/context-models  (blueprint CRUD)
 * - Admin templates:  /api/v1/admin/context-model-templates
 */
import type {
    ViewLayerConfig, ScopeFilterConfig, EntityAssignmentConfig, ScopeEdgeConfig,
} from '@/types/schema'
import { fetchWithTimeout } from './fetchWithTimeout'

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
}

export interface ContextModelUpdateRequest {
    name?: string
    description?: string
    layersConfig?: ViewLayerConfig[]
    scopeFilter?: ScopeFilterConfig | null
    instanceAssignments?: Record<string, EntityAssignmentConfig>
    scopeEdgeConfig?: ScopeEdgeConfig | null
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
// Draft Save (Autosave)
// ============================================

/**
 * createOrUpdate — upsert helper.
 * If `existingId` provided → PUT, otherwise POST.
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
import type React from 'react'
