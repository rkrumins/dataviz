/**
 * Reference Model Store - SINGLE SOURCE OF TRUTH for layer assignments
 * 
 * Architecture:
 * 1. Canvas populates parentMap from containment edges
 * 2. Store receives assignments from backend (or computes locally)
 * 3. Canvas reads effectiveAssignments for rendering
 * 4. All assignment changes go through store validation
 * 
 * Features:
 * - Backend-ready assignment computation (FalkorDB)
 * - Inheritance enforcement (parent takes precedence)
 * - Edge preservation for lineage visualization
 * - Lazy loading support
 */

import { create } from 'zustand'
import { generateId } from '@/lib/utils'
import type { ViewLayerConfig, ScopeFilterConfig, EntityAssignmentConfig, AssignmentConflict, ScopeEdgeConfig } from '@/types/schema'
import type {
    GraphEdge,
    EntityAssignment,
    LayerAssignmentResult,
    LayerAssignmentRequest,
    GraphDataProvider
} from '@/providers/GraphDataProvider'

// ============================================
// Types
// ============================================

type LayerChangeType = 'add' | 'remove' | 'update' | 'reorder'

interface LayerChangeEvent {
    type: LayerChangeType
    layerId?: string
    layers: ViewLayerConfig[]
    prevLayers?: ViewLayerConfig[]
}

type LayerChangeCallback = (event: LayerChangeEvent) => void
type UnsubscribeFn = () => void

/** Pending assignment request (for async backend calls) */
type AssignmentStatus = 'idle' | 'loading' | 'success' | 'error'

// ============================================
// Store State
// ============================================

interface ReferenceModelState {
    // ===== Layer Configuration =====
    layers: ViewLayerConfig[]
    layerSequence: string[] // Ordered layer IDs (left-to-right)

    // ===== Scope Filter =====
    scopeFilter: ScopeFilterConfig | null

    // ===== Assignments (SINGLE SOURCE OF TRUTH) =====
    /** All entity assignments - canvas reads only from here */
    effectiveAssignments: Map<string, EntityAssignment>

    /** Parent-child relationships (from containment edges) */
    parentMap: Map<string, string>  // childId -> parentId

    /** Preserved edges for lineage visualization */
    preservedEdges: GraphEdge[]

    /** Unassigned entity IDs (didn't match any rule) */
    unassignedEntityIds: string[]

    // ===== Loading State =====
    assignmentStatus: AssignmentStatus
    lastError: string | null
    lastComputeTimeMs: number

    // ===== Expanded Nodes (for lazy loading) =====
    expandedNodeIds: Set<string>

    // ===== Instance-Level Assignments (NEW) =====
    /** Direct entity-to-layer assignments (overrides rule-based) */
    instanceAssignments: Map<string, EntityAssignmentConfig>

    /** Detected assignment conflicts */
    assignmentConflicts: AssignmentConflict[]

    /** Current scope edge configuration */
    scopeEdgeConfig: ScopeEdgeConfig | null

    // ===== Subscription Management =====
    _subscribers: Set<LayerChangeCallback>

    // ===== Layer Actions =====
    setLayers: (layers: ViewLayerConfig[]) => void
    addLayer: (layer: Omit<ViewLayerConfig, 'id' | 'order'>) => string
    removeLayer: (id: string) => void
    updateLayer: (id: string, updates: Partial<ViewLayerConfig>) => void
    reorderLayers: (newSequence: string[]) => void

    // ===== Assignment Actions (NEW - Backend Ready) =====
    /** Set assignments from backend/provider computation */
    setAssignmentResult: (result: LayerAssignmentResult) => void

    /** Set parent map from containment edges */
    setParentMap: (map: Map<string, string>) => void

    /** Set preserved edges for lineage */
    setPreservedEdges: (edges: GraphEdge[]) => void

    /** Mark assignment computation as loading */
    setAssignmentLoading: () => void

    /** Mark assignment computation as error */
    setAssignmentError: (error: string) => void

    /** Trigger backend assignment computation */
    computeAssignments: (provider: GraphDataProvider) => Promise<void>

    // ===== Lazy Loading =====
    toggleNodeExpanded: (nodeId: string) => void
    isNodeExpanded: (nodeId: string) => boolean

    // ===== Query Helpers =====
    getAssignment: (entityId: string) => EntityAssignment | undefined
    getAssignmentsByLayer: (layerId: string) => EntityAssignment[]
    getAssignmentsByLogicalNode: (layerId: string, logicalNodeId: string) => EntityAssignment[]
    getInheritedFrom: (entityId: string) => EntityAssignment | null

    // ===== Scope Filter =====
    setScopeFilter: (filter: ScopeFilterConfig | null) => void

    // ===== Observer Pattern =====
    onLayerChange: (callback: LayerChangeCallback) => UnsubscribeFn

    // ===== Layout Helpers =====
    getLayerBySequence: (index: number) => ViewLayerConfig | undefined
    calculateLayerX: (layerId: string, config?: { margin?: number; width?: number; gap?: number }) => number

    // ===== Build Assignment Request =====
    buildAssignmentRequest: () => LayerAssignmentRequest

    // ===== Instance Assignment Actions (NEW) =====
    /** Assign a specific entity to a layer (with conflict detection) */
    assignEntityToLayer: (entityId: string, layerId: string, options?: {
        logicalNodeId?: string
        inheritsChildren?: boolean
    }) => { success: boolean; conflict?: AssignmentConflict }

    /** Remove an instance assignment */
    removeEntityAssignment: (entityId: string) => void

    /** Check if assigning an entity would cause a conflict */
    checkAssignmentConflict: (entityId: string, layerId: string) => AssignmentConflict | null

    /** Get all instance assignments */
    getInstanceAssignments: () => Map<string, EntityAssignmentConfig>

    /** Clear all conflicts */
    clearConflicts: () => void

    /** Set scope edge configuration */
    setScopeEdgeConfig: (config: ScopeEdgeConfig | null) => void

    /** Bulk assign multiple entities to a layer */
    bulkAssignEntitiesToLayer: (
        entityIds: string[],
        layerId: string,
        options?: { inheritsChildren?: boolean }
    ) => { successful: string[]; conflicts: AssignmentConflict[] }

    /** Clear all manual assignments and conflicts */
    clearAssignments: () => void
}

// ============================================
// Store Implementation
// ============================================

const DEFAULT_LAYOUT = {
    margin: 24,
    width: 280,
    gap: 16
}

import { persist, createJSONStorage } from 'zustand/middleware'

export const useReferenceModelStore = create<ReferenceModelState>()(
    persist(
        (set, get) => ({
            // ===== Initial State =====
            layers: [],
            layerSequence: [],
            scopeFilter: null,
            effectiveAssignments: new Map(),
            parentMap: new Map(),
            preservedEdges: [],
            unassignedEntityIds: [],
            assignmentStatus: 'idle',
            lastError: null,
            lastComputeTimeMs: 0,
            expandedNodeIds: new Set(),
            instanceAssignments: new Map(),
            assignmentConflicts: [],
            scopeEdgeConfig: null,
            _subscribers: new Set(),

            setLayers: (layers) => {
                const state = get()
                const prevLayers = state.layers
                const sequence = layers
                    .sort((a, b) => (a.sequence ?? a.order) - (b.sequence ?? b.order))
                    .map(l => l.id)

                // Sync instanceAssignments map from layers
                const newInstanceMap = new Map<string, EntityAssignmentConfig>()
                layers.forEach(layer => {
                    layer.entityAssignments?.forEach(assignment => {
                        newInstanceMap.set(assignment.entityId, assignment)
                    })
                })

                set({
                    layers,
                    layerSequence: sequence,
                    instanceAssignments: newInstanceMap
                })

                // Notify subscribers
                state._subscribers.forEach(cb => cb({
                    type: 'update',
                    layers,
                    prevLayers
                }))
            },

            addLayer: (layerData) => {
                const state = get()
                const id = generateId('layer')
                const order = state.layers.length

                const newLayer: ViewLayerConfig = {
                    ...layerData,
                    id,
                    order,
                    sequence: order,
                    entityTypes: layerData.entityTypes || []
                }

                const layers = [...state.layers, newLayer]
                const layerSequence = [...state.layerSequence, id]

                set({ layers, layerSequence })

                // Notify subscribers
                state._subscribers.forEach(cb => cb({
                    type: 'add',
                    layerId: id,
                    layers,
                    prevLayers: state.layers
                }))

                return id
            },

            removeLayer: (id, _moveToInbox = true) => {
                const state = get()
                const layerToRemove = state.layers.find(l => l.id === id)

                if (!layerToRemove) return

                // Collect URNs of nodes assigned to this layer (for inbox)
                // Note: Actual URN collection requires integration with canvas state
                // For now, we just remove the layer

                const layers = state.layers
                    .filter(l => l.id !== id)
                    .map((l, idx) => ({ ...l, order: idx, sequence: idx }))

                const layerSequence = state.layerSequence.filter(lid => lid !== id)

                set({ layers, layerSequence })

                // Notify subscribers
                state._subscribers.forEach(cb => cb({
                    type: 'remove',
                    layerId: id,
                    layers,
                    prevLayers: state.layers
                }))
            },

            updateLayer: (id, updates) => {
                const state = get()
                const layers = state.layers.map(l =>
                    l.id === id ? { ...l, ...updates } : l
                )

                set({ layers })

                // Notify subscribers
                state._subscribers.forEach(cb => cb({
                    type: 'update',
                    layerId: id,
                    layers,
                    prevLayers: state.layers
                }))
            },

            reorderLayers: (newSequence) => {
                const state = get()

                // Rebuild layers with new sequence/order
                const layerMap = new Map(state.layers.map(l => [l.id, l]))
                const layers = newSequence
                    .filter(id => layerMap.has(id))
                    .map((id, idx) => ({
                        ...layerMap.get(id)!,
                        order: idx,
                        sequence: idx
                    }))

                set({ layers, layerSequence: newSequence })

                // Notify subscribers
                state._subscribers.forEach(cb => cb({
                    type: 'reorder',
                    layers,
                    prevLayers: state.layers
                }))
            },

            // ===== Scope Filter =====
            setScopeFilter: (filter) => {
                set({ scopeFilter: filter })
            },

            // ===== Assignment Actions (Backend-Ready) =====

            setAssignmentResult: (result) => {
                // Ensure assignments and parentMap are Maps (RemoteProvider returns JSON objects)
                const assignments = result.assignments instanceof Map
                    ? result.assignments
                    : new Map(Object.entries(result.assignments || {}))

                const parentMap = result.parentMap instanceof Map
                    ? result.parentMap
                    : new Map(Object.entries(result.parentMap || {}))

                set({
                    effectiveAssignments: assignments as Map<string, EntityAssignment>,
                    parentMap: parentMap as Map<string, string>,
                    preservedEdges: result.edges,
                    unassignedEntityIds: result.unassignedEntityIds,
                    assignmentStatus: 'success',
                    lastError: null,
                    lastComputeTimeMs: result.stats.computeTimeMs
                })
            },

            setParentMap: (map) => {
                set({ parentMap: map })
            },

            setPreservedEdges: (edges) => {
                set({ preservedEdges: edges })
            },

            setAssignmentLoading: () => {
                set({ assignmentStatus: 'loading', lastError: null })
            },

            setAssignmentError: (error) => {
                set({ assignmentStatus: 'error', lastError: error })
            },

            computeAssignments: async (provider) => {
                const state = get()
                set({ assignmentStatus: 'loading', lastError: null })

                try {
                    const request = state.buildAssignmentRequest()
                    const result = await provider.computeLayerAssignments(request)

                    state.setAssignmentResult(result) // Using existing setter to update state
                } catch (error) {
                    console.error("Assignment computation failed", error)
                    set({
                        assignmentStatus: 'error',
                        lastError: error instanceof Error ? error.message : String(error)
                    })
                }
            },

            // ===== Lazy Loading =====

            toggleNodeExpanded: (nodeId) => {
                const state = get()
                const newExpanded = new Set(state.expandedNodeIds)
                if (newExpanded.has(nodeId)) {
                    newExpanded.delete(nodeId)
                } else {
                    newExpanded.add(nodeId)
                }
                set({ expandedNodeIds: newExpanded })
            },

            isNodeExpanded: (nodeId) => {
                return get().expandedNodeIds.has(nodeId)
            },

            // ===== Query Helpers =====

            getAssignment: (entityId) => {
                return get().effectiveAssignments.get(entityId)
            },

            getAssignmentsByLayer: (layerId) => {
                const state = get()
                const result: EntityAssignment[] = []
                state.effectiveAssignments.forEach((assignment) => {
                    if (assignment.layerId === layerId) {
                        result.push(assignment)
                    }
                })
                return result
            },

            getAssignmentsByLogicalNode: (layerId, logicalNodeId) => {
                const state = get()
                const result: EntityAssignment[] = []
                state.effectiveAssignments.forEach((assignment) => {
                    if (assignment.layerId === layerId && assignment.logicalNodeId === logicalNodeId) {
                        result.push(assignment)
                    }
                })
                return result
            },

            getInheritedFrom: (entityId) => {
                const assignment = get().effectiveAssignments.get(entityId)
                if (assignment?.isInherited && assignment?.inheritedFromId) {
                    return get().effectiveAssignments.get(assignment.inheritedFromId) ?? null
                }
                return null
            },

            // ===== Observer Pattern =====

            onLayerChange: (callback) => {
                const state = get()
                state._subscribers.add(callback)

                return () => {
                    state._subscribers.delete(callback)
                }
            },

            // ===== Layout Helpers =====

            getLayerBySequence: (index) => {
                const state = get()
                const layerId = state.layerSequence[index]
                return layerId ? state.layers.find(l => l.id === layerId) : undefined
            },

            calculateLayerX: (layerId, config = {}) => {
                const state = get()
                const { margin = DEFAULT_LAYOUT.margin, width = DEFAULT_LAYOUT.width, gap = DEFAULT_LAYOUT.gap } = config

                const index = state.layerSequence.indexOf(layerId)
                if (index === -1) return 0

                return margin + (index * width) + (index * gap)
            },

            // ===== Build Assignment Request =====

            buildAssignmentRequest: () => {
                const state = get()

                return {
                    scopeFilter: state.scopeFilter ?? undefined,
                    layers: state.layers.map(layer => ({
                        id: layer.id, // Backend expects 'id'
                        name: layer.name,
                        color: layer.color ?? '#808080',
                        order: layer.order,
                        sequence: layer.sequence ?? layer.order,
                        entityTypes: layer.entityTypes,
                        rules: layer.rules ?? [],
                        logicalNodes: layer.logicalNodes,
                        entityAssignments: layer.entityAssignments ?? []
                    })),
                    includeEdges: true
                }
            },

            // ===== Instance Assignment Actions =====

            assignEntityToLayer: (entityId, layerId, options = {}) => {
                const state = get()
                const { logicalNodeId, inheritsChildren = true } = options

                // Check for conflicts first
                const conflict = state.checkAssignmentConflict(entityId, layerId)
                if (conflict) {
                    // Still allow assignment but record the conflict
                    set({ assignmentConflicts: [...state.assignmentConflicts, conflict] })
                }

                // Create the assignment config
                const assignment: EntityAssignmentConfig = {
                    entityId,
                    layerId,
                    logicalNodeId,
                    inheritsChildren,
                    priority: 1000, // User assignments get highest priority
                    assignedBy: 'user',
                    assignedAt: new Date().toISOString()
                }

                // Update instance assignments
                const newAssignments = new Map(state.instanceAssignments)
                newAssignments.set(entityId, assignment)

                // Also update the layer's entityAssignments array for persistence
                const updatedLayers = state.layers.map(layer => {
                    if (layer.id === layerId) {
                        const existing = layer.entityAssignments?.filter(a => a.entityId !== entityId) ?? []
                        return {
                            ...layer,
                            entityAssignments: [...existing, assignment]
                        }
                    }
                    // Remove from other layers
                    if (layer.entityAssignments?.some(a => a.entityId === entityId)) {
                        return {
                            ...layer,
                            entityAssignments: layer.entityAssignments.filter(a => a.entityId !== entityId)
                        }
                    }
                    return layer
                })

                // Update effective assignments for immediate UI feedback
                const newEffective = new Map(state.effectiveAssignments)
                newEffective.set(entityId, {
                    entityId,
                    layerId,
                    logicalNodeId,
                    isInherited: false,
                    confidence: 1.0
                })

                set({
                    instanceAssignments: newAssignments,
                    layers: updatedLayers,
                    effectiveAssignments: newEffective
                })

                return { success: true, conflict: conflict ?? undefined }
            },

            removeEntityAssignment: (entityId) => {
                const state = get()

                // Remove from instanceAssignments
                const newAssignments = new Map(state.instanceAssignments)
                newAssignments.delete(entityId)

                // Remove from layer entityAssignments
                const updatedLayers = state.layers.map(layer => {
                    if (layer.entityAssignments?.some(a => a.entityId === entityId)) {
                        return {
                            ...layer,
                            entityAssignments: layer.entityAssignments.filter(a => a.entityId !== entityId)
                        }
                    }
                    return layer
                })

                // Clear any conflicts related to this entity
                const updatedConflicts = state.assignmentConflicts.filter(
                    c => c.entityId !== entityId && c.conflictingEntityId !== entityId
                )

                // Remove from effective assignments for immediate UI feedback
                const newEffective = new Map(state.effectiveAssignments)
                newEffective.delete(entityId)

                set({
                    instanceAssignments: newAssignments,
                    layers: updatedLayers,
                    assignmentConflicts: updatedConflicts,
                    effectiveAssignments: newEffective
                })
            },

            checkAssignmentConflict: (entityId, layerId) => {
                const state = get()
                const parentMap = state.parentMap

                // Check if any ancestor is assigned to a different layer
                let currentId = entityId
                while (parentMap.has(currentId)) {
                    const parentId = parentMap.get(currentId)!
                    const parentAssignment = state.instanceAssignments.get(parentId)

                    if (parentAssignment && parentAssignment.layerId !== layerId && parentAssignment.inheritsChildren) {
                        return {
                            entityId,
                            conflictingEntityId: parentId,
                            type: 'parent_assigned' as const,
                            message: `Parent entity is already assigned to a different layer with inheritance enabled`,
                            conflictingLayerId: parentAssignment.layerId
                        }
                    }
                    currentId = parentId
                }

                // Check if any descendant is assigned to a different layer
                // Build reverse map (parent -> children) for descendant lookup
                const childMap = new Map<string, string[]>()
                parentMap.forEach((parentId, childId) => {
                    const children = childMap.get(parentId) ?? []
                    children.push(childId)
                    childMap.set(parentId, children)
                })

                // BFS to find descendants
                const queue = [entityId]
                const visited = new Set<string>()

                while (queue.length > 0) {
                    const current = queue.shift()!
                    if (visited.has(current)) continue
                    visited.add(current)

                    const children = childMap.get(current) ?? []
                    for (const childId of children) {
                        const childAssignment = state.instanceAssignments.get(childId)
                        if (childAssignment && childAssignment.layerId !== layerId) {
                            return {
                                entityId,
                                conflictingEntityId: childId,
                                type: 'child_assigned' as const,
                                message: `Child entity is already assigned to a different layer`,
                                conflictingLayerId: childAssignment.layerId
                            }
                        }
                        queue.push(childId)
                    }
                }

                return null
            },

            getInstanceAssignments: () => {
                return get().instanceAssignments
            },

            clearConflicts: () => {
                set({ assignmentConflicts: [] })
            },

            setScopeEdgeConfig: (config) => {
                set({ scopeEdgeConfig: config })
            },

            bulkAssignEntitiesToLayer: (entityIds, layerId, options = {}) => {
                const successful: string[] = []
                const conflicts: AssignmentConflict[] = []
                const state = get()
                const { inheritsChildren = true } = options

                const newInstanceAssignments = new Map(state.instanceAssignments)
                const newEffectiveAssignments = new Map(state.effectiveAssignments)

                // 1. Process assignments in Map first
                entityIds.forEach(entityId => {
                    const conflict = state.checkAssignmentConflict(entityId, layerId)
                    if (conflict) {
                        conflicts.push(conflict)
                    }

                    const assignment: EntityAssignmentConfig = {
                        entityId,
                        layerId,
                        inheritsChildren,
                        priority: 1000,
                        assignedBy: 'user',
                        assignedAt: new Date().toISOString()
                    }

                    newInstanceAssignments.set(entityId, assignment)

                    // Also update effective assignments for immediate tree feedback
                    newEffectiveAssignments.set(entityId, {
                        entityId,
                        layerId,
                        isInherited: false,
                        confidence: 1.0
                    })

                    successful.push(entityId)
                })

                // 2. Batch update layers
                const updatedLayers = state.layers.map(layer => {
                    if (layer.id === layerId) {
                        // Add all to target layer, filtering existing ones that are in entityIds
                        const existing = layer.entityAssignments?.filter(
                            a => !entityIds.includes(a.entityId)
                        ) ?? []

                        const newConfigs = entityIds.map(id => ({
                            entityId: id,
                            layerId: layer.id,
                            inheritsChildren,
                            priority: 1000,
                            assignedBy: 'user' as const,
                            assignedAt: new Date().toISOString()
                        }))

                        return {
                            ...layer,
                            entityAssignments: [...existing, ...newConfigs]
                        }
                    }

                    // Remove these entities from any other layer
                    const hasAny = layer.entityAssignments?.some(a => entityIds.includes(a.entityId))
                    if (hasAny) {
                        return {
                            ...layer,
                            entityAssignments: layer.entityAssignments!.filter(
                                a => !entityIds.includes(a.entityId)
                            )
                        }
                    }

                    return layer
                })

                set({
                    instanceAssignments: newInstanceAssignments,
                    effectiveAssignments: newEffectiveAssignments,
                    layers: updatedLayers,
                    assignmentConflicts: [...state.assignmentConflicts, ...conflicts]
                })

                return { successful, conflicts }
            },

            clearAssignments: () => {
                const state = get()
                const resetLayers = state.layers.map(l => ({
                    ...l,
                    entityAssignments: []
                }))

                set({
                    instanceAssignments: new Map(),
                    assignmentConflicts: [],
                    layers: resetLayers,
                    effectiveAssignments: new Map()
                })
            }
        }),
        {
            name: 'reference-model-storage',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({
                layers: state.layers,
                layerSequence: state.layerSequence,
                instanceAssignments: Array.from(state.instanceAssignments.entries()), // Maps don't JSON stringify well by default, need support or conversion
                preservedEdges: state.preservedEdges,
                scopeFilter: state.scopeFilter
            }),
            onRehydrateStorage: () => (state) => {
                // Must convert Array back to Map for instanceAssignments
                if (state && Array.isArray(state.instanceAssignments)) {
                    state.instanceAssignments = new Map(state.instanceAssignments)
                }
            }
        }
    )
)

// ============================================
// Selector Hooks
// ============================================

export const useLayers = () => useReferenceModelStore(s => s.layers)
export const useLayerSequence = () => useReferenceModelStore(s => s.layerSequence)
export const useScopeFilter = () => useReferenceModelStore(s => s.scopeFilter)
export const useEffectiveAssignments = () => useReferenceModelStore(s => s.effectiveAssignments)
export const usePreservedEdges = () => useReferenceModelStore(s => s.preservedEdges)
export const useAssignmentStatus = () => useReferenceModelStore(s => s.assignmentStatus)
export const useUnassignedEntityIds = () => useReferenceModelStore(s => s.unassignedEntityIds)

/**
 * Hook to subscribe to layer changes
 * Returns cleanup function
 */
export const useLayerChangeSubscription = (callback: LayerChangeCallback) => {
    const subscribe = useReferenceModelStore(s => s.onLayerChange)

    // Note: Caller should wrap in useEffect to handle subscription lifecycle
    return subscribe(callback)
}

/**
 * Hook to get assignment for a specific entity
 */
export const useEntityAssignment = (entityId: string) => {
    const assignments = useReferenceModelStore(s => s.effectiveAssignments)
    return assignments.get(entityId)
}

/**
 * Hook to check if entity is inherited
 */
export const useIsInherited = (entityId: string) => {
    const assignment = useEntityAssignment(entityId)
    return assignment?.isInherited ?? false
}

/**
 * Hook to get instance assignments (direct entity-to-layer mappings)
 */
export const useInstanceAssignments = () => useReferenceModelStore(s => s.instanceAssignments)

/**
 * Hook to get assignment conflicts
 */
export const useAssignmentConflicts = () => useReferenceModelStore(s => s.assignmentConflicts)

/**
 * Hook to get scope edge configuration
 */
export const useScopeEdgeConfig = () => useReferenceModelStore(s => s.scopeEdgeConfig)

/**
 * Hook to get instance assignment for a specific entity
 */
export const useInstanceEntityAssignment = (entityId: string) => {
    const assignments = useReferenceModelStore(s => s.instanceAssignments)
    return assignments.get(entityId)
}

/**
 * Hook to check if an entity has a direct instance assignment (not inherited)
 */
export const useHasInstanceAssignment = (entityId: string) => {
    const assignments = useReferenceModelStore(s => s.instanceAssignments)
    return assignments.has(entityId)
}

