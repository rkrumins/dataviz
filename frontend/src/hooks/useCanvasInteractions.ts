/**
 * useCanvasInteractions - Unified canvas interaction management
 * 
 * Combines context menu, keyboard shortcuts, inline editing, and quick create
 * into a single cohesive hook for consistent UX across all canvas views.
 */

import { useState, useCallback, useRef } from 'react'
import { useCanvasStore } from '@/store/canvas'
import { useGraphProvider } from '@/providers/GraphProviderContext'
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
    // Quick Create
    quickCreate: {
        isOpen: boolean
        position: { x: number; y: number }
        parentUrn?: string
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
    
    // Quick Create Actions
    openQuickCreate: (position: { x: number; y: number }, parentUrn?: string) => void
    closeQuickCreate: () => void
    
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
        onInlineEditSave,
        onEdgeDeleted,
        onTraceNode,
    } = options
    
    const provider = useGraphProvider()
    const {
        nodes,
        edges,
        selectedNodeIds,
        selectedEdgeIds,
        selectNode,
        clearSelection,
        addNodes,
        addEdges,
        updateNode,
        removeNode,
        removeEdge,
        setEditing,
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
    
    const [quickCreate, setQuickCreate] = useState<CanvasInteractionState['quickCreate']>({
        isOpen: false,
        position: { x: 0, y: 0 },
    })
    
    const [commandPalette, setCommandPalette] = useState<CanvasInteractionState['commandPalette']>({
        isOpen: false,
    })
    
    const [clipboard, setClipboard] = useState<CanvasInteractionState['clipboard']>({
        nodeIds: [],
        hasContent: false,
    })
    
    // Refs for position tracking
    const lastMousePosition = useRef({ x: 0, y: 0 })
    
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
        updateNode(nodeId, { label: newValue })
        onInlineEditSave?.(nodeId, newValue)
        setInlineEdit({ nodeId: null, value: '', position: { x: 0, y: 0 } })
    }, [updateNode, onInlineEditSave])
    
    const cancelInlineEdit = useCallback(() => {
        setInlineEdit({ nodeId: null, value: '', position: { x: 0, y: 0 } })
    }, [])
    
    // ===================
    // Quick Create
    // ===================
    
    const openQuickCreate = useCallback((position: { x: number; y: number }, parentUrn?: string) => {
        setQuickCreate({ isOpen: true, position, parentUrn })
    }, [])
    
    const closeQuickCreate = useCallback(() => {
        setQuickCreate(prev => ({ ...prev, isOpen: false }))
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
        const node = nodes.find(n => n.id === nodeId)
        if (node) {
            // Enable edit mode and select the node to open EditNodePanel
            setEditing(true)
            selectNode(nodeId)
        }
    }, [nodes, setEditing, selectNode])
    
    const duplicateNode = useCallback(async (nodeId: string) => {
        const node = nodes.find(n => n.id === nodeId)
        if (!node) return
        
        const newId = `${nodeId}-copy-${Date.now()}`
        const newUrn = `${node.data.urn}-copy-${Date.now()}`
        
        const newNode = {
            ...node,
            id: newId,
            position: {
                x: node.position.x + 50,
                y: node.position.y + 50,
            },
            data: {
                ...node.data,
                urn: newUrn,
                label: `${node.data.label} (Copy)`,
            },
        }
        
        addNodes([newNode])
        selectNode(newId)
        onNodeDuplicated?.(nodeId, newId)
    }, [nodes, addNodes, selectNode, onNodeDuplicated])
    
    const deleteNode = useCallback((nodeId: string) => {
        removeNode(nodeId)
        onNodeDeleted?.(nodeId)
    }, [removeNode, onNodeDeleted])
    
    const createChild = useCallback((parentId: string) => {
        const parentNode = nodes.find(n => n.id === parentId)
        if (parentNode) {
            openQuickCreate(
                { x: parentNode.position.x + 100, y: parentNode.position.y + 100 },
                parentNode.data.urn
            )
        }
    }, [nodes, openQuickCreate])
    
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
        removeEdge(edgeId)
        onEdgeDeleted?.(edgeId)
    }, [removeEdge, onEdgeDeleted])
    
    const reverseEdge = useCallback((edgeId: string) => {
        const edge = edges.find(e => e.id === edgeId)
        if (!edge) return
        
        // Remove old edge and add reversed one
        removeEdge(edgeId)
        addEdges([{
            ...edge,
            id: `${edgeId}-reversed`,
            source: edge.target,
            target: edge.source,
        }])
    }, [edges, removeEdge, addEdges])
    
    // ===================
    // Canvas Actions
    // ===================
    
    const selectAll = useCallback(() => {
        nodes.forEach(n => selectNode(n.id, true))
    }, [nodes, selectNode])
    
    const deleteSelected = useCallback(() => {
        selectedNodeIds.forEach(id => {
            removeNode(id)
            onNodeDeleted?.(id)
        })
        selectedEdgeIds.forEach(id => {
            removeEdge(id)
            onEdgeDeleted?.(id)
        })
        clearSelection()
    }, [selectedNodeIds, selectedEdgeIds, removeNode, removeEdge, clearSelection, onNodeDeleted, onEdgeDeleted])
    
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
            } else if (quickCreate.isOpen) {
                closeQuickCreate()
            } else if (commandPalette.isOpen) {
                closeCommandPalette()
            } else if (contextMenu.isOpen) {
                closeContextMenu()
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
            openQuickCreate(lastMousePosition.current)
        },
        onCommandPalette: openCommandPalette,
    }
    
    // Track mouse position for 'N' key create
    if (typeof window !== 'undefined') {
        document.addEventListener('mousemove', (e) => {
            lastMousePosition.current = { x: e.clientX, y: e.clientY }
        }, { passive: true })
    }
    
    return {
        state: {
            contextMenu,
            inlineEdit,
            quickCreate,
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
        
        // Quick Create
        openQuickCreate,
        closeQuickCreate,
        
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

