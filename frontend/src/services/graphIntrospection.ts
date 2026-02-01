/**
 * Graph Introspection Service - Generic graph analysis
 * 
 * Works with ANY graph structure to discover:
 * - All entity types present
 * - All edge types present
 * - All unique tags
 * - All property keys per entity type
 * 
 * API-Ready: This service can be swapped for backend calls
 */

import type { EntityInstance, RelationshipInstance, WorkspaceSchema } from '@/types/schema'

// ============================================
// Types
// ============================================

export interface EntityTypeSummary {
    id: string
    name: string
    count: number
    icon: string
    color: string
    sampleNames: string[]
}

export interface EdgeTypeSummary {
    id: string
    name: string
    count: number
    sourceTypes: string[]
    targetTypes: string[]
}

export interface PropertyKeySummary {
    key: string
    type: string
    sampleValues: unknown[]
    uniqueValueCount: number
    entityTypes: string[]
}

export interface TagSummary {
    tag: string
    count: number
    entityTypes: string[]
}

export interface GraphStats {
    totalEntities: number
    totalEdges: number
    entityTypeCount: number
    edgeTypeCount: number
    uniqueTagCount: number
    maxDepth: number
}

// ============================================
// Graph Introspection Implementation
// ============================================

class GraphIntrospectionImpl {
    private entities: EntityInstance[] = []
    private edges: RelationshipInstance[] = []
    private schema: WorkspaceSchema | null = null

    // Cached analysis results
    private entityTypeSummaries: EntityTypeSummary[] = []
    private edgeTypeSummaries: EdgeTypeSummary[] = []
    private tagSummaries: TagSummary[] = []
    private propertyKeySummaries: Map<string, PropertyKeySummary[]> = new Map()
    private isDirty = true

    /**
     * Set the current graph data for introspection
     */
    setData(entities: EntityInstance[], edges: RelationshipInstance[], schema: WorkspaceSchema): void {
        this.entities = entities
        this.edges = edges
        this.schema = schema
        this.isDirty = true
    }

    /**
     * Get all entity types present in the graph with counts and samples
     */
    getEntityTypes(): EntityTypeSummary[] {
        this.ensureAnalyzed()
        return this.entityTypeSummaries
    }

    /**
     * Get all edge types present in the graph with counts
     */
    getEdgeTypes(): EdgeTypeSummary[] {
        this.ensureAnalyzed()
        return this.edgeTypeSummaries
    }

    /**
     * Get all property keys available for a specific entity type (or all)
     */
    getPropertyKeys(entityType?: string): PropertyKeySummary[] {
        this.ensureAnalyzed()

        if (entityType) {
            return this.propertyKeySummaries.get(entityType) ?? []
        }

        // Merge all property keys
        const merged = new Map<string, PropertyKeySummary>()
        for (const [type, summaries] of this.propertyKeySummaries) {
            for (const summary of summaries) {
                if (merged.has(summary.key)) {
                    const existing = merged.get(summary.key)!
                    existing.entityTypes.push(type)
                    existing.uniqueValueCount += summary.uniqueValueCount
                } else {
                    merged.set(summary.key, { ...summary, entityTypes: [type] })
                }
            }
        }
        return Array.from(merged.values())
    }

    /**
     * Get all unique tags in the graph
     */
    getAllTags(): TagSummary[] {
        this.ensureAnalyzed()
        return this.tagSummaries
    }

    /**
     * Get graph statistics
     */
    getGraphStats(): GraphStats {
        this.ensureAnalyzed()
        return {
            totalEntities: this.entities.length,
            totalEdges: this.edges.length,
            entityTypeCount: this.entityTypeSummaries.length,
            edgeTypeCount: this.edgeTypeSummaries.length,
            uniqueTagCount: this.tagSummaries.length,
            maxDepth: this.calculateMaxDepth()
        }
    }

    // ============================================
    // Private Analysis Methods
    // ============================================

    private ensureAnalyzed(): void {
        if (!this.isDirty) return

        this.analyzeEntityTypes()
        this.analyzeEdgeTypes()
        this.analyzeTags()
        this.analyzePropertyKeys()

        this.isDirty = false
    }

    private analyzeEntityTypes(): void {
        const typeMap = new Map<string, { count: number; samples: string[] }>()

        for (const entity of this.entities) {
            const existing = typeMap.get(entity.typeId)
            if (existing) {
                existing.count++
                if (existing.samples.length < 3) {
                    const name = String(entity.data.name || entity.id)
                    existing.samples.push(name)
                }
            } else {
                typeMap.set(entity.typeId, {
                    count: 1,
                    samples: [String(entity.data.name || entity.id)]
                })
            }
        }

        this.entityTypeSummaries = Array.from(typeMap.entries()).map(([typeId, data]) => {
            const schemaType = this.schema?.entityTypes.find(et => et.id === typeId)
            return {
                id: typeId,
                name: schemaType?.name ?? typeId,
                count: data.count,
                icon: schemaType?.visual.icon ?? 'Box',
                color: schemaType?.visual.color ?? '#6366f1',
                sampleNames: data.samples
            }
        }).sort((a, b) => b.count - a.count)
    }

    private analyzeEdgeTypes(): void {
        const typeMap = new Map<string, { count: number; sourceTypes: Set<string>; targetTypes: Set<string> }>()

        for (const edge of this.edges) {
            const existing = typeMap.get(edge.typeId)
            const sourceEntity = this.entities.find(e => e.id === edge.sourceId)
            const targetEntity = this.entities.find(e => e.id === edge.targetId)

            if (existing) {
                existing.count++
                if (sourceEntity) existing.sourceTypes.add(sourceEntity.typeId)
                if (targetEntity) existing.targetTypes.add(targetEntity.typeId)
            } else {
                typeMap.set(edge.typeId, {
                    count: 1,
                    sourceTypes: new Set(sourceEntity ? [sourceEntity.typeId] : []),
                    targetTypes: new Set(targetEntity ? [targetEntity.typeId] : [])
                })
            }
        }

        this.edgeTypeSummaries = Array.from(typeMap.entries()).map(([typeId, data]) => {
            const schemaType = this.schema?.relationshipTypes.find(rt => rt.id === typeId)
            return {
                id: typeId,
                name: schemaType?.name ?? typeId,
                count: data.count,
                sourceTypes: Array.from(data.sourceTypes),
                targetTypes: Array.from(data.targetTypes)
            }
        }).sort((a, b) => b.count - a.count)
    }

    private analyzeTags(): void {
        const tagMap = new Map<string, { count: number; entityTypes: Set<string> }>()

        for (const entity of this.entities) {
            const tags = entity.data.tags as string[] | undefined
            if (!tags) continue

            for (const tag of tags) {
                const existing = tagMap.get(tag)
                if (existing) {
                    existing.count++
                    existing.entityTypes.add(entity.typeId)
                } else {
                    tagMap.set(tag, { count: 1, entityTypes: new Set([entity.typeId]) })
                }
            }
        }

        this.tagSummaries = Array.from(tagMap.entries()).map(([tag, data]) => ({
            tag,
            count: data.count,
            entityTypes: Array.from(data.entityTypes)
        })).sort((a, b) => b.count - a.count)
    }

    private analyzePropertyKeys(): void {
        this.propertyKeySummaries.clear()

        // Group entities by type
        const byType = new Map<string, EntityInstance[]>()
        for (const entity of this.entities) {
            if (!byType.has(entity.typeId)) {
                byType.set(entity.typeId, [])
            }
            byType.get(entity.typeId)!.push(entity)
        }

        // Analyze each type's properties
        for (const [typeId, typeEntities] of byType) {
            const propertyMap = new Map<string, { values: Set<unknown>; type: string }>()

            for (const entity of typeEntities) {
                for (const [key, value] of Object.entries(entity.data)) {
                    if (value === undefined || value === null) continue

                    const existing = propertyMap.get(key)
                    if (existing) {
                        if (existing.values.size < 5) existing.values.add(value)
                    } else {
                        propertyMap.set(key, {
                            values: new Set([value]),
                            type: typeof value
                        })
                    }
                }
            }

            const summaries: PropertyKeySummary[] = Array.from(propertyMap.entries()).map(([key, data]) => ({
                key,
                type: data.type,
                sampleValues: Array.from(data.values).slice(0, 3),
                uniqueValueCount: data.values.size,
                entityTypes: [typeId]
            }))

            this.propertyKeySummaries.set(typeId, summaries)
        }
    }

    private calculateMaxDepth(): number {
        // Simple BFS to find max depth in the entity hierarchy
        const visited = new Set<string>()
        let maxDepth = 0

        const queue: { id: string; depth: number }[] = []

        // Start from root entities
        for (const entity of this.entities) {
            if (!entity.parentId) {
                queue.push({ id: entity.id, depth: 0 })
            }
        }

        while (queue.length > 0) {
            const { id, depth } = queue.shift()!
            if (visited.has(id)) continue
            visited.add(id)

            maxDepth = Math.max(maxDepth, depth)

            // Find children
            for (const entity of this.entities) {
                if (entity.parentId === id && !visited.has(entity.id)) {
                    queue.push({ id: entity.id, depth: depth + 1 })
                }
            }
        }

        return maxDepth
    }
}

// Export singleton instance
export const graphIntrospection = new GraphIntrospectionImpl()

// Export class for testing
export { GraphIntrospectionImpl }
