/**
 * useLogicalNodes
 *
 * State machine for logical node CRUD within ViewWizard layers.
 * Provides undo/redo (20 steps), and pure functional helpers for
 * add / rename / delete / move operations on LogicalNodeConfig trees.
 *
 * Design: callers pass `layers` in and receive updates via `onUpdate`.
 * The hook owns the undo stack internally.
 */

import { useCallback, useRef, useState } from 'react'
import { generateId } from '@/lib/utils'
import type { ViewLayerConfig, LogicalNodeConfig, EntityAssignmentConfig } from '@/types/schema'

const MAX_UNDO_STACK = 20

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deep-clone a lightweight POJO tree (no Dates / functions) */
const cloneLayers = (layers: ViewLayerConfig[]): ViewLayerConfig[] =>
    JSON.parse(JSON.stringify(layers))

/** Find a logical node by ID anywhere in a recursive tree */
function findNode(
    nodes: LogicalNodeConfig[],
    id: string
): LogicalNodeConfig | undefined {
    for (const n of nodes) {
        if (n.id === id) return n
        if (n.children?.length) {
            const found = findNode(n.children, id)
            if (found) return found
        }
    }
}

/** Remove a node from tree by ID, return [removed node, pruned tree] */
function removeNode(
    nodes: LogicalNodeConfig[],
    id: string
): [LogicalNodeConfig | null, LogicalNodeConfig[]] {
    let removed: LogicalNodeConfig | null = null
    const filtered = nodes.reduce<LogicalNodeConfig[]>((acc, n) => {
        if (n.id === id) {
            removed = n
            return acc
        }
        const [rem, children] = removeNode(n.children ?? [], id)
        if (rem) removed = rem
        acc.push({ ...n, children })
        return acc
    }, [])
    return [removed, filtered]
}

/** Insert a node into a tree (as child of parentId, or at root if parentId undefined) */
function insertNode(
    nodes: LogicalNodeConfig[],
    node: LogicalNodeConfig,
    parentId?: string
): LogicalNodeConfig[] {
    if (!parentId) return [...nodes, node]
    return nodes.map(n => {
        if (n.id === parentId) {
            return { ...n, children: [...(n.children ?? []), node] }
        }
        return { ...n, children: insertNode(n.children ?? [], node, parentId) }
    })
}

/** Update a node in tree */
function updateNode(
    nodes: LogicalNodeConfig[],
    id: string,
    patch: Partial<LogicalNodeConfig>
): LogicalNodeConfig[] {
    return nodes.map(n => {
        if (n.id === id) return { ...n, ...patch }
        return { ...n, children: updateNode(n.children ?? [], id, patch) }
    })
}

/** Collect all entity assignments for a node and its children (for cascade on delete) */
function collectNodeIds(node: LogicalNodeConfig): string[] {
    return [node.id, ...(node.children ?? []).flatMap(collectNodeIds)]
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseLogicalNodesReturn {
    /** Add a top-level or nested group to a layer */
    addNode: (layerId: string, name: string, parentId?: string) => LogicalNodeConfig
    /** Rename an existing group */
    renameNode: (layerId: string, nodeId: string, name: string) => void
    /** Delete a group — entity assignments cascade to the parent layer root */
    deleteNode: (layerId: string, nodeId: string) => void
    /** Move a node to a new parent (re-nest) */
    moveNode: (layerId: string, nodeId: string, newParentId?: string) => void
    /** Toggle collapse/expand visual state */
    toggleCollapse: (layerId: string, nodeId: string) => void

    /** Flat list of all logical nodes for a layer (for quick lookup) */
    nodesForLayer: (layerId: string) => LogicalNodeConfig[]

    /** Build the full display path for a logicalNodeId, e.g. "Finance > Data Mart" */
    nodePathLabel: (layerId: string, nodeId: string) => string

    canUndo: boolean
    canRedo: boolean
    undo: () => void
    redo: () => void
}

export function useLogicalNodes(
    layers: ViewLayerConfig[],
    onUpdate: (layers: ViewLayerConfig[]) => void
): UseLogicalNodesReturn {
    // Undo/redo stacks hold full snapshots of layers
    const undoStack = useRef<ViewLayerConfig[][]>([])
    const redoStack = useRef<ViewLayerConfig[][]>([])
    const [, forceRender] = useState(0)

    // ── Snapshot helpers ────────────────────────────────────────────────────────

    const pushSnapshot = useCallback((before: ViewLayerConfig[]) => {
        undoStack.current = [
            ...undoStack.current.slice(-MAX_UNDO_STACK + 1),
            cloneLayers(before),
        ]
        redoStack.current = []
        forceRender(n => n + 1)
    }, [])

    const commitUpdate = useCallback(
        (before: ViewLayerConfig[], next: ViewLayerConfig[]) => {
            pushSnapshot(before)
            onUpdate(next)
        },
        [pushSnapshot, onUpdate]
    )

    // ── CRUD operations ──────────────────────────────────────────────────────────

    const addNode = useCallback(
        (layerId: string, name: string, parentId?: string): LogicalNodeConfig => {
            const newNode: LogicalNodeConfig = {
                id: generateId(),
                name: name.trim() || 'New Group',
                type: 'group',
                children: [],
                collapsed: false,
            }
            const next = cloneLayers(layers).map(l => {
                if (l.id !== layerId) return l
                return {
                    ...l,
                    logicalNodes: insertNode(l.logicalNodes ?? [], newNode, parentId),
                }
            })
            commitUpdate(layers, next)
            return newNode
        },
        [layers, commitUpdate]
    )

    const renameNode = useCallback(
        (layerId: string, nodeId: string, name: string) => {
            const next = cloneLayers(layers).map(l => {
                if (l.id !== layerId) return l
                return {
                    ...l,
                    logicalNodes: updateNode(l.logicalNodes ?? [], nodeId, { name }),
                }
            })
            commitUpdate(layers, next)
        },
        [layers, commitUpdate]
    )

    const deleteNode = useCallback(
        (layerId: string, nodeId: string) => {
            const next = cloneLayers(layers).map(l => {
                if (l.id !== layerId) return l

                const [removed, prunedNodes] = removeNode(l.logicalNodes ?? [], nodeId)

                // Cascade: clear logicalNodeId from any assignments that pointed at this node or its children
                const idsToRemove = removed ? new Set(collectNodeIds(removed)) : new Set<string>()
                const cleanedAssignments: EntityAssignmentConfig[] = (l.entityAssignments ?? []).map(a =>
                    a.logicalNodeId && idsToRemove.has(a.logicalNodeId)
                        ? { ...a, logicalNodeId: undefined }
                        : a
                )

                return { ...l, logicalNodes: prunedNodes, entityAssignments: cleanedAssignments }
            })
            commitUpdate(layers, next)
        },
        [layers, commitUpdate]
    )

    const moveNode = useCallback(
        (layerId: string, nodeId: string, newParentId?: string) => {
            const next = cloneLayers(layers).map(l => {
                if (l.id !== layerId) return l

                const [removed, pruned] = removeNode(l.logicalNodes ?? [], nodeId)
                if (!removed) return l

                return {
                    ...l,
                    logicalNodes: insertNode(pruned, removed, newParentId),
                }
            })
            commitUpdate(layers, next)
        },
        [layers, commitUpdate]
    )

    const toggleCollapse = useCallback(
        (layerId: string, nodeId: string) => {
            const next = cloneLayers(layers).map(l => {
                if (l.id !== layerId) return l
                const node = findNode(l.logicalNodes ?? [], nodeId)
                if (!node) return l
                return {
                    ...l,
                    logicalNodes: updateNode(l.logicalNodes ?? [], nodeId, { collapsed: !node.collapsed }),
                }
            })
            // toggleCollapse is purely visual — don't push to undo stack
            onUpdate(next)
        },
        [layers, onUpdate]
    )

    // ── Derived helpers ──────────────────────────────────────────────────────────

    const nodesForLayer = useCallback(
        (layerId: string): LogicalNodeConfig[] => {
            const layer = layers.find(l => l.id === layerId)
            return layer?.logicalNodes ?? []
        },
        [layers]
    )

    const buildPath = (
        nodes: LogicalNodeConfig[],
        nodeId: string,
        path: string[] = []
    ): string[] | null => {
        for (const n of nodes) {
            if (n.id === nodeId) return [...path, n.name]
            const found = buildPath(n.children ?? [], nodeId, [...path, n.name])
            if (found) return found
        }
        return null
    }

    const nodePathLabel = useCallback(
        (layerId: string, nodeId: string): string => {
            const layer = layers.find(l => l.id === layerId)
            if (!layer) return ''
            const path = buildPath(layer.logicalNodes ?? [], nodeId)
            return path?.join(' → ') ?? ''
        },
        [layers]
    )

    // ── Undo / Redo ──────────────────────────────────────────────────────────────

    const undo = useCallback(() => {
        const stack = undoStack.current
        if (!stack.length) return
        const prev = stack[stack.length - 1]
        undoStack.current = stack.slice(0, -1)
        redoStack.current = [...redoStack.current, cloneLayers(layers)]
        onUpdate(prev)
        forceRender(n => n + 1)
    }, [layers, onUpdate])

    const redo = useCallback(() => {
        const stack = redoStack.current
        if (!stack.length) return
        const next = stack[stack.length - 1]
        redoStack.current = stack.slice(0, -1)
        undoStack.current = [...undoStack.current, cloneLayers(layers)]
        onUpdate(next)
        forceRender(n => n + 1)
    }, [layers, onUpdate])

    return {
        addNode,
        renameNode,
        deleteNode,
        moveNode,
        toggleCollapse,
        nodesForLayer,
        nodePathLabel,
        canUndo: undoStack.current.length > 0,
        canRedo: redoStack.current.length > 0,
        undo,
        redo,
    }
}
