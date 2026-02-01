/**
 * Filter Engine - Smart filtering service for entities and edges
 * 
 * Features:
 * - Filter by entity type, edge type
 * - Property-value filtering (name, tags, any field)
 * - Text search with fuzzy matching
 * - Pre-indexing for performance at scale
 * 
 * API-Ready: This service can be swapped for backend calls
 */

import type { EntityInstance, RelationshipInstance, WorkspaceSchema } from '@/types/schema'

// ============================================
// Types
// ============================================

export type FilterOperator = 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'gt' | 'lt' | 'in' | 'notIn' | 'exists' | 'notExists'

export interface PropertyFilter {
    field: string
    operator: FilterOperator
    value: unknown
}

export interface TagFilter {
    mode: 'any' | 'all' | 'none'
    tags: string[]
}

export interface TextFilter {
    text: string
    operator: 'contains' | 'startsWith' | 'endsWith' | 'equals'
    caseSensitive?: boolean
}

export interface FilterCriteria {
    entityTypes?: string[]
    edgeTypes?: string[]
    propertyFilters?: PropertyFilter[]
    tagFilters?: TagFilter
    nameFilter?: TextFilter
    textSearch?: string
}

export interface FilterSuggestion {
    type: 'entityType' | 'edgeType' | 'property' | 'tag' | 'value'
    label: string
    value: string
    count?: number
    icon?: string
    color?: string
}

export interface FilterContext {
    schema: WorkspaceSchema
    availableTags?: string[]
    recentFilters?: FilterCriteria[]
}

export interface AvailableFilters {
    entityTypes: { id: string; name: string; icon: string; color: string }[]
    edgeTypes: { id: string; name: string }[]
    propertyFields: { field: string; type: string; entityTypes: string[] }[]
    tags: string[]
}

// ============================================
// Filter Engine Implementation
// ============================================

class FilterEngineImpl {
    private entityIndex: Map<string, EntityInstance> = new Map()
    private tagIndex: Map<string, Set<string>> = new Map()
    private typeIndex: Map<string, Set<string>> = new Map()
    private propertyIndex: Map<string, Map<unknown, Set<string>>> = new Map()

    /**
     * Pre-index entities for fast filtering (call once when data loads)
     */
    indexEntities(entities: EntityInstance[]): void {
        this.entityIndex.clear()
        this.tagIndex.clear()
        this.typeIndex.clear()
        this.propertyIndex.clear()

        for (const entity of entities) {
            // Main index
            this.entityIndex.set(entity.id, entity)

            // Type index
            if (!this.typeIndex.has(entity.typeId)) {
                this.typeIndex.set(entity.typeId, new Set())
            }
            this.typeIndex.get(entity.typeId)!.add(entity.id)

            // Tag index
            const tags = entity.data.tags as string[] | undefined
            if (tags) {
                for (const tag of tags) {
                    if (!this.tagIndex.has(tag)) {
                        this.tagIndex.set(tag, new Set())
                    }
                    this.tagIndex.get(tag)!.add(entity.id)
                }
            }

            // Property index for commonly filtered fields
            const commonFields = ['name', 'status', 'owner', 'domain']
            for (const field of commonFields) {
                const value = entity.data[field]
                if (value !== undefined) {
                    const fieldKey = `${entity.typeId}:${field}`
                    if (!this.propertyIndex.has(fieldKey)) {
                        this.propertyIndex.set(fieldKey, new Map())
                    }
                    const fieldIndex = this.propertyIndex.get(fieldKey)!
                    if (!fieldIndex.has(value)) {
                        fieldIndex.set(value, new Set())
                    }
                    fieldIndex.get(value)!.add(entity.id)
                }
            }
        }
    }

    /**
     * Filter entities based on criteria
     */
    filterEntities(entities: EntityInstance[], criteria: FilterCriteria): EntityInstance[] {
        if (!criteria || Object.keys(criteria).length === 0) {
            return entities
        }

        return entities.filter(entity => {
            // Entity type filter
            if (criteria.entityTypes && criteria.entityTypes.length > 0) {
                if (!criteria.entityTypes.includes(entity.typeId)) {
                    return false
                }
            }

            // Name filter
            if (criteria.nameFilter) {
                const name = String(entity.data.name || '')
                if (!this.matchesTextFilter(name, criteria.nameFilter)) {
                    return false
                }
            }

            // Tag filter
            if (criteria.tagFilters) {
                const entityTags = (entity.data.tags as string[]) || []
                if (!this.matchesTagFilter(entityTags, criteria.tagFilters)) {
                    return false
                }
            }

            // Property filters
            if (criteria.propertyFilters && criteria.propertyFilters.length > 0) {
                for (const filter of criteria.propertyFilters) {
                    if (!this.matchesPropertyFilter(entity, filter)) {
                        return false
                    }
                }
            }

            // Text search (global fuzzy search across all fields)
            if (criteria.textSearch) {
                if (!this.matchesTextSearch(entity, criteria.textSearch)) {
                    return false
                }
            }

            return true
        })
    }

    /**
     * Filter edges based on criteria
     */
    filterEdges(edges: RelationshipInstance[], criteria: FilterCriteria): RelationshipInstance[] {
        if (!criteria?.edgeTypes || criteria.edgeTypes.length === 0) {
            return edges
        }

        return edges.filter(edge => criteria.edgeTypes!.includes(edge.typeId))
    }

    /**
     * Get autocomplete suggestions for filter input
     */
    getSuggestions(partialQuery: string, context: FilterContext): FilterSuggestion[] {
        const suggestions: FilterSuggestion[] = []
        const query = partialQuery.toLowerCase().trim()

        // Suggest entity types
        for (const entityType of context.schema.entityTypes) {
            if (entityType.name.toLowerCase().includes(query) || entityType.id.toLowerCase().includes(query)) {
                suggestions.push({
                    type: 'entityType',
                    label: entityType.name,
                    value: entityType.id,
                    icon: entityType.visual.icon,
                    color: entityType.visual.color,
                    count: this.typeIndex.get(entityType.id)?.size ?? 0
                })
            }
        }

        // Suggest tags
        if (context.availableTags) {
            for (const tag of context.availableTags) {
                if (tag.toLowerCase().includes(query)) {
                    suggestions.push({
                        type: 'tag',
                        label: tag,
                        value: tag,
                        count: this.tagIndex.get(tag)?.size ?? 0
                    })
                }
            }
        }

        // Suggest property fields
        const seenFields = new Set<string>()
        for (const entityType of context.schema.entityTypes) {
            for (const field of entityType.fields) {
                if (!seenFields.has(field.id) && field.name.toLowerCase().includes(query)) {
                    seenFields.add(field.id)
                    suggestions.push({
                        type: 'property',
                        label: field.name,
                        value: field.id
                    })
                }
            }
        }

        return suggestions.slice(0, 10)
    }

    /**
     * Returns all available filter options from schema
     */
    getAvailableFilters(schema: WorkspaceSchema): AvailableFilters {
        const entityTypes = schema.entityTypes.map(et => ({
            id: et.id,
            name: et.name,
            icon: et.visual.icon,
            color: et.visual.color
        }))

        const edgeTypes = schema.relationshipTypes.map(rt => ({
            id: rt.id,
            name: rt.name
        }))

        // Collect all property fields
        const propertyFieldsMap = new Map<string, { field: string; type: string; entityTypes: string[] }>()
        for (const entityType of schema.entityTypes) {
            for (const field of entityType.fields) {
                if (propertyFieldsMap.has(field.id)) {
                    propertyFieldsMap.get(field.id)!.entityTypes.push(entityType.id)
                } else {
                    propertyFieldsMap.set(field.id, {
                        field: field.id,
                        type: field.type,
                        entityTypes: [entityType.id]
                    })
                }
            }
        }

        return {
            entityTypes,
            edgeTypes,
            propertyFields: Array.from(propertyFieldsMap.values()),
            tags: Array.from(this.tagIndex.keys())
        }
    }

    // ============================================
    // Private Matching Methods
    // ============================================

    private matchesTextFilter(text: string, filter: TextFilter): boolean {
        const compareText = filter.caseSensitive ? text : text.toLowerCase()
        const compareValue = filter.caseSensitive ? filter.text : filter.text.toLowerCase()

        switch (filter.operator) {
            case 'contains': return compareText.includes(compareValue)
            case 'startsWith': return compareText.startsWith(compareValue)
            case 'endsWith': return compareText.endsWith(compareValue)
            case 'equals': return compareText === compareValue
            default: return true
        }
    }

    private matchesTagFilter(entityTags: string[], filter: TagFilter): boolean {
        if (filter.tags.length === 0) return true

        switch (filter.mode) {
            case 'any':
                return filter.tags.some(tag => entityTags.includes(tag))
            case 'all':
                return filter.tags.every(tag => entityTags.includes(tag))
            case 'none':
                return !filter.tags.some(tag => entityTags.includes(tag))
            default:
                return true
        }
    }

    private matchesPropertyFilter(entity: EntityInstance, filter: PropertyFilter): boolean {
        const value = entity.data[filter.field]

        switch (filter.operator) {
            case 'exists':
                return value !== undefined && value !== null
            case 'notExists':
                return value === undefined || value === null
            case 'equals':
                return value === filter.value
            case 'contains':
                return String(value || '').toLowerCase().includes(String(filter.value).toLowerCase())
            case 'startsWith':
                return String(value || '').toLowerCase().startsWith(String(filter.value).toLowerCase())
            case 'endsWith':
                return String(value || '').toLowerCase().endsWith(String(filter.value).toLowerCase())
            case 'gt':
                return typeof value === 'number' && value > (filter.value as number)
            case 'lt':
                return typeof value === 'number' && value < (filter.value as number)
            case 'in':
                return Array.isArray(filter.value) && filter.value.includes(value)
            case 'notIn':
                return Array.isArray(filter.value) && !filter.value.includes(value)
            default:
                return true
        }
    }

    private matchesTextSearch(entity: EntityInstance, searchText: string): boolean {
        const search = searchText.toLowerCase()

        // Search in name
        const name = String(entity.data.name || '').toLowerCase()
        if (name.includes(search)) return true

        // Search in description
        const description = String(entity.data.description || '').toLowerCase()
        if (description.includes(search)) return true

        // Search in tags
        const tags = (entity.data.tags as string[]) || []
        if (tags.some(tag => tag.toLowerCase().includes(search))) return true

        // Search in ID
        if (entity.id.toLowerCase().includes(search)) return true

        return false
    }
}

// Export singleton instance
export const filterEngine = new FilterEngineImpl()

// Export class for testing
export { FilterEngineImpl }
