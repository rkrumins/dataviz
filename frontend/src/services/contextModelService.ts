/**
 * Context Model API Service — templates only.
 *
 * Context-model INSTANCES are retired: layers + entity assignments now live on
 * the view config (see viewApiService.ts / referenceLayout). All that remains
 * is reading the reusable Quick Start Templates the View wizard's layout gallery
 * offers.
 *
 * Read route: workspace-scoped GET /api/v1/{wsId}/context-models/templates —
 * reachable by any workspace member (workspace:datasource:read), so non-admin
 * users can browse templates without system:admin.
 */
import type {
    ViewLayerConfig, ScopeFilterConfig, EntityAssignmentConfig, ScopeEdgeConfig,
    DisplayRuleConfig,
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
    displayRulesConfig?: DisplayRuleConfig[]
    isActive: boolean
    createdAt: string
    updatedAt: string
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
// Template read operations
// ============================================

/** List Quick Start Templates available to a workspace (read-only). */
export async function listTemplates(wsId: string, category?: string): Promise<ContextModel[]> {
    const params = category ? `?category=${encodeURIComponent(category)}` : ''
    return apiFetch<ContextModel[]>(`/api/v1/${wsId}/context-models/templates${params}`)
}
