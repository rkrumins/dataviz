/**
 * InlineNodeEditor - Edit node names directly on the canvas
 * 
 * Provides a minimal, distraction-free inline editing experience:
 * - Double-click to activate
 * - Auto-select text on focus
 * - Save on Enter or blur
 * - Cancel on Escape
 * - Visual feedback during editing
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

// ============================================
// Types
// ============================================

export interface InlineNodeEditorProps {
    /** Current node ID being edited */
    nodeId: string | null
    /** Current value */
    value: string
    /** Position of the editor */
    position: { x: number; y: number }
    /** Width of the editor */
    width?: number
    /** Called when edit is complete */
    onSave: (nodeId: string, newValue: string) => void
    /** Called when edit is cancelled */
    onCancel: () => void
    /** Placeholder text */
    placeholder?: string
    /** Max length */
    maxLength?: number
    /** Additional className */
    className?: string
}

// ============================================
// Component
// ============================================

export function InlineNodeEditor({
    nodeId,
    value,
    position,
    width = 200,
    onSave,
    onCancel,
    placeholder = 'Enter name...',
    maxLength = 100,
    className,
}: InlineNodeEditorProps) {
    const [editValue, setEditValue] = useState(value)
    const inputRef = useRef<HTMLInputElement>(null)
    
    // Focus and select on mount
    useEffect(() => {
        if (nodeId && inputRef.current) {
            setEditValue(value)
            inputRef.current.focus()
            inputRef.current.select()
        }
    }, [nodeId, value])
    
    // Handle save
    const handleSave = useCallback(() => {
        if (!nodeId) return
        const trimmed = editValue.trim()
        if (trimmed && trimmed !== value) {
            onSave(nodeId, trimmed)
        } else {
            onCancel()
        }
    }, [nodeId, editValue, value, onSave, onCancel])
    
    // Handle key events
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            handleSave()
        } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
        }
    }, [handleSave, onCancel])
    
    // Handle blur
    const handleBlur = useCallback(() => {
        // Small delay to allow click events to register first
        setTimeout(() => {
            handleSave()
        }, 100)
    }, [handleSave])
    
    if (!nodeId) return null
    
    return (
        <AnimatePresence>
            <motion.div
                key="inline-editor"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.1 }}
                className={cn(
                    "fixed z-[200] pointer-events-auto",
                    className
                )}
                style={{ 
                    left: position.x, 
                    top: position.y,
                    transform: 'translate(-50%, -50%)'
                }}
            >
                <div className="relative">
                    {/* Glow effect */}
                    <div className="absolute -inset-2 bg-accent-lineage/20 rounded-xl blur-lg animate-pulse" />
                    
                    {/* Input container */}
                    <div className="relative bg-canvas-elevated border-2 border-accent-lineage rounded-lg shadow-2xl overflow-hidden">
                        <input
                            ref={inputRef}
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onBlur={handleBlur}
                            placeholder={placeholder}
                            maxLength={maxLength}
                            className={cn(
                                "w-full px-3 py-2 text-sm font-medium",
                                "bg-transparent outline-none",
                                "text-ink placeholder:text-ink-muted"
                            )}
                            style={{ width }}
                        />
                        
                        {/* Hint bar */}
                        <div className="flex items-center justify-between px-2 py-1 bg-black/5 dark:bg-white/5 border-t border-glass-border">
                            <span className="text-[10px] text-ink-muted">
                                {editValue.length}/{maxLength}
                            </span>
                            <span className="text-[10px] text-ink-muted flex items-center gap-2">
                                <span className="bg-black/10 dark:bg-white/10 px-1 rounded">↵</span> Save
                                <span className="bg-black/10 dark:bg-white/10 px-1 rounded">Esc</span> Cancel
                            </span>
                        </div>
                    </div>
                </div>
            </motion.div>
        </AnimatePresence>
    )
}

export default InlineNodeEditor

