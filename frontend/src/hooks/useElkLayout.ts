/**
 * useElkLayout - Hook for ELK.js graph layout
 * 
 * Features:
 * - Direct ELK.js layout computation (reliable vs worker issues)
 * - Debounced layout to prevent excessive recomputation
 * - Support for LR (left-right) and TB (top-bottom) directions
 * - Hierarchical layout respecting parent-child containment
 */

import { useCallback, useRef, useState } from 'react'
import { create } from 'zustand'
import type { Node, Edge } from '@xyflow/react'
// ELK bundled — runs on main thread. The worker variant (elk-worker.js)
// requires a different module format that doesn't work with Vite's ESM bundling.
// For large graphs, the layout computation is already async (Promise-based).
import ELK from 'elkjs/lib/elk.bundled.js'
import type { EntityTypeSchema } from '../types/schema'

// Singleton ELK instance
const elk = new ELK()

// ============================================
// TYPES
// ============================================

export interface ElkLayoutConfig {
    direction: 'LR' | 'TB'
    layerSpacing: number
    nodeSpacing: number
    hierarchyLimits: Record<string, number>
}

export interface ElkLayoutState {
    // Configuration
    config: ElkLayoutConfig

    // State
    isLayouting: boolean
    lastLayoutTime: number

    // Pinned nodes (keep position during incremental layout)
    pinnedNodeIds: Set<string>

    // Actions
    setDirection: (direction: 'LR' | 'TB') => void
    toggleDirection: () => void
    setLayerSpacing: (spacing: number) => void
    setNodeSpacing: (spacing: number) => void
    setHierarchyLimit: (entityType: string, limit: number) => void
    setLayouting: (isLayouting: boolean) => void
    pinNodes: (nodeIds: string[]) => void
    unpinNodes: (nodeIds: string[]) => void
    pinAllCurrentNodes: (nodeIds: string[]) => void
    clearPinnedNodes: () => void
}

// Default configuration
const DEFAULT_CONFIG: ElkLayoutConfig = {
    direction: 'LR',
    layerSpacing: 150,
    nodeSpacing: 50,
    hierarchyLimits: {
        domain: 5,
        system: 10,
        table: 5,
    },
}

// ============================================
// LAYOUT STORE
// ============================================

export const useElkLayoutStore = create<ElkLayoutState>((set) => ({
    config: DEFAULT_CONFIG,
    isLayouting: false,
    lastLayoutTime: 0,
    pinnedNodeIds: new Set(),

    setDirection: (direction) =>
        set((state) => ({
            config: { ...state.config, direction },
        })),

    toggleDirection: () =>
        set((state) => ({
            config: {
                ...state.config,
                direction: state.config.direction === 'LR' ? 'TB' : 'LR',
            },
        })),

    setLayerSpacing: (layerSpacing) =>
        set((state) => ({
            config: { ...state.config, layerSpacing },
        })),

    setNodeSpacing: (nodeSpacing) =>
        set((state) => ({
            config: { ...state.config, nodeSpacing },
        })),

    setHierarchyLimit: (entityType, limit) =>
        set((state) => ({
            config: {
                ...state.config,
                hierarchyLimits: {
                    ...state.config.hierarchyLimits,
                    [entityType]: limit,
                },
            },
        })),

    setLayouting: (isLayouting) => set({ isLayouting }),

    pinNodes: (nodeIds) =>
        set((state) => {
            const newPinned = new Set(state.pinnedNodeIds)
            nodeIds.forEach((id) => newPinned.add(id))
            return { pinnedNodeIds: newPinned }
        }),

    unpinNodes: (nodeIds) =>
        set((state) => {
            const newPinned = new Set(state.pinnedNodeIds)
            nodeIds.forEach((id) => newPinned.delete(id))
            return { pinnedNodeIds: newPinned }
        }),

    pinAllCurrentNodes: (nodeIds) =>
        set(() => ({
            pinnedNodeIds: new Set(nodeIds),
        })),

    clearPinnedNodes: () => set({ pinnedNodeIds: new Set() }),
}))

// ============================================
// NODE SIZE CONSTANTS
// ============================================

// Schema-driven size mapping (matches GenericNode CSS classes)
const SIZE_TO_PIXELS: Record<string, { width: number; height: number }> = {
    xs: { width: 140, height: 50 },
    sm: { width: 180, height: 70 },
    md: { width: 240, height: 90 },
    lg: { width: 300, height: 110 },
    xl: { width: 380, height: 140 },
}

const DEFAULT_DIMENSIONS = { width: 200, height: 80 }

// Legacy hardcoded dimensions (fallback when schema is not available)
const NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
    // Higher-level entities have larger nodes
    domain: { width: 280, height: 120 },
    system: { width: 260, height: 100 },
    schema: { width: 240, height: 90 },
    app: { width: 240, height: 100 },

    // Data assets
    table: { width: 220, height: 80 },
    dataset: { width: 220, height: 80 },
    view: { width: 200, height: 70 },

    // Columns are smaller
    column: { width: 180, height: 50 },
    asset: { width: 180, height: 70 },

    // Ghost node
    ghost: { width: 150, height: 40 },

    // Default
    default: { width: 200, height: 80 },
}

function getNodeDimensions(
    nodeType: string,
    schemaEntityTypes?: EntityTypeSchema[]
): { width: number; height: number } {
    // 1. Try schema-driven lookup
    if (schemaEntityTypes) {
        const schemaType = schemaEntityTypes.find((et) => et.id === nodeType)
        if (schemaType?.visual?.size) {
            const mapped = SIZE_TO_PIXELS[schemaType.visual.size]
            if (mapped) return mapped
        }
    }

    // 2. Fall back to legacy hardcoded dimensions
    if (NODE_DIMENSIONS[nodeType]) {
        return NODE_DIMENSIONS[nodeType]
    }

    // 3. Final fallback
    return DEFAULT_DIMENSIONS
}

// ============================================
// ELK GRAPH BUILDING
// ============================================

interface ElkInputNode {
    id: string
    width: number
    height: number
    type?: string
    parentId?: string
}

interface ElkInputEdge {
    id: string
    source: string
    target: string
}

interface ElkInputEdgeWithType extends ElkInputEdge {
    type?: string
}

function buildElkGraph(
    nodes: ElkInputNode[],
    edges: ElkInputEdge[],
    direction: 'LR' | 'TB',
    layerSpacing: number,
    nodeSpacing: number,
    _schemaEntityTypes?: EntityTypeSchema[],
    parentMap?: Map<string, string>,
    expandedNodes?: Set<string>,
    isContainmentEdge?: (edgeType: string) => boolean
) {
    const elkDirection = direction === 'TB' ? 'DOWN' : 'RIGHT'
    const hasCompoundNodes = parentMap && expandedNodes && expandedNodes.size > 0

    const layoutOptions: Record<string, string> = {
        'elk.algorithm': 'layered',
        'elk.direction': elkDirection,
        'elk.layered.spacing.nodeNodeBetweenLayers': String(layerSpacing),
        'elk.spacing.nodeNode': String(nodeSpacing),
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.separateConnectedComponents': 'true',
        'elk.edgeRouting': 'ORTHOGONAL',
    }

    // Enable hierarchy handling when compound nodes are present
    if (hasCompoundNodes) {
        layoutOptions['elk.hierarchyHandling'] = 'INCLUDE_CHILDREN'
    }

    // Build node index for quick lookups
    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const nodeIdSet = new Set(nodes.map(n => n.id))

    // Build ELK node hierarchy
    let elkNodes: Array<{
        id: string
        width: number
        height: number
        children?: Array<{ id: string; width: number; height: number }>
        layoutOptions?: Record<string, string>
    }>

    if (hasCompoundNodes) {
        // Determine which nodes are children of expanded parents
        const childrenOfExpanded = new Set<string>()
        const expandedParentChildren = new Map<string, ElkInputNode[]>()

        for (const node of nodes) {
            const parentId = parentMap.get(node.id)
            if (parentId && expandedNodes.has(parentId) && nodeById.has(parentId)) {
                childrenOfExpanded.add(node.id)
                if (!expandedParentChildren.has(parentId)) {
                    expandedParentChildren.set(parentId, [])
                }
                expandedParentChildren.get(parentId)!.push(node)
            }
        }

        elkNodes = []
        for (const node of nodes) {
            // Skip nodes that are children of an expanded parent — they'll be nested
            if (childrenOfExpanded.has(node.id)) continue

            if (expandedNodes.has(node.id) && expandedParentChildren.has(node.id)) {
                // This is an expanded parent — create compound node with children
                const children = expandedParentChildren.get(node.id)!
                elkNodes.push({
                    id: node.id,
                    width: node.width,
                    height: node.height,
                    layoutOptions: {
                        'elk.padding': '[top=40,left=20,bottom=20,right=20]',
                    },
                    children: children.map(child => ({
                        id: child.id,
                        width: child.width,
                        height: child.height,
                    })),
                })
            } else {
                // Leaf node (or non-expanded parent)
                elkNodes.push({
                    id: node.id,
                    width: node.width,
                    height: node.height,
                })
            }
        }
    } else {
        // Flat layout — no parent-child hierarchy in ELK
        elkNodes = nodes.map(node => ({
            id: node.id,
            width: node.width,
            height: node.height,
        }))
    }

    // Filter edges: must reference valid nodes, and optionally exclude containment edges
    const elkEdges = edges
        .filter(e => {
            if (!nodeIdSet.has(e.source) || !nodeIdSet.has(e.target)) return false
            // When isContainmentEdge is provided, filter out containment edges —
            // containment is expressed through the ELK node hierarchy instead
            if (isContainmentEdge && (e as ElkInputEdgeWithType).type && isContainmentEdge((e as ElkInputEdgeWithType).type!)) {
                return false
            }
            return true
        })
        .map(edge => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
        }))

    return {
        id: 'root',
        layoutOptions,
        children: elkNodes,
        edges: elkEdges,
    }
}

interface ElkLayoutNode {
    id: string
    x?: number
    y?: number
    children?: ElkLayoutNode[]
}

function extractPositions(
    elkGraph: { children?: ElkLayoutNode[] },
    expandedNodes?: Set<string>
): Array<{ id: string; x: number; y: number }> {
    const positions: Array<{ id: string; x: number; y: number }> = []

    if (!elkGraph.children) return positions

    for (const child of elkGraph.children) {
        if (typeof child.x === 'number' && typeof child.y === 'number') {
            positions.push({
                id: child.id,
                x: child.x,
                y: child.y,
            })

            // For compound nodes, flatten child positions to absolute coordinates
            if (expandedNodes?.has(child.id) && child.children) {
                for (const nested of child.children) {
                    if (typeof nested.x === 'number' && typeof nested.y === 'number') {
                        positions.push({
                            id: nested.id,
                            x: child.x + nested.x,
                            y: child.y + nested.y,
                        })
                    }
                }
            }
        }
    }

    return positions
}

// ============================================
// MAIN HOOK
// ============================================

export interface UseElkLayoutOptions {
    /** Enable layout computation */
    enabled?: boolean
    /** Callback when layout completes */
    onLayoutComplete?: (nodes: Node[]) => void
}

export interface UseElkLayoutResult {
    /** Apply layout and get positioned nodes */
    applyLayout: (
        nodes: Node[],
        edges: Edge[],
        schemaEntityTypes?: EntityTypeSchema[],
        parentMap?: Map<string, string>,
        expandedNodes?: Set<string>,
        isContainmentEdge?: (edgeType: string) => boolean
    ) => Promise<Node[]>
    /** Apply incremental layout (pin existing, position new) */
    applyIncrementalLayout: (
        existingNodes: Node[],
        newNodes: Node[],
        edges: Edge[],
        schemaEntityTypes?: EntityTypeSchema[],
        parentMap?: Map<string, string>,
        expandedNodes?: Set<string>,
        isContainmentEdge?: (edgeType: string) => boolean
    ) => Promise<Node[]>
    /** Layout in progress */
    isLayouting: boolean
    /** Current layout direction */
    direction: 'LR' | 'TB'
    /** Toggle layout direction */
    toggleDirection: () => void
    /** Full config */
    config: ElkLayoutConfig
}

export function useElkLayout(options: UseElkLayoutOptions = {}): UseElkLayoutResult {
    const { onLayoutComplete } = options

    const [isLayouting, setIsLayoutingLocal] = useState(false)
    const layoutInProgress = useRef(false)

    const {
        config,
        setLayouting,
        toggleDirection,
        pinAllCurrentNodes,
        clearPinnedNodes,
    } = useElkLayoutStore()

    /**
     * Apply ELK layout to nodes
     */
    const applyLayout = useCallback(
        async (
            nodes: Node[],
            edges: Edge[],
            schemaEntityTypes?: EntityTypeSchema[],
            parentMap?: Map<string, string>,
            expandedNodes?: Set<string>,
            isContainmentEdge?: (edgeType: string) => boolean
        ): Promise<Node[]> => {
            if (nodes.length === 0) {
                return nodes
            }

            // Prevent concurrent layouts
            if (layoutInProgress.current) {
                console.log('[ELK] Layout already in progress, skipping')
                return nodes
            }

            layoutInProgress.current = true
            setIsLayoutingLocal(true)
            setLayouting(true)

            try {
                console.log(`[ELK] Starting layout for ${nodes.length} nodes, ${edges.length} edges`)

                // Prepare nodes for ELK
                const elkNodes: ElkInputNode[] = nodes.map((node) => {
                    const nodeType = (node.data?.type as string) || node.type || 'default'
                    const dimensions = getNodeDimensions(nodeType, schemaEntityTypes)
                    return {
                        id: node.id,
                        width: dimensions.width,
                        height: dimensions.height,
                        type: nodeType,
                        parentId: node.data?.parentId as string | undefined,
                    }
                })

                // Prepare edges, preserving semantic edge type for containment filtering
                // Use data.edgeType (semantic: 'CONTAINS', 'TRANSFORMS') not edge.type (React Flow: 'lineage')
                const elkEdges: ElkInputEdgeWithType[] = edges
                    .map((edge) => ({
                        id: edge.id,
                        source: edge.source,
                        target: edge.target,
                        type: (edge.data as any)?.edgeType ?? (edge.data as any)?.relationship ?? edge.type,
                    }))

                // Build ELK graph (handles compound nodes and containment edge filtering)
                const elkGraph = buildElkGraph(
                    elkNodes,
                    elkEdges,
                    config.direction,
                    config.layerSpacing,
                    config.nodeSpacing,
                    schemaEntityTypes,
                    parentMap,
                    expandedNodes,
                    isContainmentEdge
                )

                // Run ELK layout
                const layoutedGraph = await elk.layout(elkGraph)
                const positions = extractPositions(layoutedGraph, expandedNodes)

                console.log(`[ELK] Layout complete, positioned ${positions.length} nodes`)

                // Apply positions to nodes
                const positionMap = new Map(positions.map(p => [p.id, p]))
                const layoutedNodes = nodes.map((node) => {
                    const pos = positionMap.get(node.id)
                    if (pos) {
                        return {
                            ...node,
                            position: { x: pos.x, y: pos.y },
                        }
                    }
                    return node
                })

                onLayoutComplete?.(layoutedNodes)
                return layoutedNodes
            } catch (error) {
                console.error('[ELK] Layout error:', error)
                return nodes
            } finally {
                layoutInProgress.current = false
                setIsLayoutingLocal(false)
                setLayouting(false)
            }
        },
        [config, setLayouting, onLayoutComplete]
    )

    /**
     * Apply incremental layout - pin existing nodes, only layout new ones
     */
    const applyIncrementalLayout = useCallback(
        async (
            existingNodes: Node[],
            newNodes: Node[],
            edges: Edge[],
            schemaEntityTypes?: EntityTypeSchema[],
            parentMap?: Map<string, string>,
            expandedNodes?: Set<string>,
            isContainmentEdge?: (edgeType: string) => boolean
        ): Promise<Node[]> => {
            // Pin all existing nodes
            pinAllCurrentNodes(existingNodes.map((n) => n.id))

            // Combine and layout
            const allNodes = [...existingNodes, ...newNodes]
            const result = await applyLayout(allNodes, edges, schemaEntityTypes, parentMap, expandedNodes, isContainmentEdge)

            // Clear pins after layout
            clearPinnedNodes()

            return result
        },
        [applyLayout, pinAllCurrentNodes, clearPinnedNodes]
    )

    return {
        applyLayout,
        applyIncrementalLayout,
        isLayouting,
        direction: config.direction,
        toggleDirection,
        config,
    }
}

// ============================================
// UTILITY: Get hierarchy limit for entity type
// ============================================

export function getHierarchyLimit(entityType: string): number {
    const { config } = useElkLayoutStore.getState()
    return config.hierarchyLimits[entityType] ?? 10
}
