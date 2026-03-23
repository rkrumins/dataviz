/**
 * CommandPalette - Power user command interface (⌘K)
 * 
 * A Spotlight/VSCode-style command palette for:
 * - Quick entity creation
 * - Navigation between views
 * - Running actions
 * - Searching entities
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEntityTypes, useSchemaViews } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'

// ============================================
// Types
// ============================================

export interface CommandItem {
    id: string
    label: string
    description?: string
    icon: keyof typeof LucideIcons
    category: 'action' | 'create' | 'navigation' | 'entity'
    shortcut?: string
    keywords?: string[]
    onSelect: () => void
}

export interface CommandPaletteProps {
    /** Whether the palette is open */
    isOpen: boolean
    /** Close handler */
    onClose: () => void
    /** Additional commands */
    commands?: CommandItem[]
    /** Action handlers */
    onCreateEntity?: (typeId: string) => void
    onNavigateTo?: (viewId: string) => void
    onSelectEntity?: (entityId: string) => void
    onRunAction?: (actionId: string) => void
}

// ============================================
// Component
// ============================================

export function CommandPalette({
    isOpen,
    onClose,
    commands = [],
    onCreateEntity,
    onNavigateTo,
    onSelectEntity,
    onRunAction,
}: CommandPaletteProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    
    const entityTypes = useEntityTypes()
    const nodes = useCanvasStore(s => s.nodes)
    const views = useSchemaViews()
    
    const [query, setQuery] = useState('')
    const [highlightedIndex, setHighlightedIndex] = useState(0)
    const [mode, setMode] = useState<'all' | 'create' | 'goto' | 'find'>('all')
    
    // Build all available commands
    const allCommands = useMemo((): CommandItem[] => {
        const items: CommandItem[] = []
        
        // Built-in actions
        items.push({
            id: 'action:select-all',
            label: 'Select All',
            description: 'Select all nodes on canvas',
            icon: 'CheckSquare',
            category: 'action',
            shortcut: '⌘A',
            keywords: ['select', 'all', 'nodes'],
            onSelect: () => {
                const allIds = nodes.map(n => n.id)
                allIds.forEach(id => useCanvasStore.getState().selectNode(id, true))
                onClose()
            }
        })
        
        items.push({
            id: 'action:clear-selection',
            label: 'Clear Selection',
            description: 'Deselect all nodes',
            icon: 'X',
            category: 'action',
            shortcut: 'Esc',
            keywords: ['clear', 'deselect', 'cancel'],
            onSelect: () => {
                useCanvasStore.getState().clearSelection()
                onClose()
            }
        })
        
        items.push({
            id: 'action:fit-view',
            label: 'Fit to View',
            description: 'Zoom to fit all nodes',
            icon: 'Maximize',
            category: 'action',
            keywords: ['fit', 'zoom', 'view', 'center'],
            onSelect: () => {
                onRunAction?.('fit-view')
                onClose()
            }
        })
        
        items.push({
            id: 'action:toggle-minimap',
            label: 'Toggle Minimap',
            description: 'Show/hide minimap overlay',
            icon: 'Map',
            category: 'action',
            keywords: ['minimap', 'map', 'overview'],
            onSelect: () => {
                onRunAction?.('toggle-minimap')
                onClose()
            }
        })
        
        // Create entity commands
        entityTypes.forEach(type => {
            items.push({
                id: `create:${type.id}`,
                label: `Create ${type.name}`,
                description: type.description,
                icon: (type.visual?.icon as keyof typeof LucideIcons) || 'Plus',
                category: 'create',
                keywords: ['create', 'new', type.name.toLowerCase(), type.id],
                onSelect: () => {
                    onCreateEntity?.(type.id)
                    onClose()
                }
            })
        })
        
        // Navigation commands
        views.forEach(view => {
            items.push({
                id: `goto:${view.id}`,
                label: `Go to ${view.name}`,
                description: `Switch to ${view.name} view`,
                icon: 'ArrowRight',
                category: 'navigation',
                keywords: ['go', 'view', 'navigate', view.name.toLowerCase()],
                onSelect: () => {
                    onNavigateTo?.(view.id)
                    onClose()
                }
            })
        })
        
        // Entity search commands (top 20 for performance)
        nodes.slice(0, 20).forEach(node => {
            items.push({
                id: `find:${node.id}`,
                label: node.data.label || node.id,
                description: `${node.data.type || 'Entity'} • ${node.data.urn || node.id}`,
                icon: 'Search',
                category: 'entity',
                keywords: ['find', 'search', (node.data.label || '').toLowerCase()],
                onSelect: () => {
                    useCanvasStore.getState().selectNode(node.id)
                    onSelectEntity?.(node.id)
                    onClose()
                }
            })
        })
        
        // Add custom commands
        items.push(...commands)
        
        return items
    }, [entityTypes, nodes, views, commands, onCreateEntity, onNavigateTo, onSelectEntity, onRunAction, onClose])
    
    // Filter commands based on query and mode
    const filteredCommands = useMemo(() => {
        let items = allCommands
        
        // Filter by mode
        if (mode === 'create') {
            items = items.filter(c => c.category === 'create')
        } else if (mode === 'goto') {
            items = items.filter(c => c.category === 'navigation')
        } else if (mode === 'find') {
            items = items.filter(c => c.category === 'entity')
        }
        
        // Filter by query
        if (query.trim()) {
            const q = query.toLowerCase()
            items = items.filter(c => 
                c.label.toLowerCase().includes(q) ||
                c.description?.toLowerCase().includes(q) ||
                c.keywords?.some(k => k.includes(q))
            )
        }
        
        return items.slice(0, 12)
    }, [allCommands, query, mode])
    
    // Reset state when opened
    useEffect(() => {
        if (isOpen) {
            setQuery('')
            setHighlightedIndex(0)
            setMode('all')
            setTimeout(() => inputRef.current?.focus(), 50)
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
        
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose()
            }
        }
        
        setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside)
            document.addEventListener('keydown', handleEscape)
        }, 0)
        
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
            document.removeEventListener('keydown', handleEscape)
        }
    }, [isOpen, onClose])
    
    // Keyboard navigation
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlightedIndex(i => Math.min(i + 1, filteredCommands.length - 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightedIndex(i => Math.max(i - 1, 0))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            if (filteredCommands[highlightedIndex]) {
                filteredCommands[highlightedIndex].onSelect()
            }
        } else if (e.key === 'Tab') {
            e.preventDefault()
            // Cycle through modes
            setMode(m => {
                if (m === 'all') return 'create'
                if (m === 'create') return 'goto'
                if (m === 'goto') return 'find'
                return 'all'
            })
        }
    }, [filteredCommands, highlightedIndex])
    
    // Check for mode prefix in query
    useEffect(() => {
        if (query.startsWith('>')) {
            setMode('create')
            setQuery(q => q.slice(1))
        } else if (query.startsWith('@')) {
            setMode('goto')
            setQuery(q => q.slice(1))
        } else if (query.startsWith('/')) {
            setMode('find')
            setQuery(q => q.slice(1))
        }
    }, [query])
    
    // Reset highlighted index when filtered commands change
    useEffect(() => {
        setHighlightedIndex(0)
    }, [filteredCommands.length])
    
    // Get icon component
    const getIcon = (iconName: keyof typeof LucideIcons) => {
        const IconComponent = LucideIcons[iconName] as React.ComponentType<{ className?: string }>
        return IconComponent ? <IconComponent className="w-4 h-4" /> : null
    }
    
    // Category styling
    const getCategoryColor = (category: CommandItem['category']) => {
        switch (category) {
            case 'action': return 'text-blue-500'
            case 'create': return 'text-green-500'
            case 'navigation': return 'text-purple-500'
            case 'entity': return 'text-amber-500'
            default: return 'text-ink-muted'
        }
    }
    
    if (!isOpen) return null
    
    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[300] flex items-start justify-center pt-[15vh]">
                {/* Backdrop */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                    onClick={onClose}
                />
                
                {/* Palette */}
                <motion.div
                    ref={containerRef}
                    initial={{ opacity: 0, scale: 0.95, y: -20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -20 }}
                    transition={{ duration: 0.15, ease: 'easeOut' }}
                    className={cn(
                        "relative w-full max-w-[560px]",
                        "bg-canvas-elevated/98 backdrop-blur-xl",
                        "border border-glass-border rounded-2xl shadow-2xl",
                        "overflow-hidden"
                    )}
                >
                    {/* Search Input */}
                    <div className="flex items-center gap-3 px-4 py-4 border-b border-glass-border">
                        <div className="flex items-center gap-2">
                            <LucideIcons.Command className="w-5 h-5 text-accent-lineage" />
                        </div>
                        
                        {/* Mode Badges */}
                        {mode !== 'all' && (
                            <button
                                onClick={() => setMode('all')}
                                className={cn(
                                    "flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium",
                                    mode === 'create' && "bg-green-500/10 text-green-600",
                                    mode === 'goto' && "bg-purple-500/10 text-purple-600",
                                    mode === 'find' && "bg-amber-500/10 text-amber-600"
                                )}
                            >
                                {mode === 'create' && <><LucideIcons.Plus className="w-3 h-3" /> Create</>}
                                {mode === 'goto' && <><LucideIcons.ArrowRight className="w-3 h-3" /> Go to</>}
                                {mode === 'find' && <><LucideIcons.Search className="w-3 h-3" /> Find</>}
                                <LucideIcons.X className="w-3 h-3 ml-1" />
                            </button>
                        )}
                        
                        <input
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={
                                mode === 'all' ? "Type a command or search..." :
                                mode === 'create' ? "What do you want to create?" :
                                mode === 'goto' ? "Where do you want to go?" :
                                "Search for entities..."
                            }
                            className={cn(
                                "flex-1 bg-transparent outline-none text-ink",
                                "placeholder:text-ink-muted text-base"
                            )}
                        />
                        
                        <kbd className="px-2 py-1 rounded bg-black/10 dark:bg-white/10 text-[10px] font-mono text-ink-muted">
                            Esc
                        </kbd>
                    </div>
                    
                    {/* Results */}
                    <div className="max-h-[400px] overflow-y-auto custom-scrollbar">
                        {filteredCommands.length > 0 ? (
                            <div className="py-2">
                                {filteredCommands.map((cmd, index) => (
                                    <button
                                        key={cmd.id}
                                        onClick={cmd.onSelect}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                                            index === highlightedIndex
                                                ? "bg-accent-lineage/10"
                                                : "hover:bg-black/5 dark:hover:bg-white/5"
                                        )}
                                    >
                                        <div className={cn(
                                            "w-8 h-8 rounded-lg flex items-center justify-center",
                                            "bg-black/5 dark:bg-white/5",
                                            getCategoryColor(cmd.category)
                                        )}>
                                            {getIcon(cmd.icon)}
                                        </div>
                                        
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-ink truncate">
                                                {cmd.label}
                                            </div>
                                            {cmd.description && (
                                                <div className="text-xs text-ink-muted truncate">
                                                    {cmd.description}
                                                </div>
                                            )}
                                        </div>
                                        
                                        {cmd.shortcut && (
                                            <kbd className="px-2 py-1 rounded bg-black/10 dark:bg-white/10 text-[10px] font-mono text-ink-muted">
                                                {cmd.shortcut}
                                            </kbd>
                                        )}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="py-12 text-center">
                                <LucideIcons.Search className="w-10 h-10 text-ink-muted/30 mx-auto mb-3" />
                                <p className="text-sm text-ink-muted">No results found</p>
                                <p className="text-xs text-ink-muted/70 mt-1">Try a different search term</p>
                            </div>
                        )}
                    </div>
                    
                    {/* Footer */}
                    <div className="flex items-center justify-between px-4 py-2 border-t border-glass-border bg-black/5 dark:bg-white/5">
                        <div className="flex items-center gap-3">
                            <span className="text-[10px] text-ink-muted flex items-center gap-1">
                                <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono">↑↓</kbd> Navigate
                            </span>
                            <span className="text-[10px] text-ink-muted flex items-center gap-1">
                                <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono">↵</kbd> Select
                            </span>
                            <span className="text-[10px] text-ink-muted flex items-center gap-1">
                                <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono">Tab</kbd> Mode
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] text-ink-muted">
                                <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono">&gt;</kbd> Create
                            </span>
                            <span className="text-[10px] text-ink-muted">
                                <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono">@</kbd> Go to
                            </span>
                            <span className="text-[10px] text-ink-muted">
                                <kbd className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono">/</kbd> Find
                            </span>
                        </div>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    )
}

export default CommandPalette

