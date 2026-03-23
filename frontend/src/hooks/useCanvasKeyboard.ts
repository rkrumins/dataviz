/**
 * useCanvasKeyboard - Keyboard shortcuts for canvas operations
 * 
 * Provides a consistent keyboard experience across all canvas views:
 * - Delete/Backspace: Delete selected nodes/edges
 * - Cmd/Ctrl+D: Duplicate selected nodes
 * - Cmd/Ctrl+A: Select all
 * - Cmd/Ctrl+C: Copy URN to clipboard
 * - Cmd/Ctrl+Z: Undo (future)
 * - Cmd/Ctrl+Shift+Z: Redo (future)
 * - Enter: Edit selected node
 * - Escape: Clear selection / Cancel operation
 * - T: Trace lineage from selected node
 * - N: Create new node
 */

import { useEffect, useCallback, useRef } from 'react'
import { useCanvasStore } from '@/store/canvas'

// ============================================
// Types
// ============================================

export interface CanvasKeyboardHandlers {
    /** Delete selected nodes/edges */
    onDelete?: () => void
    /** Duplicate selected nodes */
    onDuplicate?: () => void
    /** Select all nodes */
    onSelectAll?: () => void
    /** Copy URN to clipboard */
    onCopy?: () => void
    /** Edit selected node */
    onEdit?: () => void
    /** Clear selection / Cancel */
    onCancel?: () => void
    /** Trace from selected node */
    onTrace?: () => void
    /** Create new node */
    onCreate?: () => void
    /** Undo last action */
    onUndo?: () => void
    /** Redo last undone action */
    onRedo?: () => void
    /** Open command palette */
    onCommandPalette?: () => void
}

export interface UseCanvasKeyboardOptions {
    /** Whether keyboard shortcuts are enabled */
    enabled?: boolean
    /** Handlers for keyboard actions */
    handlers: CanvasKeyboardHandlers
    /** Container element (for scoping, defaults to document) */
    containerRef?: React.RefObject<HTMLElement>
}

// ============================================
// Hook Implementation
// ============================================

export function useCanvasKeyboard({
    enabled = true,
    handlers,
    containerRef,
}: UseCanvasKeyboardOptions) {
    const {
        selectedNodeIds,
        selectedEdgeIds,
        clearSelection,
        removeNode,
        removeEdge,
    } = useCanvasStore()
    
    // Store handlers in ref to avoid dependency issues
    const handlersRef = useRef(handlers)
    handlersRef.current = handlers
    
    // Default delete handler
    const defaultDelete = useCallback(() => {
        // Delete selected nodes
        selectedNodeIds.forEach(id => removeNode(id))
        // Delete selected edges
        selectedEdgeIds.forEach(id => removeEdge(id))
        clearSelection()
    }, [selectedNodeIds, selectedEdgeIds, removeNode, removeEdge, clearSelection])
    
    // Default cancel handler
    const defaultCancel = useCallback(() => {
        clearSelection()
    }, [clearSelection])
    
    // Keyboard event handler
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!enabled) return
        
        // Don't handle if typing in an input/textarea
        const target = e.target as HTMLElement
        if (
            target.tagName === 'INPUT' || 
            target.tagName === 'TEXTAREA' || 
            target.isContentEditable
        ) {
            return
        }
        
        const isMod = e.metaKey || e.ctrlKey
        const isShift = e.shiftKey
        
        // Command Palette: Cmd/Ctrl + K
        if (isMod && e.key === 'k') {
            e.preventDefault()
            handlersRef.current.onCommandPalette?.()
            return
        }
        
        // Select All: Cmd/Ctrl + A
        if (isMod && e.key === 'a') {
            e.preventDefault()
            handlersRef.current.onSelectAll?.()
            return
        }
        
        // Copy: Cmd/Ctrl + C
        if (isMod && e.key === 'c') {
            e.preventDefault()
            handlersRef.current.onCopy?.()
            return
        }
        
        // Duplicate: Cmd/Ctrl + D
        if (isMod && e.key === 'd') {
            e.preventDefault()
            handlersRef.current.onDuplicate?.()
            return
        }
        
        // Undo: Cmd/Ctrl + Z
        if (isMod && !isShift && e.key === 'z') {
            e.preventDefault()
            handlersRef.current.onUndo?.()
            return
        }
        
        // Redo: Cmd/Ctrl + Shift + Z
        if (isMod && isShift && e.key === 'z') {
            e.preventDefault()
            handlersRef.current.onRedo?.()
            return
        }
        
        // Delete: Backspace or Delete
        if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault()
            if (handlersRef.current.onDelete) {
                handlersRef.current.onDelete()
            } else {
                defaultDelete()
            }
            return
        }
        
        // Edit: Enter (when node selected)
        if (e.key === 'Enter' && !isMod) {
            e.preventDefault()
            handlersRef.current.onEdit?.()
            return
        }
        
        // Cancel / Clear: Escape
        if (e.key === 'Escape') {
            e.preventDefault()
            if (handlersRef.current.onCancel) {
                handlersRef.current.onCancel()
            } else {
                defaultCancel()
            }
            return
        }
        
        // Trace: T
        if (e.key === 't' && !isMod) {
            e.preventDefault()
            handlersRef.current.onTrace?.()
            return
        }
        
        // Create: N
        if (e.key === 'n' && !isMod) {
            e.preventDefault()
            handlersRef.current.onCreate?.()
            return
        }
    }, [enabled, defaultDelete, defaultCancel])
    
    // Attach event listener
    useEffect(() => {
        const target = containerRef?.current ?? document
        target.addEventListener('keydown', handleKeyDown as EventListener)
        
        return () => {
            target.removeEventListener('keydown', handleKeyDown as EventListener)
        }
    }, [handleKeyDown, containerRef])
    
    return {
        selectedNodeIds,
        selectedEdgeIds,
        hasSelection: selectedNodeIds.length > 0 || selectedEdgeIds.length > 0,
    }
}

// ============================================
// Shortcut Display Helper
// ============================================

export const KEYBOARD_SHORTCUTS = [
    { key: '⌘/Ctrl + K', action: 'Command Palette' },
    { key: '⌘/Ctrl + A', action: 'Select All' },
    { key: '⌘/Ctrl + C', action: 'Copy URN' },
    { key: '⌘/Ctrl + D', action: 'Duplicate' },
    { key: '⌘/Ctrl + Z', action: 'Undo' },
    { key: '⌘/Ctrl + ⇧ + Z', action: 'Redo' },
    { key: 'Delete / ⌫', action: 'Delete Selected' },
    { key: 'Enter', action: 'Edit Selected' },
    { key: 'Escape', action: 'Cancel / Deselect' },
    { key: 'T', action: 'Trace Lineage' },
    { key: 'N', action: 'New Entity' },
]

export default useCanvasKeyboard

