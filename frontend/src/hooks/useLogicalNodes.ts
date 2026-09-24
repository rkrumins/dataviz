/**
 * useLogicalNodes — group (logical node) management for the View Wizard's layers.
 *
 * ONE implementation with the Context View canvas: every operation is the canvas's own pure
 * transform (`layerMutations` for the group tree, `assignmentMutations` for the entities placed in
 * groups), applied to the WHOLE layout — layers and the canonical assignments together — and handed
 * to the host's single `commit`, so the wizard's one undo history covers group edits too. It used to
 * be a separate copy with its own rules: moving a group into its own descendant deleted it, deleting
 * a group released its entities only in the legacy per-layer array (the canonical record kept
 * pointing at a group that no longer existed), and there was no ungroup or "move everything into".
 */
import { useCallback } from 'react'
import { generateId } from '@/lib/utils'
import type { LogicalNodeConfig } from '@/types/schema'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import * as layerOps from '@/components/canvas/context-view/layerMutations'
import { reassignGroupMembers, releaseGroupMembers } from '@/components/canvas/context-view/assignmentMutations'

export interface UseLogicalNodesReturn {
    /** Add a top-level or nested group to a layer */
    addNode: (layerId: string, name: string, parentId?: string) => LogicalNodeConfig
    /** Rename an existing group */
    renameNode: (layerId: string, nodeId: string, name: string) => void
    /** Delete a group (and the groups inside it); its entities stay in the layer, ungrouped */
    deleteNode: (layerId: string, nodeId: string) => void
    /** Move a group into another group, or to the layer's top level (no parent). Never into itself
     *  or its own descendants. */
    moveNode: (layerId: string, nodeId: string, newParentId?: string) => void
    /** Move a group, with everything in it, to another layer — to its top level or into one of its
     *  groups. The entities placed in it (and in its sub-groups) go along. */
    moveNodeToLayer: (fromLayerId: string, nodeId: string, toLayerId: string, newParentId?: string) => void
    /** Every layer with its groups — where a group can move to. */
    layerChoices: () => Array<{ layerId: string; layerName: string; groups: Array<{ id: string; name: string; path: string }> }>
    /** Dismantle a group: its sub-groups and entities move up one level */
    ungroupNode: (layerId: string, nodeId: string) => void
    /** Move everything in one group (entities and sub-groups) into another */
    moveContents: (layerId: string, fromId: string, toId: string) => void
    /** Toggle collapse/expand visual state */
    toggleCollapse: (layerId: string, nodeId: string) => void

    /** The groups at the top of a layer (each carries its own children) */
    nodesForLayer: (layerId: string) => LogicalNodeConfig[]

    /** Build the full display path for a logicalNodeId, e.g. "Finance › Data Mart" */
    nodePathLabel: (layerId: string, nodeId: string) => string

    canUndo: boolean
    canRedo: boolean
    undo: () => void
    redo: () => void
}

/** The host's undo history (the wizard's single one — group edits are part of it). */
export interface LayoutHistory {
    canUndo: boolean
    canRedo: boolean
    undo: () => void
    redo: () => void
}

const NO_HISTORY: LayoutHistory = { canUndo: false, canRedo: false, undo: () => {}, redo: () => {} }

export function useLogicalNodes(
    layout: NormalizedReferenceLayout,
    commit: (next: NormalizedReferenceLayout) => void,
    history: LayoutHistory = NO_HISTORY,
    /** Apply without an undo entry — for purely visual state (collapse). Defaults to `commit`. */
    applyQuietly: (next: NormalizedReferenceLayout) => void = commit,
): UseLogicalNodesReturn {
    const withLayers = useCallback(
        (layers: NormalizedReferenceLayout['layers']): NormalizedReferenceLayout => ({ ...layout, layers }),
        [layout],
    )

    const addNode = useCallback((layerId: string, name: string, parentId?: string): LogicalNodeConfig => {
        const node: LogicalNodeConfig = { id: generateId(), name: name.trim() || 'New Group', type: 'group', children: [] }
        commit(withLayers(layerOps.addGroup(layout.layers, layerId, node, parentId)))
        return node
    }, [layout, commit, withLayers])

    const renameNode = useCallback((layerId: string, nodeId: string, name: string) => {
        const trimmed = name.trim()
        if (trimmed) commit(withLayers(layerOps.renameGroup(layout.layers, layerId, nodeId, trimmed)))
    }, [layout, commit, withLayers])

    const deleteNode = useCallback((layerId: string, nodeId: string) => {
        const removed = layerOps.groupSubtreeIds(layout.layers, layerId, nodeId)
        commit(releaseGroupMembers(withLayers(layerOps.removeGroup(layout.layers, layerId, nodeId)), removed))
    }, [layout, commit, withLayers])

    const moveNode = useCallback((layerId: string, nodeId: string, newParentId?: string) => {
        const layers = layerOps.moveGroup(layout.layers, layerId, nodeId, newParentId ?? null)
        if (layers !== layout.layers) commit(withLayers(layers))
    }, [layout, commit, withLayers])

    const moveNodeToLayer = useCallback((fromLayerId: string, nodeId: string, toLayerId: string, newParentId?: string) => {
        const next = layerOps.moveGroupToLayer(layout, fromLayerId, nodeId, toLayerId, newParentId ?? null)
        if (next !== layout) commit(next)
    }, [layout, commit])

    const layerChoices = useCallback(
        () => layout.layers.map(l => ({ layerId: l.id, layerName: l.name, groups: layerOps.listGroups(layout.layers, l.id) })),
        [layout],
    )

    const ungroupNode = useCallback((layerId: string, nodeId: string) => {
        const parent = layerOps.parentGroupOf(layout.layers, layerId, nodeId) ?? null
        commit(reassignGroupMembers(withLayers(layerOps.ungroup(layout.layers, layerId, nodeId)), [nodeId], parent))
    }, [layout, commit, withLayers])

    const moveContents = useCallback((layerId: string, fromId: string, toId: string) => {
        const layers = layerOps.moveGroupContents(layout.layers, layerId, fromId, toId)
        const next = reassignGroupMembers(withLayers(layers), [fromId], toId)
        if (next.layers !== layout.layers || next.assignments !== layout.assignments) commit(next)
    }, [layout, commit, withLayers])

    const toggleCollapse = useCallback((layerId: string, nodeId: string) => {
        const toggle = (gs: LogicalNodeConfig[]): LogicalNodeConfig[] => gs.map(g => ({
            ...g,
            ...(g.id === nodeId ? { collapsed: !g.collapsed } : {}),
            ...(g.children ? { children: toggle(g.children) } : {}),
        }))
        applyQuietly(withLayers(layout.layers.map(l => (l.id === layerId ? { ...l, logicalNodes: toggle(l.logicalNodes ?? []) } : l))))
    }, [layout, applyQuietly, withLayers])

    const nodesForLayer = useCallback(
        (layerId: string): LogicalNodeConfig[] => layout.layers.find(l => l.id === layerId)?.logicalNodes ?? [],
        [layout],
    )

    const nodePathLabel = useCallback(
        (layerId: string, nodeId: string): string =>
            layerOps.listGroups(layout.layers, layerId).find(g => g.id === nodeId)?.path ?? '',
        [layout],
    )

    return {
        addNode, renameNode, deleteNode, moveNode, moveNodeToLayer, layerChoices, ungroupNode, moveContents, toggleCollapse,
        nodesForLayer, nodePathLabel,
        canUndo: history.canUndo, canRedo: history.canRedo, undo: history.undo, redo: history.redo,
    }
}
