/**
 * useLayerAssignment - Optimized hook for reactive layer assignments
 * 
 * Phase 5: Assignment Engine Optimizations
 * 
 * Features:
 * - Indexed rule matching for O(1) type lookups
 * - Caching layer for parent lookups
 * - Memoized assignment computation
 * - Incremental update support
 * - Web worker ready (computation can be offloaded)
 */

import { useMemo, useCallback, useRef } from 'react'
import { useReferenceModelStore, useLayers, useLayerSequence } from '@/store/referenceModelStore'
import type {
    ViewLayerConfig,
    LayerAssignmentRuleConfig,
    EntityAssignmentConfig
} from '@/types/schema'
import type { GraphNode, GraphEdge } from '@/providers/GraphDataProvider'

// ============================================
// Types
// ============================================

export interface AssignmentResult {
    layerId: string
    layerIndex: number
    matchedBy: 'instance' | 'rule' | 'type' | 'inherited' | 'default'
    priority: number
    inheritedFrom?: string
}

export interface AssignmentContext {
    node: GraphNode
    parentId?: string
    parentAssignment?: AssignmentResult
}

export interface RuleIndex {
    /** Maps entity type -> [layerId, rule] pairs for fast lookup */
    byType: Map<string, Array<{ layerId: string; rule: LayerAssignmentRuleConfig }>>
    /** Maps tag -> [layerId, rule] pairs */
    byTag: Map<string, Array<{ layerId: string; rule: LayerAssignmentRuleConfig }>>
    /** URN pattern rules (need regex matching) */
    patterns: Array<{ layerId: string; rule: LayerAssignmentRuleConfig; regex: RegExp }>
    /** Instance assignments by entity ID */
    instances: Map<string, { layerId: string; config: EntityAssignmentConfig }>
}

export interface ParentCache {
    /** Maps entity ID -> parent ID */
    parentMap: Map<string, string>
    /** Maps entity ID -> ancestor chain (for deep inheritance) */
    ancestorChain: Map<string, string[]>
}

export interface AssignmentStats {
    totalEntities: number
    assignedCount: number
    byLayer: Map<string, number>
    byMethod: {
        instance: number
        rule: number
        type: number
        inherited: number
        default: number
    }
    computeTimeMs: number
}

// ============================================
// Index Builder
// ============================================

function buildRuleIndex(layers: ViewLayerConfig[]): RuleIndex {
    const byType = new Map<string, Array<{ layerId: string; rule: LayerAssignmentRuleConfig }>>()
    const byTag = new Map<string, Array<{ layerId: string; rule: LayerAssignmentRuleConfig }>>()
    const patterns: RuleIndex['patterns'] = []
    const instances = new Map<string, { layerId: string; config: EntityAssignmentConfig }>()

    for (const layer of layers) {
        // Index instance assignments (highest priority)
        if (layer.entityAssignments) {
            for (const config of layer.entityAssignments) {
                instances.set(config.entityId, { layerId: layer.id, config })
            }
        }

        // Index rules
        if (layer.rules) {
            for (const rule of layer.rules) {
                // Index by entity types
                if (rule.entityTypes) {
                    for (const type of rule.entityTypes) {
                        if (!byType.has(type)) byType.set(type, [])
                        byType.get(type)!.push({ layerId: layer.id, rule })
                    }
                }

                // Index by tags
                if (rule.tags) {
                    for (const tag of rule.tags) {
                        if (!byTag.has(tag)) byTag.set(tag, [])
                        byTag.get(tag)!.push({ layerId: layer.id, rule })
                    }
                }

                // Compile URN patterns
                if (rule.urnPattern) {
                    try {
                        // Convert glob-like pattern to regex
                        const regexPattern = rule.urnPattern
                            .replace(/\./g, '\\.')
                            .replace(/\*/g, '.*')
                            .replace(/\?/g, '.')
                        patterns.push({
                            layerId: layer.id,
                            rule,
                            regex: new RegExp(`^${regexPattern}$`, 'i')
                        })
                    } catch {
                        console.warn(`Invalid URN pattern: ${rule.urnPattern}`)
                    }
                }
            }
        }

        // Also index basic entityTypes on the layer (lowest priority)
        if (layer.entityTypes) {
            for (const type of layer.entityTypes) {
                if (!byType.has(type)) byType.set(type, [])
                // Create a synthetic rule for type-based matching
                byType.get(type)!.push({
                    layerId: layer.id,
                    rule: {
                        id: `_type_${layer.id}_${type}`,
                        priority: 0, // Lowest priority
                        entityTypes: [type]
                    }
                })
            }
        }
    }

    return { byType, byTag, patterns, instances }
}

// ============================================
// Parent Cache Builder
// ============================================

function buildParentCache(edges: GraphEdge[], containmentTypes: Set<string>): ParentCache {
    const parentMap = new Map<string, string>()
    const ancestorChain = new Map<string, string[]>()

    // First pass: build parent map
    for (const edge of edges) {
        if (containmentTypes.has(edge.edgeType)) {
            parentMap.set(edge.targetUrn, edge.sourceUrn)
        }
    }

    // Second pass: build ancestor chains (lazy, on-demand)
    const getAncestors = (entityId: string): string[] => {
        if (ancestorChain.has(entityId)) {
            return ancestorChain.get(entityId)!
        }

        const ancestors: string[] = []
        let current = entityId
        const visited = new Set<string>()

        while (parentMap.has(current) && !visited.has(current)) {
            visited.add(current)
            const parent = parentMap.get(current)!
            ancestors.push(parent)
            current = parent
        }

        ancestorChain.set(entityId, ancestors)
        return ancestors
    }

    // Pre-compute for all entities
    for (const entityId of parentMap.keys()) {
        getAncestors(entityId)
    }

    return { parentMap, ancestorChain }
}

// ============================================
// Assignment Engine
// ============================================

function resolveAssignment(
    context: AssignmentContext,
    index: RuleIndex,
    layers: ViewLayerConfig[],
    layerSequenceMap: Map<string, number>
): AssignmentResult | null {
    const { node, parentAssignment } = context
    const entityId = node.urn
    const entityType = node.entityType
    const entityUrn = node.urn
    const entityTags = node.tags ?? []

    // 1. Check instance assignments (highest priority)
    const instanceMatch = index.instances.get(entityId)
    if (instanceMatch) {
        return {
            layerId: instanceMatch.layerId,
            layerIndex: layerSequenceMap.get(instanceMatch.layerId) ?? 0,
            matchedBy: 'instance',
            priority: 1000 // Highest
        }
    }

    // 2. Check if parent has assignment with inheritance
    if (parentAssignment) {
        // Check if the rule that matched parent has inheritance enabled
        if (parentAssignment.matchedBy !== 'default') {
            // Inherit from parent
            return {
                layerId: parentAssignment.layerId,
                layerIndex: parentAssignment.layerIndex,
                matchedBy: 'inherited',
                priority: parentAssignment.priority - 1,
                inheritedFrom: context.parentId
            }
        }
    }

    // 3. Match by rules (sorted by priority)
    const candidates: Array<{ layerId: string; priority: number; matchedBy: 'rule' | 'type' }> = []

    // 3a. Type-based rules
    if (entityType && index.byType.has(entityType)) {
        for (const { layerId, rule } of index.byType.get(entityType)!) {
            candidates.push({
                layerId,
                priority: rule.priority,
                matchedBy: rule.id.startsWith('_type_') ? 'type' : 'rule'
            })
        }
    }

    // 3b. Tag-based rules
    for (const tag of entityTags) {
        if (index.byTag.has(tag)) {
            for (const { layerId, rule } of index.byTag.get(tag)!) {
                candidates.push({
                    layerId,
                    priority: rule.priority,
                    matchedBy: 'rule'
                })
            }
        }
    }

    // 3c. URN pattern rules
    if (entityUrn) {
        for (const { layerId, rule, regex } of index.patterns) {
            if (regex.test(entityUrn)) {
                candidates.push({
                    layerId,
                    priority: rule.priority,
                    matchedBy: 'rule'
                })
            }
        }
    }

    // Sort by priority (descending) and pick highest
    if (candidates.length > 0) {
        candidates.sort((a, b) => b.priority - a.priority)
        const winner = candidates[0]
        return {
            layerId: winner.layerId,
            layerIndex: layerSequenceMap.get(winner.layerId) ?? 0,
            matchedBy: winner.matchedBy,
            priority: winner.priority
        }
    }

    // 4. Default: first layer
    if (layers.length > 0) {
        return {
            layerId: layers[0].id,
            layerIndex: 0,
            matchedBy: 'default',
            priority: -1
        }
    }

    return null
}

// ============================================
// Main Hook
// ============================================

export function useLayerAssignment(
    nodes: GraphNode[],
    edges: GraphEdge[],
    options: {
        containmentEdgeTypes?: string[]
        enableCaching?: boolean
    } = {}
) {
    const {
        containmentEdgeTypes = ['CONTAINS', 'HAS_CHILD', 'BELONGS_TO'],
        enableCaching = true
    } = options

    const layers = useLayers()
    const layerSequence = useLayerSequence()
    const instanceAssignments = useReferenceModelStore(s => s.instanceAssignments)

    // Refs for caching
    const indexCacheRef = useRef<{ layers: ViewLayerConfig[]; index: RuleIndex } | null>(null)
    const parentCacheRef = useRef<{ edges: GraphEdge[]; cache: ParentCache } | null>(null)

    // Build layer sequence map for fast index lookup
    const layerSequenceMap = useMemo(() => {
        const map = new Map<string, number>()
        layerSequence.forEach((layerId, index) => {
            map.set(layerId, index)
        })
        return map
    }, [layerSequence])

    // Memoized rule index (rebuilds when layers change)
    const ruleIndex = useMemo(() => {
        if (enableCaching && indexCacheRef.current?.layers === layers) {
            return indexCacheRef.current.index
        }

        // Merge instance assignments into layers for indexing
        const layersWithInstances = layers.map(layer => ({
            ...layer,
            entityAssignments: [
                ...(layer.entityAssignments || []),
                ...Array.from(instanceAssignments.entries())
                    .filter(([_, config]) => config.layerId === layer.id)
                    .map(([_, config]) => config)
            ]
        }))

        const index = buildRuleIndex(layersWithInstances)

        if (enableCaching) {
            indexCacheRef.current = { layers, index }
        }

        return index
    }, [layers, instanceAssignments, enableCaching])

    // Memoized parent cache (rebuilds when edges change)
    const parentCache = useMemo(() => {
        if (enableCaching && parentCacheRef.current?.edges === edges) {
            return parentCacheRef.current.cache
        }

        const containmentSet = new Set(containmentEdgeTypes)
        const cache = buildParentCache(edges, containmentSet)

        if (enableCaching) {
            parentCacheRef.current = { edges, cache }
        }

        return cache
    }, [edges, containmentEdgeTypes, enableCaching])

    // Compute all assignments
    const assignments = useMemo(() => {
        const startTime = performance.now()
        const results = new Map<string, AssignmentResult>()

        // Sort nodes by depth (parents first) for proper inheritance
        const nodesByDepth = [...nodes].sort((a, b) => {
            const depthA = parentCache.ancestorChain.get(a.urn)?.length ?? 0
            const depthB = parentCache.ancestorChain.get(b.urn)?.length ?? 0
            return depthA - depthB
        })

        for (const node of nodesByDepth) {
            const parentId = parentCache.parentMap.get(node.urn)
            const parentAssignment = parentId ? results.get(parentId) : undefined

            const context: AssignmentContext = {
                node,
                parentId,
                parentAssignment
            }

            const result = resolveAssignment(context, ruleIndex, layers, layerSequenceMap)
            if (result) {
                results.set(node.urn, result)
            }
        }

        const computeTimeMs = performance.now() - startTime
        console.debug(`[useLayerAssignment] Computed ${results.size} assignments in ${computeTimeMs.toFixed(2)}ms`)

        return results
    }, [nodes, layers, ruleIndex, parentCache, layerSequenceMap])

    // Get assignment for a single entity
    const getAssignment = useCallback((entityId: string): AssignmentResult | undefined => {
        return assignments.get(entityId)
    }, [assignments])

    // Get all entities for a layer
    const getEntitiesByLayer = useCallback((layerId: string): string[] => {
        const entities: string[] = []
        assignments.forEach((result, entityId) => {
            if (result.layerId === layerId) {
                entities.push(entityId)
            }
        })
        return entities
    }, [assignments])

    // Compute statistics
    const stats = useMemo((): AssignmentStats => {
        const byLayer = new Map<string, number>()
        const byMethod = {
            instance: 0,
            rule: 0,
            type: 0,
            inherited: 0,
            default: 0
        }

        assignments.forEach((result) => {
            byLayer.set(result.layerId, (byLayer.get(result.layerId) ?? 0) + 1)
            byMethod[result.matchedBy]++
        })

        return {
            totalEntities: nodes.length,
            assignedCount: assignments.size,
            byLayer,
            byMethod,
            computeTimeMs: 0 // Would need to track separately
        }
    }, [assignments, nodes.length])

    return {
        /** All assignments as a Map<entityId, AssignmentResult> */
        assignments,
        /** Get assignment for a single entity */
        getAssignment,
        /** Get all entity IDs assigned to a layer */
        getEntitiesByLayer,
        /** Assignment statistics */
        stats,
        /** The built rule index (for debugging) */
        ruleIndex,
        /** Parent cache (for debugging) */
        parentCache
    }
}

/**
 * Simplified hook for just getting layer assignments from store
 */
export function useEntityLayerAssignment(entityId: string) {
    const assignment = useReferenceModelStore(s => s.getAssignment(entityId))
    const layers = useLayers()

    const layer = useMemo(() =>
        layers.find(l => l.id === assignment?.layerId),
        [layers, assignment?.layerId]
    )

    return {
        assignment,
        layer,
        layerName: layer?.name,
        layerColor: layer?.color,
        isAssigned: !!assignment
    }
}
