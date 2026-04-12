/**
 * QuickCreateNode - Fast entity creation with minimal friction
 * 
 * A lightweight modal that appears on double-click or 'N' key:
 * - Type-ahead entity type search
 * - Quick name entry
 * - Instant creation without full form
 * - Keyboard-first experience
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useViewEntityTypes } from '@/hooks/useViewSchema'
import { useCanvasStore } from '@/store/canvas'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { EntityTypeSchema } from '@/types/schema'

// ============================================
// Types
// ============================================

export interface QuickCreateNodeProps {
    /** Whether the modal is open */
    isOpen: boolean
    /** Position to create the node */
    position: { x: number; y: number }
    /** Optional parent URN for creating children */
    parentUrn?: string
    /** Close handler */
    onClose: () => void
    /** Success callback */
    onCreated?: (nodeId: string, urn: string) => void
    /** Style variant */
    variant?: 'floating' | 'centered'
}

// ============================================
// Component
// ============================================

export function QuickCreateNode({
    isOpen,
    position,
    parentUrn,
    onClose,
    onCreated,
    variant = 'floating',
}: QuickCreateNodeProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const typeInputRef = useRef<HTMLInputElement>(null)
    
    const provider = useGraphProvider()
    const { addNodes, addEdges } = useCanvasStore()
    const entityTypes = useViewEntityTypes()
    
    // State
    const [step, setStep] = useState<'type' | 'name'>('type')
    const [typeQuery, setTypeQuery] = useState('')
    const [selectedType, setSelectedType] = useState<EntityTypeSchema | null>(null)
    const [entityName, setEntityName] = useState('')
    const [isCreating, setIsCreating] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [highlightedIndex, setHighlightedIndex] = useState(0)
    
    // Filter entity types based on query
    const filteredTypes = useMemo(() => {
        if (!typeQuery.trim()) return entityTypes.slice(0, 8)
        
        const query = typeQuery.toLowerCase()
        return entityTypes.filter(t => 
            t.name.toLowerCase().includes(query) ||
            t.id.toLowerCase().includes(query)
        ).slice(0, 8)
    }, [entityTypes, typeQuery])
    
    // Reset state when opened
    useEffect(() => {
        if (isOpen) {
            setStep('type')
            setTypeQuery('')
            setSelectedType(null)
            setEntityName('')
            setError(null)
            setHighlightedIndex(0)
            setTimeout(() => typeInputRef.current?.focus(), 50)
        }
    }, [isOpen])
    
    // Click outside to close
    useEffect(() => {
        if (!isOpen) return
        
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                onClose()
            }
        }
        
        setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside)
        }, 0)
        
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [isOpen, onClose])
    
    // Handle type selection
    const selectType = useCallback((type: EntityTypeSchema) => {
        setSelectedType(type)
        setStep('name')
        setEntityName(`New ${type.name}`)
        setTimeout(() => {
            inputRef.current?.focus()
            inputRef.current?.select()
        }, 50)
    }, [])
    
    // Handle creation
    const handleCreate = useCallback(async () => {
        if (!selectedType || !entityName.trim() || isCreating) return
        
        setIsCreating(true)
        setError(null)
        
        try {
            if (provider) {
                const result = await provider.createNode({
                    entityType: selectedType.id as any,
                    displayName: entityName.trim(),
                    parentUrn: parentUrn,
                    properties: {},
                })
                
                if (!result.success) {
                    setError(result.error || 'Failed to create entity')
                    setIsCreating(false)
                    return
                }
                
                // Add to canvas
                if (result.node) {
                    addNodes([{
                        id: result.node.urn,
                        type: 'generic',
                        position: position,
                        data: {
                            label: result.node.displayName,
                            type: result.node.entityType,
                            urn: result.node.urn,
                            description: result.node.description,
                            classifications: result.node.tags,
                            ...result.node.properties,
                        },
                    }])
                    
                    // Add containment edge if created
                    if (result.containmentEdge) {
                        addEdges([{
                            id: result.containmentEdge.id,
                            source: result.containmentEdge.sourceUrn,
                            target: result.containmentEdge.targetUrn,
                            type: 'containment',
                            data: {
                                edgeType: result.containmentEdge.edgeType,
                                relationship: 'contains',
                            },
                        }])
                    }
                    
                    onCreated?.(result.node.urn, result.node.urn)
                }
            } else {
                // Fallback: create locally without backend
                const urn = `urn:local:${selectedType.id}:${Date.now()}`
                addNodes([{
                    id: urn,
                    type: 'generic',
                    position: position,
                    data: {
                        label: entityName.trim(),
                        type: selectedType.id,
                        urn: urn,
                    },
                }])
                onCreated?.(urn, urn)
            }
            
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create entity')
        } finally {
            setIsCreating(false)
        }
    }, [selectedType, entityName, parentUrn, provider, addNodes, addEdges, position, onClose, onCreated, isCreating])
    
    // Keyboard navigation
    const handleTypeKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlightedIndex(i => Math.min(i + 1, filteredTypes.length - 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightedIndex(i => Math.max(i - 1, 0))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            if (filteredTypes[highlightedIndex]) {
                selectType(filteredTypes[highlightedIndex])
            }
        } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
        }
    }, [filteredTypes, highlightedIndex, selectType, onClose])
    
    const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            handleCreate()
        } else if (e.key === 'Escape') {
            e.preventDefault()
            if (step === 'name') {
                setStep('type')
                setTimeout(() => typeInputRef.current?.focus(), 50)
            } else {
                onClose()
            }
        } else if (e.key === 'Backspace' && entityName === '') {
            setStep('type')
            setTimeout(() => typeInputRef.current?.focus(), 50)
        }
    }, [step, entityName, handleCreate, onClose])
    
    // Get icon for entity type
    const getTypeIcon = (iconName?: string) => {
        if (!iconName) return <LucideIcons.Box className="w-4 h-4" />
        const Icon = LucideIcons[iconName as keyof typeof LucideIcons] as React.ComponentType<{ className?: string }>
        return Icon ? <Icon className="w-4 h-4" /> : <LucideIcons.Box className="w-4 h-4" />
    }
    
    // Position styles
    const positionStyles = variant === 'floating' 
        ? { left: position.x, top: position.y }
        : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
    
    if (!isOpen) return null
    
    return (
        <AnimatePresence>
            <motion.div
                ref={containerRef}
                initial={{ opacity: 0, scale: 0.9, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 10 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className={cn(
                    "fixed z-[200] w-[320px]",
                    "bg-canvas-elevated/98 backdrop-blur-xl",
                    "border border-glass-border rounded-2xl shadow-2xl",
                    "overflow-hidden"
                )}
                style={positionStyles}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-glass-border">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-lineage to-accent-lineage-hover flex items-center justify-center">
                            <LucideIcons.Plus className="w-4 h-4 text-white" />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold text-ink">Quick Create</h3>
                            <p className="text-[10px] text-ink-muted">
                                {step === 'type' ? 'Select entity type' : `Creating ${selectedType?.name}`}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted hover:text-ink transition-colors"
                    >
                        <LucideIcons.X className="w-4 h-4" />
                    </button>
                </div>
                
                {/* Content */}
                <div className="p-3">
                    {step === 'type' ? (
                        <>
                            {/* Type Search */}
                            <div className="relative mb-2">
                                <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                                <input
                                    ref={typeInputRef}
                                    type="text"
                                    value={typeQuery}
                                    onChange={(e) => {
                                        setTypeQuery(e.target.value)
                                        setHighlightedIndex(0)
                                    }}
                                    onKeyDown={handleTypeKeyDown}
                                    placeholder="Search entity types..."
                                    className={cn(
                                        "w-full pl-10 pr-4 py-2.5 rounded-xl",
                                        "bg-black/5 dark:bg-white/5 border border-transparent",
                                        "focus:border-accent-lineage focus:bg-white dark:focus:bg-canvas-elevated",
                                        "outline-none text-sm transition-all"
                                    )}
                                />
                            </div>
                            
                            {/* Type List */}
                            <div className="max-h-[240px] overflow-y-auto custom-scrollbar space-y-1">
                                {filteredTypes.map((type, index) => (
                                    <button
                                        key={type.id}
                                        onClick={() => selectType(type)}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all",
                                            index === highlightedIndex
                                                ? "bg-accent-lineage/10 text-accent-lineage"
                                                : "hover:bg-black/5 dark:hover:bg-white/5 text-ink"
                                        )}
                                    >
                                        <div 
                                            className="w-8 h-8 rounded-lg flex items-center justify-center"
                                            style={{ 
                                                backgroundColor: type.visual?.color 
                                                    ? `${type.visual.color}20` 
                                                    : 'rgba(59, 130, 246, 0.1)',
                                                color: type.visual?.color || '#3b82f6'
                                            }}
                                        >
                                            {getTypeIcon(type.visual?.icon)}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium truncate">{type.name}</div>
                                            {type.description && (
                                                <div className="text-[10px] text-ink-muted truncate">
                                                    {type.description}
                                                </div>
                                            )}
                                        </div>
                                        <LucideIcons.ChevronRight className="w-4 h-4 text-ink-muted" />
                                    </button>
                                ))}
                                
                                {filteredTypes.length === 0 && (
                                    <div className="text-center py-8 text-ink-muted text-sm">
                                        No entity types found
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Name Input */}
                            <div className="space-y-3">
                                {/* Selected Type Badge */}
                                <button
                                    onClick={() => setStep('type')}
                                    className="flex items-center gap-2 px-2 py-1 rounded-lg bg-accent-lineage/10 text-accent-lineage text-xs hover:bg-accent-lineage/20 transition-colors"
                                >
                                    {getTypeIcon(selectedType?.visual?.icon)}
                                    {selectedType?.name}
                                    <LucideIcons.X className="w-3 h-3" />
                                </button>
                                
                                {/* Name Field */}
                                <div>
                                    <label className="text-xs font-medium text-ink-muted mb-1 block">Name</label>
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={entityName}
                                        onChange={(e) => setEntityName(e.target.value)}
                                        onKeyDown={handleNameKeyDown}
                                        placeholder={`Enter ${selectedType?.name?.toLowerCase()} name...`}
                                        className={cn(
                                            "w-full px-4 py-3 rounded-xl",
                                            "bg-black/5 dark:bg-white/5 border border-transparent",
                                            "focus:border-accent-lineage focus:bg-white dark:focus:bg-canvas-elevated",
                                            "outline-none text-sm font-medium transition-all"
                                        )}
                                    />
                                </div>
                                
                                {/* Error Message */}
                                {error && (
                                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-500 text-xs">
                                        <LucideIcons.AlertCircle className="w-3.5 h-3.5" />
                                        {error}
                                    </div>
                                )}
                                
                                {/* Parent Info */}
                                {parentUrn && (
                                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs">
                                        <LucideIcons.GitFork className="w-3.5 h-3.5" />
                                        Creating as child of selected entity
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
                
                {/* Footer */}
                {step === 'name' && (
                    <div className="px-3 pb-3 flex items-center justify-between">
                        <span className="text-[10px] text-ink-muted">
                            Press <kbd className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono">↵</kbd> to create
                        </span>
                        <button
                            onClick={handleCreate}
                            disabled={!entityName.trim() || isCreating}
                            className={cn(
                                "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all",
                                "bg-gradient-to-r from-accent-lineage to-accent-lineage-hover text-white",
                                "hover:shadow-lg hover:shadow-accent-lineage/25",
                                "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-none"
                            )}
                        >
                            {isCreating ? (
                                <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <LucideIcons.Plus className="w-4 h-4" />
                            )}
                            Create
                        </button>
                    </div>
                )}
                
                {/* Keyboard Hints */}
                <div className="flex items-center justify-center gap-4 px-4 py-2 border-t border-glass-border bg-black/5 dark:bg-white/5">
                    <span className="text-[10px] text-ink-muted flex items-center gap-1">
                        <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[9px]">↑↓</kbd> Navigate
                    </span>
                    <span className="text-[10px] text-ink-muted flex items-center gap-1">
                        <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[9px]">↵</kbd> Select
                    </span>
                    <span className="text-[10px] text-ink-muted flex items-center gap-1">
                        <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[9px]">Esc</kbd> Close
                    </span>
                </div>
            </motion.div>
        </AnimatePresence>
    )
}

export default QuickCreateNode

