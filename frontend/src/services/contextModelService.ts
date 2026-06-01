/**
 * Context Model API Service — Data governance layer.
 *
 * Context models define HOW to organize graph data (layers, assignments, scope).
 * Views (visual rendering) are handled by viewApiService.ts.
 *
 * API surface:
 * - Workspace-scoped: /api/v1/{wsId}/context-models  (blueprint CRUD)
 * - Templates:        /api/v1/context-model-templates  (workspace + global)
 *   (Legacy alias still mounted at /api/v1/admin/context-model-templates.)
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
    // Template metadata (populated for is_template=true; null/0 for instances).
    icon?: string
    accentColor?: string
    maintainer?: string
    aboutMarkdown?: string
    tags: string[]
    visibility: 'private' | 'workspace' | 'enterprise'
    isPinned: boolean
    instantiationCount: number
    lastUsedAt?: string
    instantiatedFromId?: string
    createdBy?: string
    deletedAt?: string
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
    // Template-only fields (ignored when isTemplate=false).
    icon?: string
    accentColor?: string
    maintainer?: string
    aboutMarkdown?: string
    tags?: string[]
    visibility?: 'private' | 'workspace' | 'enterprise'
    isPinned?: boolean
    /** Scope for new templates created via the template endpoint. Null = global. */
    workspaceId?: string | null
}

export interface ContextModelUpdateRequest {
    name?: string
    description?: string
    layersConfig?: ViewLayerConfig[]
    scopeFilter?: ScopeFilterConfig | null
    instanceAssignments?: Record<string, EntityAssignmentConfig>
    scopeEdgeConfig?: ScopeEdgeConfig | null
    category?: string
    icon?: string
    accentColor?: string
    maintainer?: string
    aboutMarkdown?: string
    tags?: string[]
    visibility?: 'private' | 'workspace' | 'enterprise'
    isPinned?: boolean
}

export interface TemplateListFilter {
    scope?: 'all' | 'global' | 'workspace'
    workspaceId?: string
    category?: string
    tag?: string
    search?: string
    sort?: 'popular' | 'recent' | 'name'
    includeDeleted?: boolean
}

export interface TemplateUsageStats {
    templateId: string
    instantiationCount: number
    lastUsedAt?: string
    instancesByWorkspace: Record<string, number>
}

// ============================================
// API Client
// ============================================

const TEMPLATES_BASE = '/api/v1/context-model-templates'

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

function buildQuery(params: Record<string, unknown>): string {
    const pairs: string[] = []
    for (const [k, v] of Object.entries(params)) {
        if (v == null || v === '') continue
        pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
    return pairs.length ? `?${pairs.join('&')}` : ''
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
// Template Operations
// ============================================

/** List Quick Start Templates with rich filtering. */
export async function listAllTemplates(filter: TemplateListFilter = {}): Promise<ContextModel[]> {
    const query = buildQuery({
        scope: filter.scope,
        workspaceId: filter.workspaceId,
        category: filter.category,
        tag: filter.tag,
        search: filter.search,
        sort: filter.sort,
        includeDeleted: filter.includeDeleted,
    })
    return apiFetch<ContextModel[]>(`${TEMPLATES_BASE}${query}`)
}

/**
 * Legacy alias — kept for the dashboard's existing call site.
 * New code should use `listAllTemplates`.
 */
export async function listTemplates(category?: string): Promise<ContextModel[]> {
    return listAllTemplates({ category })
}

/** Fetch a single template by id. */
export async function getTemplate(id: string): Promise<ContextModel> {
    return apiFetch<ContextModel>(`${TEMPLATES_BASE}/${id}`)
}

/** Create a template. `workspaceId` null = global. */
export async function createTemplate(data: ContextModelCreateRequest): Promise<ContextModel> {
    return apiFetch<ContextModel>(TEMPLATES_BASE, {
        method: 'POST',
        body: JSON.stringify({ ...data, isTemplate: true }),
    })
}

/** Update a template's metadata or configuration. */
export async function updateTemplate(
    id: string,
    data: ContextModelUpdateRequest,
): Promise<ContextModel> {
    return apiFetch<ContextModel>(`${TEMPLATES_BASE}/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    })
}

/** Delete a template. Soft delete by default; pass `permanent` for hard delete. */
export async function deleteTemplate(
    id: string,
    opts: { permanent?: boolean } = {},
): Promise<void> {
    const query = opts.permanent ? '?permanent=true' : ''
    return apiFetch<void>(`${TEMPLATES_BASE}/${id}${query}`, { method: 'DELETE' })
}

/** Duplicate an existing template, optionally targeting a workspace scope. */
export async function duplicateTemplate(
    id: string,
    name: string,
    workspaceId?: string | null,
): Promise<ContextModel> {
    return apiFetch<ContextModel>(`${TEMPLATES_BASE}/${id}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ name, workspaceId: workspaceId ?? null }),
    })
}

/** Create a template from a previously-exported payload. */
export async function importTemplate(
    payload: ContextModelCreateRequest,
): Promise<ContextModel> {
    return apiFetch<ContextModel>(`${TEMPLATES_BASE}/import`, {
        method: 'POST',
        body: JSON.stringify({ payload: { ...payload, isTemplate: true } }),
    })
}

/** Aggregated usage stats for a template. */
export async function getTemplateUsage(id: string): Promise<TemplateUsageStats> {
    return apiFetch<TemplateUsageStats>(`${TEMPLATES_BASE}/${id}/usage`)
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
