/**
 * useCanvasInteractions - Unified canvas interaction management
 * 
 * Combines context menu, keyboard shortcuts, inline editing, and quick create
 * into a single cohesive hook for consistent UX across all canvas views.
 */

import { useState, useCallback } from 'react'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { useToast } from '@/components/ui/toast'
import { getDeleteImpact } from '@/services/versioningApiService'
import { validateDrawnEdge } from '@/services/ontologyPreflightService'
import { generateId } from '@/lib/utils'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'
import type { ContextMenuTarget } from '@/components/canvas/CanvasContextMenu'

// ============================================
// Types
// ============================================

export interface CanvasInteractionState {
    // Context Menu
    contextMenu: {
        isOpen: boolean
        position: { x: number; y: number }
        target: ContextMenuTarget | null
    }
    // Inline Editing
    inlineEdit: {
        nodeId: string | null
        value: string
        position: { x: number; y: number }
    }
    // Command Palette
    commandPalette: {
        isOpen: boolean
    }
    // Clipboard
    clipboard: {
        nodeIds: string[]
        hasContent: boolean
    }
}

export interface UseCanvasInteractionsOptions {
    /** Callback when a node is created */
    onNodeCreated?: (nodeId: string, urn: string) => void
    /** Callback when a node is deleted */
    onNodeDeleted?: (nodeId: string) => void
    /** Callback when a node is duplicated */
    onNodeDuplicated?: (originalId: string, newId: string) => void
    /** Recreate a node's entire subtree as freshly-staged copies (see useDuplicateSubtree).
     *  Injected by the canvas, which owns stageEntity/loadChildren/childMap access. */
    duplicateSubtree?: (nodeId: string) => Promise<string | null>
    /** Callback when an edge is deleted */
    onEdgeDeleted?: (edgeId: string) => void
    /** Callback when inline edit is saved */
    onInlineEditSave?: (nodeId: string, newLabel: string) => void
    /** Available layers for move-to-layer action */
    layers?: Array<{ id: string; name: string; color: string }>
    /** Callback when node is moved to layer */
    onMoveToLayer?: (nodeId: string, layerId: string) => void
    /** Callback to trace a node */
    onTraceNode?: (nodeId: string) => void
    /** Callback to close the edge detail panel (ESC cascade). Should return true if it handled the close. */
    onCloseEdgePanel?: () => boolean
    /** Callback to close the entity drawer (ESC cascade). Should return true if it handled the close. */
    onCloseEntityDrawer?: () => boolean
    /** Callback to exit an active trace (ESC cascade). Should return true if it handled the exit. */
    onExitTrace?: () => boolean
    /** Arm edge connect-mode from the currently selected node (e.g. 'C' key). */
    onConnectMode?: (sourceNodeId: string) => void
}

export interface UseCanvasInteractionsResult {
    // State
    state: CanvasInteractionState
    
    // Context Menu Actions
    openContextMenu: (e: React.MouseEvent, target: ContextMenuTarget) => void
    closeContextMenu: () => void
    
    // Inline Edit Actions
    startInlineEdit: (nodeId: string, value: string, position: { x: number; y: number }) => void
    saveInlineEdit: (nodeId: string, newValue: string) => void
    cancelInlineEdit: () => void
    
    // Command Palette Actions
    openCommandPalette: () => void
    closeCommandPalette: () => void
    
    // Node CRUD Actions
    editNode: (nodeId: string) => void
    duplicateNode: (nodeId: string) => void
    deleteNode: (nodeId: string) => void
    createChild: (parentId: string) => void
    copyUrn: (nodeId: string) => void
    
    // Edge CRUD Actions
    editEdge: (edgeId: string) => void
    deleteEdge: (edgeId: string) => void
    reverseEdge: (edgeId: string) => void
    /** Stage a new RAW edge between two nodes (optimistic + create_edge change). Returns the temp
     *  edge id, or `null` when the ontology gate rejects it (invalid type/endpoints or duplicate). */
    stageEdgeCreate: (sourceUrn: string, targetUrn: string, edgeType: string) => string | null
    
    // Canvas Actions
    selectAll: () => void
    deleteSelected: () => void
    duplicateSelected: () => void
    copySelectedUrns: () => void
    
    // Keyboard handler props
    keyboardHandlers: {
        onDelete: () => void
        onDuplicate: () => void
        onSelectAll: () => void
        onCopy: () => void
        onEdit: () => void
        onCancel: () => void
        onTrace: () => void
        onCreate: () => void
        onConnectMode: () => void
        onCommandPalette: () => void
    }
}

// ============================================
// Hook Implementation
// ============================================

export function useCanvasInteractions(
    options: UseCanvasInteractionsOptions = {}
): UseCanvasInteractionsResult {
    const {
        onNodeCreated,
        onNodeDeleted,
        onNodeDuplicated,
        duplicateSubtree,
        onInlineEditSave,
        onEdgeDeleted,
        onTraceNode,
        onCloseEdgePanel,
        onCloseEntityDrawer,
        onExitTrace,
        onConnectMode,
    } = options
    
    const provider = useGraphProvider()
    const { showToast } = useToast()
    const {
        nodes,
        selectedNodeIds,
        selectedEdgeIds,
        selectNode,
        clearSelection,
        updateNode,
    } = useCanvasStore()
    
    // State
    const [contextMenu, setContextMenu] = useState<CanvasInteractionState['contextMenu']>({
        isOpen: false,
        position: { x: 0, y: 0 },
        target: null,
    })
    
    const [inlineEdit, setInlineEdit] = useState<CanvasInteractionState['inlineEdit']>({
        nodeId: null,
        value: '',
        position: { x: 0, y: 0 },
    })
    
    const [commandPalette, setCommandPalette] = useState<CanvasInteractionState['commandPalette']>({
        isOpen: false,
    })
    
    const [clipboard, setClipboard] = useState<CanvasInteractionState['clipboard']>({
        nodeIds: [],
        hasContent: false,
    })
    
    // ===================
    // Context Menu
    // ===================
    
    const openContextMenu = useCallback((e: React.MouseEvent, target: ContextMenuTarget) => {
        e.preventDefault()
        e.stopPropagation()
        setContextMenu({
            isOpen: true,
            position: { x: e.clientX, y: e.clientY },
            target,
        })
    }, [])
    
    const closeContextMenu = useCallback(() => {
        setContextMenu(prev => ({ ...prev, isOpen: false }))
    }, [])
    
    // ===================
    // Inline Edit
    // ===================
    
    const startInlineEdit = useCallback((nodeId: string, value: string, position: { x: number; y: number }) => {
        setInlineEdit({ nodeId, value, position })
    }, [])
    
    const saveInlineEdit = useCallback((nodeId: string, newValue: string) => {
        const node = useCanvasStore.getState().nodes.find(n => n.id === nodeId)
        const previousLabel = (node?.data?.label as string) ?? ''
        if (previousLabel === newValue) {
            setInlineEdit({ nodeId: null, value: '', position: { x: 0, y: 0 } })
            return
        }
        updateNode(nodeId, { label: newValue })
        onInlineEditSave?.(nodeId, newValue)
        setInlineEdit({ nodeId: null, value: '', position: { x: 0, y: 0 } })

        const stagedChanges = useStagedChangesStore.getState()
        // Replace any existing rename for this node so the user's net rename
        // shows up as a single entry, but preserve the original `before` value.
        stagedChanges.stageOrReplace(
            (c) => c.type === 'rename_entity' && c.targetId === nodeId,
            {
                type: 'rename_entity',
                targetId: nodeId,
                targetUrn: (node?.data?.urn as string) ?? nodeId,
                before: { label: previousLabel },
                after: { label: newValue },
                summary: `Rename '${previousLabel}' → '${newValue}'`,
                discard: () => {
                    useCanvasStore.getState().updateNode(nodeId, { label: previousLabel })
                },
            },
        )
    }, [updateNode, onInlineEditSave])
    
    const cancelInlineEdit = useCallback(() => {
        setInlineEdit({ nodeId: null, value: '', position: { x: 0, y: 0 } })
    }, [])
    
    // ===================
    // Command Palette
    // ===================
    
    const openCommandPalette = useCallback(() => {
        setCommandPalette({ isOpen: true })
    }, [])
    
    const closeCommandPalette = useCallback(() => {
        setCommandPalette({ isOpen: false })
    }, [])
    
    // ===================
    // Node CRUD
    // ===================
    
    const editNode = useCallback((nodeId: string) => {
        // Simply select the node - the NodeDetailsPanel will show automatically
        // The panel has its own internal edit toggle
        selectNode(nodeId)
        closeContextMenu()
    }, [selectNode, closeContextMenu])
    
    const duplicateNode = useCallback(async (nodeId: string) => {
        if (!duplicateSubtree) return
        const newUrn = await duplicateSubtree(nodeId)
        if (!newUrn) return
        selectNode(newUrn)
        onNodeDuplicated?.(nodeId, newUrn)
    }, [duplicateSubtree, selectNode, onNodeDuplicated])
    
    const deleteNode = useCallback((nodeId: string) => {
        const node = useCanvasStore.getState().nodes.find(n => n.id === nodeId)
        if (!node) return

        // If the node was itself staged-as-create, deleting it just discards the
        // creation rather than staging a separate delete (otherwise apply tries
        // to delete a never-created entity).
        const stagedChanges = useStagedChangesStore.getState()
        const createChange = stagedChanges.changes.find(
            c => c.type === 'create_entity' && c.targetId === nodeId,
        )
        if (createChange) {
            stagedChanges.discard(createChange.id)
            onNodeDeleted?.(nodeId)
            return
        }

        const urn = (node.data?.urn as string) ?? nodeId
        const label = (node.data?.label as string) ?? nodeId
        // Mark visually as pending-delete; actual removal happens on Save.
        useCanvasStore.getState().updateNode(nodeId, { isPending: 'delete' })

        // Stage the (single) root delete. The backend cascades the containment subtree +
        // all incident edges authoritatively; `cascade` (from the delete-impact preview)
        // lets the staged-changes panel showcase exactly what will be removed.
        const stageDelete = (
            cascade?: { nodes: any[]; edges: any[]; nodeTotal: number; edgeTotal: number; descUrns: string[] },
        ) => {
            const more = cascade && (cascade.nodeTotal > 1 || cascade.edgeTotal > 0)
            const summary = more
                ? `Delete '${label}' — also removes ${cascade!.nodeTotal - 1} contained `
                  + `${cascade!.nodeTotal === 2 ? 'entity' : 'entities'}, `
                  + `${cascade!.edgeTotal} relationship${cascade!.edgeTotal === 1 ? '' : 's'}`
                : `Delete '${label}'`
            stagedChanges.stage({
                type: 'delete_entity',
                targetId: nodeId,
                targetUrn: urn,
                // `cascade` carries the full impact preview so the staged-changes review can
                // itemise exactly what will be removed (CascadeImpactList).
                before: {
                    node: { ...node },
                    cascade: cascade
                        ? { nodes: cascade.nodes, edges: cascade.edges, nodeTotal: cascade.nodeTotal, edgeTotal: cascade.edgeTotal }
                        : undefined,
                },
                after: null,
                summary,
                apply: async () => {
                    useCanvasStore.getState().removeNode(nodeId)
                },
                discard: () => {
                    useCanvasStore.getState().updateNode(nodeId, { isPending: undefined })
                    cascade?.descUrns.forEach(id => useCanvasStore.getState().updateNode(id, { isPending: undefined }))
                },
            })
            onNodeDeleted?.(nodeId)
        }

        // In a draft, fetch the cascade impact on demand (the canvas is lazy-loaded, so only
        // the backend knows the full subtree). Mark the *loaded* descendants pending-delete so
        // the user sees the impact immediately; the staged change carries the full itemised
        // preview for the review panel.
        const bs = useBranchStore.getState()
        if (bs.currentBranchId && bs.graphId && bs.dataSourceId && bs.workspaceId) {
            getDeleteImpact(bs.workspaceId, bs.dataSourceId, bs.currentBranchId, urn)
                .then(impact => {
                    const descUrns = impact.nodes
                        .map(n => String(n.urn ?? n.entityId ?? ''))
                        .filter(id => id && id !== urn)
                    descUrns.forEach(id => useCanvasStore.getState().updateNode(id, { isPending: 'delete' }))
                    stageDelete({
                        nodes: impact.nodes, edges: impact.edges,
                        nodeTotal: impact.nodeTotal, edgeTotal: impact.edgeTotal, descUrns,
                    })
                })
                .catch(() => stageDelete())   // preview unavailable — still stage the root delete
        } else {
            stageDelete()
        }
    }, [onNodeDeleted])
    
    const createChild = useCallback((parentId: string) => {
        const parentNode = nodes.find(n => n.id === parentId)
        if (parentNode) {
            useHierarchyBuilderStore.getState().open({ parentUrn: (parentNode.data.urn as string) ?? parentNode.id })
        }
    }, [nodes])
    
    const copyUrn = useCallback(async (nodeId: string) => {
        const node = nodes.find(n => n.id === nodeId)
        if (node?.data.urn) {
            await navigator.clipboard.writeText(node.data.urn)
            // Could show a toast here
        }
    }, [nodes])
    
    // ===================
    // Edge CRUD
    // ===================
    
    const editEdge = useCallback((edgeId: string) => {
        // Open edge detail panel or inline editor
        // For now, just select it
        useCanvasStore.getState().selectEdge(edgeId)
    }, [])
    
    const deleteEdge = useCallback((edgeId: string) => {
        const edge = useCanvasStore.getState().edges.find(e => e.id === edgeId)
        if (!edge) return

        const stagedChanges = useStagedChangesStore.getState()
        // If the edge was staged-as-create, deleting just discards the create.
        const createChange = stagedChanges.changes.find(
            c => c.type === 'create_edge' && c.targetId === edgeId,
        )
        if (createChange) {
            stagedChanges.discard(createChange.id)
            onEdgeDeleted?.(edgeId)
            return
        }

        const snapshot = { ...edge }
        useCanvasStore.getState().removeEdge(edgeId)

        stagedChanges.stage({
            type: 'delete_edge',
            targetId: edgeId,
            before: { edge: snapshot },
            after: null,
            summary: `Delete edge ${edge.source} → ${edge.target}`,
            discard: () => {
                useCanvasStore.getState().addEdges([snapshot])
            },
        })
        onEdgeDeleted?.(edgeId)
    }, [onEdgeDeleted])

    const reverseEdge = useCallback((edgeId: string) => {
        const edge = useCanvasStore.getState().edges.find(e => e.id === edgeId)
        if (!edge) return

        // Containment defines the hierarchy and is always stored parent→child — reversing it would
        // invert (or duplicate) a parent relationship. Changing an entity's parent goes through
        // "Move to" (ontology-validated, single-parent), never a raw direction flip.
        const containmentEdgeTypes = useSchemaStore.getState().schema?.containmentEdgeTypes ?? []
        const edgeTypeUpper = (edge.data?.edgeType ?? edge.data?.relationship ?? '').toUpperCase()
        if (containmentEdgeTypes.some(c => c.toUpperCase() === edgeTypeUpper)) {
            showToast('info', 'Containment can’t be reversed — use “Move to” to change an entity’s parent.')
            return
        }

        const reversedId = `${edgeId}-reversed`
        const reversed = {
            ...edge,
            id: reversedId,
            source: edge.target,
            target: edge.source,
        }
        useCanvasStore.getState().removeEdge(edgeId)
        useCanvasStore.getState().addEdges([reversed])

        useStagedChangesStore.getState().stage({
            type: 'reverse_edge',
            targetId: reversedId,
            before: { edge: { ...edge } },
            after: { edge: reversed },
            summary: `Reverse edge ${edge.source} → ${edge.target}`,
            discard: () => {
                useCanvasStore.getState().removeEdge(reversedId)
                useCanvasStore.getState().addEdges([{ ...edge }])
            },
        })
    }, [showToast])

    const stageEdgeCreate = useCallback((sourceUrn: string, targetUrn: string, edgeType: string) => {
        // Ontology gate before we stage anything: lineage-only (no hand-drawn containment), valid
        // source/target types, and not a duplicate of an edge already between these two entities.
        const canvas = useCanvasStore.getState()
        const schema = useSchemaStore.getState().schema
        const srcNode = canvas.nodes.find(n => n.id === sourceUrn || (n.data?.urn as string) === sourceUrn)
        const tgtNode = canvas.nodes.find(n => n.id === targetUrn || (n.data?.urn as string) === targetUrn)
        const verdict = validateDrawnEdge({
            sourceType: (srcNode?.data?.type as string) ?? null,
            targetType: (tgtNode?.data?.type as string) ?? null,
            edgeType,
            relationshipTypes: schema?.relationshipTypes ?? [],
            containmentEdgeTypes: schema?.containmentEdgeTypes ?? [],
            existingEdges: canvas.edges,
            sourceId: sourceUrn,
            targetId: targetUrn,
            entityTypes: schema?.entityTypes ?? [],
        })
        if (!verdict.allowed) {
            showToast('error', verdict.reason ?? 'That relationship isn’t allowed between these entities.')
            return null
        }

        const tempId = generateId('staged-edge')
        const optimistic = {
            id: tempId,
            source: sourceUrn,
            target: targetUrn,
            type: 'lineage' as const,
            data: { edgeType, relationship: edgeType.toLowerCase() },
        }
        useCanvasStore.getState().addEdges([optimistic])
        useStagedChangesStore.getState().stage({
            type: 'create_edge',
            targetId: tempId,
            // `source`/`target` are canvas node ids (== urns == backend entity_ids).
            after: { edgeType, source: sourceUrn, target: targetUrn },
            summary: `Create ${edgeType} edge ${sourceUrn} → ${targetUrn}`,
            // Main-mode parity: applyAll runs this to persist the edge via the
            // provider. In DRAFT mode this hook is never called — saveStagedChangesToDraft
            // routes create_edge through /graph/changes (stagedChangesToOps). Either way
            // a temp endpoint (edge between two new nodes) resolves to its real id.
            apply: async ({ provider, resolveTempId }) => {
                if (!provider) return // local-only (no backend) — accept optimistically
                const src = resolveTempId(sourceUrn) ?? sourceUrn
                const tgt = resolveTempId(targetUrn) ?? targetUrn
                const res = await provider.createEdge({ sourceUrn: src, targetUrn: tgt, edgeType })
                if (!res.success) throw new Error(res.error || 'Failed to create edge')
            },
            discard: () => useCanvasStore.getState().removeEdge(tempId),
        })
        return tempId
    }, [showToast])

    // ===================
    // Canvas Actions
    // ===================
    
    const selectAll = useCallback(() => {
        nodes.forEach(n => selectNode(n.id, true))
    }, [nodes, selectNode])
    
    const deleteSelected = useCallback(() => {
        // Route through the staged-delete helpers so keyboard Delete shows up
        // in the staged-changes panel just like context-menu Delete does.
        selectedNodeIds.forEach(id => deleteNode(id))
        selectedEdgeIds.forEach(id => deleteEdge(id))
        clearSelection()
    }, [selectedNodeIds, selectedEdgeIds, deleteNode, deleteEdge, clearSelection])
    
    const duplicateSelected = useCallback(() => {
        selectedNodeIds.forEach(id => duplicateNode(id))
    }, [selectedNodeIds, duplicateNode])
    
    const copySelectedUrns = useCallback(async () => {
        const urns = selectedNodeIds
            .map(id => nodes.find(n => n.id === id)?.data.urn)
            .filter(Boolean)
            .join('\n')
        
        if (urns) {
            await navigator.clipboard.writeText(urns)
        }
    }, [selectedNodeIds, nodes])
    
    // ===================
    // Keyboard Handlers
    // ===================
    
    const keyboardHandlers = {
        onDelete: deleteSelected,
        onDuplicate: duplicateSelected,
        onSelectAll: selectAll,
        onCopy: copySelectedUrns,
        onEdit: () => {
            if (selectedNodeIds.length === 1) {
                editNode(selectedNodeIds[0])
            }
        },
        onCancel: () => {
            if (inlineEdit.nodeId) {
                cancelInlineEdit()
            } else if (useHierarchyBuilderStore.getState().isOpen) {
                useHierarchyBuilderStore.getState().close()
            } else if (commandPalette.isOpen) {
                closeCommandPalette()
            } else if (contextMenu.isOpen) {
                closeContextMenu()
            } else if (onExitTrace?.()) {
                // Active trace was exited — takes priority over panel/drawer
                // closes so users always have a single-key escape from a busy
                // trace view, regardless of what else is open underneath.
            } else if (onCloseEdgePanel?.()) {
                // Edge panel was open and closed
            } else if (onCloseEntityDrawer?.()) {
                // Entity drawer was open and closed
            } else {
                clearSelection()
            }
        },
        onTrace: () => {
            if (selectedNodeIds.length === 1 && onTraceNode) {
                onTraceNode(selectedNodeIds[0])
            }
        },
        onCreate: () => {
            useHierarchyBuilderStore.getState().open()
        },
        onConnectMode: () => {
            if (selectedNodeIds.length === 1) onConnectMode?.(selectedNodeIds[0])
        },
        onCommandPalette: openCommandPalette,
    }

    return {
        state: {
            contextMenu,
            inlineEdit,
            commandPalette,
            clipboard,
        },
        
        // Context Menu
        openContextMenu,
        closeContextMenu,
        
        // Inline Edit
        startInlineEdit,
        saveInlineEdit,
        cancelInlineEdit,
        
        // Command Palette
        openCommandPalette,
        closeCommandPalette,
        
        // Node CRUD
        editNode,
        duplicateNode,
        deleteNode,
        createChild,
        copyUrn,
        
        // Edge CRUD
        editEdge,
        stageEdgeCreate,
        deleteEdge,
        reverseEdge,
        
        // Canvas Actions
        selectAll,
        deleteSelected,
        duplicateSelected,
        copySelectedUrns,
        
        // Keyboard
        keyboardHandlers,
    }
}

export default useCanvasInteractions

