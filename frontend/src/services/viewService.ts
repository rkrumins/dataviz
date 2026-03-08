/**
 * View Service - API-first CRUD operations for view configurations
 *
 * All persistence goes through the /api/v1/views REST endpoints.
 * The local schema store is updated as a cache after each operation.
 */

import type { ViewConfiguration, ViewLayerConfig, FieldFilter } from '@/types/schema'
import { useSchemaStore } from '@/store/schema'
import { viewsApi, type ViewApiResponse } from './viewsApiService'

// ============================================
// Types
// ============================================

export interface CreateViewRequest {
    name: string
    description?: string
    icon?: string
    layoutType: 'graph' | 'hierarchy' | 'reference'
    layers?: ViewLayerConfig[]
    visibleEntityTypes?: string[]
    visibleRelationshipTypes?: string[]
    fieldFilters?: FieldFilter[]
    // New fields for first-class views
    workspaceId: string
    dataSourceId?: string
    visibility?: 'private' | 'workspace' | 'enterprise'
    tags?: string[]
}

export interface UpdateViewRequest {
    name?: string
    description?: string
    icon?: string
    layoutType?: 'graph' | 'hierarchy' | 'reference'
    layers?: ViewLayerConfig[]
    visibleEntityTypes?: string[]
    visibleRelationshipTypes?: string[]
    fieldFilters?: FieldFilter[]
    workspaceId?: string
    dataSourceId?: string
    visibility?: 'private' | 'workspace' | 'enterprise'
    tags?: string[]
}

export interface ViewServiceResult<T> {
    success: boolean
    data?: T
    error?: string
}

// ============================================
// Helpers
// ============================================

/**
 * Build the API config payload from the local request format.
 */
function buildConfig(request: CreateViewRequest | UpdateViewRequest): Record<string, unknown> {
    return {
        icon: request.icon ?? 'Layout',
        content: {
            visibleEntityTypes: request.visibleEntityTypes ?? [],
            visibleRelationshipTypes: request.visibleRelationshipTypes ?? [],
            defaultDepth: 5,
            maxDepth: 10,
            rootEntityTypes: ['domain'],
        },
        layout: {
            type: request.layoutType,
            graphLayout: request.layoutType === 'graph' ? {
                algorithm: 'dagre',
                direction: 'LR',
                nodeSpacing: 60,
                levelSpacing: 120,
            } : undefined,
            referenceLayout: request.layoutType === 'reference' ? {
                layers: request.layers ?? [],
            } : undefined,
            lod: { enabled: false, levels: [] },
        },
        filters: {
            entityTypeFilters: [],
            fieldFilters: request.fieldFilters ?? [],
            searchableFields: [],
            quickFilters: [],
        },
        entityOverrides: {},
    }
}

/**
 * Convert an API response into the local ViewConfiguration shape
 * so the schema store stays consistent.
 */
function apiResponseToViewConfig(res: ViewApiResponse): ViewConfiguration {
    const config = (res.config ?? {}) as Record<string, any>
    return {
        id: res.id,
        name: res.name,
        description: res.description,
        icon: config.icon ?? 'Layout',
        content: config.content ?? {
            visibleEntityTypes: [],
            visibleRelationshipTypes: [],
            defaultDepth: 5,
            maxDepth: 10,
            rootEntityTypes: ['domain'],
        },
        layout: config.layout ?? { type: 'graph', lod: { enabled: false, levels: [] } },
        filters: config.filters ?? {
            entityTypeFilters: [],
            fieldFilters: [],
            searchableFields: [],
            quickFilters: [],
        },
        entityOverrides: config.entityOverrides ?? {},
        isDefault: false,
        isPublic: (res.visibility ?? 'private') !== 'private',
        createdBy: res.createdBy ?? 'user',
        createdAt: res.createdAt,
        updatedAt: res.updatedAt,
    }
}

// ============================================
// View Service Implementation
// ============================================

class ViewServiceImpl {
    /**
     * Create a new view via API, then sync to local store.
     */
    async createView(request: CreateViewRequest): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const apiResponse = await viewsApi.create({
                name: request.name,
                description: request.description,
                viewType: request.layoutType === 'reference' ? 'CANVAS' : 'CANVAS',
                config: buildConfig(request),
                workspaceId: request.workspaceId,
                dataSourceId: request.dataSourceId,
                visibility: request.visibility ?? 'private',
                tags: request.tags,
            })

            const viewConfig = apiResponseToViewConfig(apiResponse)
            useSchemaStore.getState().addView(viewConfig)

            return { success: true, data: viewConfig }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Update an existing view via API, then sync to local store.
     */
    async updateView(id: string, request: UpdateViewRequest): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            // Fetch the current view from API to merge with updates
            const current = await viewsApi.get(id)
            const currentConfig = (current.config ?? {}) as Record<string, any>

            const mergedConfig = request.layoutType || request.visibleEntityTypes || request.layers || request.fieldFilters
                ? buildConfig({
                    ...request,
                    layoutType: request.layoutType ?? currentConfig.layout?.type ?? 'graph',
                    visibleEntityTypes: request.visibleEntityTypes ?? currentConfig.content?.visibleEntityTypes ?? [],
                    visibleRelationshipTypes: request.visibleRelationshipTypes ?? currentConfig.content?.visibleRelationshipTypes ?? [],
                    layers: request.layers ?? currentConfig.layout?.referenceLayout?.layers ?? [],
                    fieldFilters: request.fieldFilters ?? currentConfig.filters?.fieldFilters ?? [],
                    icon: request.icon ?? currentConfig.icon ?? 'Layout',
                })
                : current.config

            const apiResponse = await viewsApi.update(id, {
                name: request.name ?? current.name,
                description: request.description ?? current.description,
                viewType: current.viewType,
                config: mergedConfig as Record<string, unknown>,
                workspaceId: request.workspaceId ?? current.workspaceId ?? '',
                dataSourceId: request.dataSourceId ?? current.dataSourceId,
                visibility: request.visibility ?? current.visibility as 'private' | 'workspace' | 'enterprise',
                tags: request.tags ?? current.tags,
            })

            const viewConfig = apiResponseToViewConfig(apiResponse)
            useSchemaStore.getState().addOrUpdateView(viewConfig)

            return { success: true, data: viewConfig }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Delete a view via API, then remove from local store.
     */
    async deleteView(id: string): Promise<ViewServiceResult<void>> {
        try {
            await viewsApi.delete(id)
            useSchemaStore.getState().removeView(id)
            return { success: true }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Get a single view by ID — try local store first, fall back to API.
     */
    async getView(id: string): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            // Check local store first
            const schema = useSchemaStore.getState().schema
            const localView = schema?.views.find(v => v.id === id)
            if (localView) {
                return { success: true, data: localView }
            }

            // Fall back to API
            const apiResponse = await viewsApi.get(id)
            const viewConfig = apiResponseToViewConfig(apiResponse)
            return { success: true, data: viewConfig }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * List all views from local store.
     */
    async listViews(): Promise<ViewServiceResult<ViewConfiguration[]>> {
        try {
            const schema = useSchemaStore.getState().schema
            return { success: true, data: schema?.views ?? [] }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Duplicate a view via API.
     */
    async duplicateView(id: string, workspaceId: string): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const result = await this.getView(id)
            if (!result.success || !result.data) {
                return { success: false, error: 'View not found' }
            }

            const sourceView = result.data
            return this.createView({
                name: `${sourceView.name} (Copy)`,
                description: sourceView.description,
                icon: sourceView.icon,
                layoutType: sourceView.layout.type as 'graph' | 'hierarchy' | 'reference',
                layers: sourceView.layout.referenceLayout?.layers,
                visibleEntityTypes: sourceView.content.visibleEntityTypes,
                visibleRelationshipTypes: sourceView.content.visibleRelationshipTypes,
                workspaceId,
            })
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }
}

// Export singleton instance
export const viewService = new ViewServiceImpl()

// Export class for testing
export { ViewServiceImpl }
