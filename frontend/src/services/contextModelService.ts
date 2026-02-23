/**
 * Context Model API Service
 *
 * Handles CRUD operations for context models (backend-persisted layer configurations).
 * Context models define how to organize graph nodes into logical business flows.
 */
import type { ViewLayerConfig, ScopeFilterConfig, EntityAssignmentConfig, ScopeEdgeConfig } from '@/types/schema'

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
// Workspace-Scoped Operations
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
