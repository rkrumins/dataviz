/**
 * View Service - CRUD operations for view configurations
 * 
 * API-Ready: Uses local storage/state now, but interface is
 * designed for easy swap to REST/GraphQL backend calls.
 */

import type { ViewConfiguration, ViewLayerConfig, FieldFilter } from '@/types/schema'
import { useSchemaStore } from '@/store/schema'

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
}

export interface ViewServiceResult<T> {
    success: boolean
    data?: T
    error?: string
}

// ============================================
// View Service Implementation
// ============================================

class ViewServiceImpl {
    /**
     * Create a new view
     */
    async createView(request: CreateViewRequest): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const now = new Date().toISOString()
            const id = `view-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

            const newView: ViewConfiguration = {
                id,
                name: request.name,
                description: request.description,
                icon: request.icon ?? 'Layout',
                content: {
                    visibleEntityTypes: request.visibleEntityTypes ?? [],
                    visibleRelationshipTypes: request.visibleRelationshipTypes ?? [],
                    defaultDepth: 5,
                    maxDepth: 10,
                    rootEntityTypes: ['domain']
                },
                layout: {
                    type: request.layoutType,
                    graphLayout: request.layoutType === 'graph' ? {
                        algorithm: 'dagre',
                        direction: 'LR',
                        nodeSpacing: 60,
                        levelSpacing: 120
                    } : undefined,
                    referenceLayout: request.layoutType === 'reference' ? {
                        layers: request.layers ?? []
                    } : undefined,
                    lod: { enabled: false, levels: [] }
                },
                filters: {
                    entityTypeFilters: [],
                    fieldFilters: request.fieldFilters ?? [],
                    searchableFields: [],
                    quickFilters: []
                },
                entityOverrides: {},
                isDefault: false,
                isPublic: true,
                createdBy: 'user',
                createdAt: now,
                updatedAt: now
            }

            // Save to store
            useSchemaStore.getState().addView(newView)

            return { success: true, data: newView }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Update an existing view
     */
    async updateView(id: string, request: UpdateViewRequest): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const schema = useSchemaStore.getState().schema
            if (!schema) {
                return { success: false, error: 'Schema not loaded' }
            }

            const existingView = schema.views.find(v => v.id === id)
            if (!existingView) {
                return { success: false, error: 'View not found' }
            }

            const updatedView: ViewConfiguration = {
                ...existingView,
                name: request.name ?? existingView.name,
                description: request.description ?? existingView.description,
                icon: request.icon ?? existingView.icon,
                content: {
                    ...existingView.content,
                    visibleEntityTypes: request.visibleEntityTypes ?? existingView.content.visibleEntityTypes,
                    visibleRelationshipTypes: request.visibleRelationshipTypes ?? existingView.content.visibleRelationshipTypes
                },
                layout: {
                    ...existingView.layout,
                    type: request.layoutType ?? existingView.layout.type,
                    referenceLayout: request.layers ? { layers: request.layers } : existingView.layout.referenceLayout
                },
                filters: {
                    ...existingView.filters,
                    fieldFilters: request.fieldFilters ?? existingView.filters.fieldFilters
                },
                updatedAt: new Date().toISOString()
            }

            // Use store's updateView method with the entire updated view
            useSchemaStore.getState().addOrUpdateView(updatedView)

            return { success: true, data: updatedView }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Delete a view
     */
    async deleteView(id: string): Promise<ViewServiceResult<void>> {
        try {
            const schema = useSchemaStore.getState().schema
            if (!schema) {
                return { success: false, error: 'Schema not loaded' }
            }

            useSchemaStore.getState().removeView(id)

            return { success: true }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * Get a single view by ID
     */
    async getView(id: string): Promise<ViewServiceResult<ViewConfiguration>> {
        try {
            const schema = useSchemaStore.getState().schema
            const view = schema?.views.find(v => v.id === id)

            if (!view) {
                return { success: false, error: 'View not found' }
            }

            return { success: true, data: view }
        } catch (error) {
            return { success: false, error: (error as Error).message }
        }
    }

    /**
     * List all views
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
     * Duplicate a view
     */
    async duplicateView(id: string): Promise<ViewServiceResult<ViewConfiguration>> {
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
                visibleRelationshipTypes: sourceView.content.visibleRelationshipTypes
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
