/**
 * View Service — thin wrapper over contextModelService.
 *
 * Delegates all persistence to the Context Model API (the single source of truth).
 * Updates the local schema store as a cache after each operation.
 */

import type { ViewConfiguration, ViewLayerConfig, FieldFilter } from '@/types/schema'
import { useSchemaStore } from '@/store/schema'
import * as cms from './contextModelService'

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
 * Build the view config blob from the local request format.
 */
function buildViewConfig(request: CreateViewRequest | UpdateViewRequest): Record<string, unknown> {
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

// ============================================
// View Service Implementation
// ============================================

class ViewServiceImpl {
    /**
     * Create a new view via the Context Model API, then sync to local store.
     */
    async createView(request: CreateViewRequest): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const result = await cms.createView({
                name: request.name,
                description: request.description,
                layersConfig: request.layers ?? [],
                instanceAssignments: {},
                viewType: request.layoutType,
                config: buildViewConfig(request),
                visibility: request.visibility ?? 'private',
                tags: request.tags,
                workspaceId: request.workspaceId,
            })

            const viewConfig = cms.contextModelToViewConfig(result)
            useSchemaStore.getState().addView(viewConfig)

            return { success: true, data: viewConfig }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Update an existing view, then sync to local store.
     */
    async updateView(id: string, request: UpdateViewRequest): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const result = await cms.updateView(id, {
                name: request.name,
                ...(request.layoutType && { viewType: request.layoutType }),
                ...(request.layers && { layersConfig: request.layers }),
                config: buildViewConfig(request),
                visibility: request.visibility,
                tags: request.tags,
            })

            const viewConfig = cms.contextModelToViewConfig(result)
            useSchemaStore.getState().addOrUpdateView(viewConfig)

            return { success: true, data: viewConfig }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Delete a view, then remove from local store.
     */
    async deleteView(id: string): Promise<ViewServiceResult<void>> {
        try {
            await cms.deleteView(id)
            useSchemaStore.getState().removeView(id)
            return { success: true }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Get a single view by ID from the API.
     */
    async getView(id: string): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const result = await cms.getView(id)
            const viewConfig = cms.contextModelToViewConfig(result)
            return { success: true, data: viewConfig }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * List all views from the API.
     */
    async listViews(params?: cms.ViewListParams): Promise<ViewServiceResult<ViewConfiguration[]>> {
        try {
            const results = await cms.listViews(params)
            return { success: true, data: results.map(cms.contextModelToViewConfig) }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Duplicate a view.
     */
    async duplicateView(id: string, workspaceId: string): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const getResult = await this.getView(id)
            if (!getResult.success || !getResult.data) {
                return { success: false, error: 'View not found' }
            }

            const sourceView = getResult.data
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
