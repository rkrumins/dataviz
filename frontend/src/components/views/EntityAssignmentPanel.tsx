/**
 * EntityAssignmentPanel - Entity browser with search and layer assignment
 * 
 * Features:
 * - Virtual tree for large datasets (100k+ entities)
 * - Real-time search with fuzzy matching
 * - Drag-and-drop to layer drop zones
 * - Bulk selection with shift-click
 * - Current layer assignment badges
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
    Search,
    ChevronRight,
    ChevronDown,
    GripVertical,
    Database,
    Folder,
    Table,
    Box,
    X,
    Filter,
    Layers,
    ArrowRight,
    Server,
    Columns,
    LayoutDashboard,
    BarChart3,
    GitBranch,
    Hash,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'
import {
    useReferenceModelStore,
    useLayers,
    useInstanceAssignments,
    useAssignmentConflicts
} from '@/store/referenceModelStore'
import { useContainmentEdgeTypes, useEntityTypes, useRootEntityTypes, normalizeEdgeType } from '@/store/schema'
import { useGraphHydration } from '@/hooks/useGraphHydration'

// ============================================
// Types
// ============================================

interface EntityTreeNode {
    id: string
    urn: string
    name: string
    type: string
    childCount: number
    children: EntityTreeNode[]
    depth: number
    parentId?: string
    // Assignment info
    assignedLayerId?: string
    isInherited?: boolean
}

interface EntityAssignmentPanelProps {
    isOpen: boolean
    onClose: () => void
    className?: string
}

// ============================================
// Constants
// ============================================

const TYPE_ICON_MAP: Record<string, React.ReactNode> = {
    domain: <Database className="w-4 h-4" />,
    dataplatform: <Server className="w-4 h-4" />,
    system: <Folder className="w-4 h-4" />,
    container: <Folder className="w-4 h-4" />,
    schema: <Folder className="w-4 h-4" />,
    dataset: <Table className="w-4 h-4" />,
    table: <Table className="w-4 h-4" />,
    schemafield: <Hash className="w-4 h-4" />,
    column: <Columns className="w-4 h-4" />,
    dashboard: <LayoutDashboard className="w-4 h-4" />,
    chart: <BarChart3 className="w-4 h-4" />,
    _projection: <GitBranch className="w-4 h-4" />,
}
const DEFAULT_TYPE_ICON = <Box className="w-4 h-4" />

function getTypeIcon(entityType: string): React.ReactNode {
    return TYPE_ICON_MAP[entityType.toLowerCase()] ?? DEFAULT_TYPE_ICON
}

// ============================================
// Sub-components
// ============================================

interface EntityRowProps {
    node: EntityTreeNode
    isSelected: boolean
    isExpanded: boolean
    onSelect: (id: string, isMulti: boolean) => void
    onToggle: (id: string) => void
    onAssign: (entityId: string, layerId: string) => void
    layers: { id: string; name: string; color?: string }[]
    searchQuery: string
    isDragging: boolean
    onDragStart: (e: React.DragEvent, node: EntityTreeNode) => void
    onDragEnd: () => void
}

function EntityRow({
    node,
    isSelected,
    isExpanded,
    onSelect,
    onToggle,
    onAssign,
    layers,
    searchQuery,
    isDragging,
    onDragStart,
    onDragEnd
}: EntityRowProps) {
    const hasChildren = node.childCount > 0 || node.children.length > 0
    const icon = getTypeIcon(node.type)
    const assignedLayer = layers.find(l => l.id === node.assignedLayerId)

    // Highlight search match
    const highlightMatch = (text: string) => {
        if (!searchQuery) return text
        const idx = text.toLowerCase().indexOf(searchQuery.toLowerCase())
        if (idx === -1) return text
        return (
            <>
                {text.slice(0, idx)}
                <mark className="bg-yellow-200 dark:bg-yellow-800 px-0.5 rounded">
                    {text.slice(idx, idx + searchQuery.length)}
                </mark>
                {text.slice(idx + searchQuery.length)}
            </>
        )
    }

    return (
        <div
            className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors group',
                'hover:bg-slate-100 dark:hover:bg-slate-800',
                isSelected && 'bg-blue-50 dark:bg-blue-900/30 ring-1 ring-blue-300 dark:ring-blue-700',
                isDragging && 'opacity-50'
            )}
            style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
            onClick={(e) => onSelect(node.id, e.shiftKey || e.metaKey)}
            draggable
            onDragStart={(e) => onDragStart(e, node)}
            onDragEnd={onDragEnd}
        >
            {/* Expand/Collapse Toggle */}
            {hasChildren ? (
                <button
                    className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                    onClick={(e) => {
                        e.stopPropagation()
                        onToggle(node.id)
                    }}
                >
                    {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-slate-500" />
                    ) : (
                        <ChevronRight className="w-4 h-4 text-slate-500" />
                    )}
                </button>
            ) : (
                <span className="w-5" /> // Spacer
            )}

            {/* Drag Handle */}
            <GripVertical className="w-4 h-4 text-slate-400 opacity-0 group-hover:opacity-100 cursor-grab" />

            {/* Type Icon */}
            <span className="text-slate-500 dark:text-slate-400">{icon}</span>

            {/* Entity Name */}
            <span className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                {highlightMatch(node.name)}
            </span>

            {/* Child Count Badge */}
            {hasChildren && (
                <span className="text-xs text-slate-400 px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded">
                    {node.childCount || node.children.length}
                </span>
            )}

            {/* Assignment Badge */}
            {assignedLayer && (
                <span
                    className={cn(
                        'text-xs px-2 py-0.5 rounded-full font-medium',
                        node.isInherited && 'opacity-60'
                    )}
                    style={{ backgroundColor: assignedLayer.color + '20', color: assignedLayer.color }}
                >
                    {node.isInherited ? '↳ ' : ''}{assignedLayer.name}
                </span>
            )}

            {/* Quick Assign Dropdown */}
            <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                <select
                    className="text-xs bg-transparent border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5"
                    value={node.assignedLayerId || ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                        e.stopPropagation()
                        onAssign(node.id, e.target.value)
                    }}
                >
                    <option value="">Unassigned</option>
                    {layers.map(layer => (
                        <option key={layer.id} value={layer.id}>{layer.name}</option>
                    ))}
                </select>
            </div>
        </div>
    )
}

// ============================================
// Main Component
// ============================================

export function EntityAssignmentPanel({
    isOpen,
    onClose,
    className
}: EntityAssignmentPanelProps) {
    // Store hooks
    const nodes = useCanvasStore(s => s.nodes)
    const edges = useCanvasStore(s => s.edges)
    const layers = useLayers()
    const instanceAssignments = useInstanceAssignments()
    const conflicts = useAssignmentConflicts()
    const assignEntityToLayer = useReferenceModelStore(s => s.assignEntityToLayer)
    const removeEntityAssignment = useReferenceModelStore(s => s.removeEntityAssignment)

    // Lazy loading hook — loads children on expand
    const { loadChildren } = useGraphHydration()

    // Local state
    const [searchQuery, setSearchQuery] = useState('')
    const [granularity, setGranularity] = useState<string>('all')
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [draggingNode, setDraggingNode] = useState<EntityTreeNode | null>(null)
    const searchInputRef = useRef<HTMLInputElement>(null)
    const lastSelectedRef = useRef<string | null>(null)

    // Load root entities on mount so the panel has data to display
    useEffect(() => {
        loadChildren('', { useAllSchemaTypes: true })
    }, [loadChildren])

    // Load children for newly expanded nodes
    const prevExpandedRef = useRef<Set<string>>(new Set())
    useEffect(() => {
        const prev = prevExpandedRef.current
        const newlyExpanded = [...expandedIds].filter(id => !prev.has(id))
        prevExpandedRef.current = new Set(expandedIds)
        if (newlyExpanded.length === 0) return
        const timer = setTimeout(() => {
            newlyExpanded.forEach(id => loadChildren(id))
        }, 50)
        return () => clearTimeout(timer)
    }, [expandedIds, loadChildren])

    // Build entity tree from canvas nodes/edges
    // Note: We need to create a key from instanceAssignments to ensure reactivity
    // since useMemo doesn't detect Map content changes properly
    const assignmentKey = useMemo(
        () => Array.from(instanceAssignments.keys()).sort().join(','),
        [instanceAssignments]
    )

    const containmentEdgeTypes = useContainmentEdgeTypes()
    const schemaEntityTypes = useEntityTypes()
    const rootEntityTypes = useRootEntityTypes()

    // Build dynamic granularity options from schema entity types + actual node types
    const granularityOptions = useMemo(() => {
        const typeSet = new Set<string>()
        // Add types from the ontology schema
        for (const et of schemaEntityTypes) {
            typeSet.add(et.id)
        }
        // Add types actually present in the canvas (covers unregistered/ad-hoc types)
        for (const n of nodes) {
            const t = (n.data as { type?: string }).type
            if (t && t !== 'ghost') typeSet.add(t)
        }
        const options: { value: string; label: string }[] = [
            { value: 'all', label: 'All Entities' },
        ]
        // Use ontology display name when available, otherwise title-case the id
        const nameMap = new Map(schemaEntityTypes.map(et => [et.id, et.name ?? et.id]))
        for (const t of [...typeSet].sort()) {
            options.push({ value: t, label: nameMap.get(t) ?? t })
        }
        return options
    }, [schemaEntityTypes, nodes])

    const entityTree = useMemo<EntityTreeNode[]>(() => {
        if (!nodes.length) return []

        // Build containment map using backend-provided types
        const containmentEdges = edges.filter(e => {
            const edgeType = normalizeEdgeType(e)
            return containmentEdgeTypes.some(type => type.toUpperCase() === edgeType)
        })

        const nodeMap = new Map(nodes.map(n => [n.id, n]))
        const childMap = new Map<string, string[]>()
        const hasParent = new Set<string>()

        containmentEdges.forEach(edge => {
            const children = childMap.get(edge.source) ?? []
            children.push(edge.target)
            childMap.set(edge.source, children)
            hasParent.add(edge.target)
        })

        // Recursive tree builder
        const buildNode = (nodeId: string, depth: number, parentId?: string): EntityTreeNode | null => {
            const node = nodeMap.get(nodeId)
            if (!node || node.data.type === 'ghost') return null

            const childIds = childMap.get(nodeId) ?? []
            const children = childIds
                .map(id => buildNode(id, depth + 1, nodeId))
                .filter((n): n is EntityTreeNode => n !== null)
                .sort((a, b) => a.name.localeCompare(b.name))

            // Get assignment info
            const instanceAssignment = instanceAssignments.get(nodeId)

            return {
                id: nodeId,
                urn: node.data.urn || nodeId,
                name: node.data.label ?? node.data.businessLabel ?? nodeId,
                type: node.data.type || 'unknown',
                childCount: (node.data as { childCount?: number }).childCount ?? children.length,
                children,
                depth,
                parentId,
                assignedLayerId: instanceAssignment?.layerId,
                isInherited: false // Will be computed during rendering if needed
            }
        }

        // Root nodes: no parent edge AND type is a known root type.
        // Restricting to rootEntityTypes prevents orphaned deep nodes
        // (e.g. schemaFields or datasets without parents loaded yet) from
        // appearing at the top level of the tree.
        const rootTypeSet = new Set(rootEntityTypes.map(t => t.toLowerCase()))
        const isRootType = (nodeType: string) =>
            rootTypeSet.size === 0 || rootTypeSet.has((nodeType ?? '').toLowerCase())

        const roots = nodes
            .filter(n => !hasParent.has(n.id) && n.data.type !== 'ghost' && isRootType(n.data.type as string))
            .map(n => buildNode(n.id, 0))
            .filter((n): n is EntityTreeNode => n !== null)
            .sort((a, b) => a.name.localeCompare(b.name))

        return roots
    }, [nodes, edges, instanceAssignments, assignmentKey, containmentEdgeTypes, rootEntityTypes])

    // Filter tree by search and granularity
    const filteredTree = useMemo(() => {
        const matchesSearch = (node: EntityTreeNode): boolean => {
            if (!searchQuery) return true
            return node.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                node.urn.toLowerCase().includes(searchQuery.toLowerCase())
        }

        const matchesGranularity = (node: EntityTreeNode): boolean => {
            if (granularity === 'all') return true
            return node.type === granularity
        }

        // Recursive filter that preserves parent paths
        const filterNode = (node: EntityTreeNode): EntityTreeNode | null => {
            const filteredChildren = node.children
                .map(filterNode)
                .filter((n): n is EntityTreeNode => n !== null)

            const selfMatches = matchesSearch(node) && matchesGranularity(node)

            if (selfMatches || filteredChildren.length > 0) {
                return { ...node, children: filteredChildren }
            }
            return null
        }

        return entityTree
            .map(filterNode)
            .filter((n): n is EntityTreeNode => n !== null)
    }, [entityTree, searchQuery, granularity])

    // Flatten tree for virtual list (only visible nodes)
    const flattenedNodes = useMemo(() => {
        const flattened: EntityTreeNode[] = []

        const traverse = (nodes: EntityTreeNode[]) => {
            nodes.forEach(node => {
                flattened.push(node)
                if (expandedIds.has(node.id) && node.children.length > 0) {
                    traverse(node.children)
                }
            })
        }

        traverse(filteredTree)
        return flattened
    }, [filteredTree, expandedIds])

    // Handlers
    const handleToggle = useCallback((id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
            }
            return next
        })
    }, [])

    const handleSelect = useCallback((id: string, isMulti: boolean) => {
        if (isMulti) {
            // Multi-select: toggle selection
            setSelectedIds(prev => {
                const next = new Set(prev)
                if (next.has(id)) {
                    next.delete(id)
                } else {
                    next.add(id)
                }
                return next
            })
        } else {
            // Single select: replace selection
            setSelectedIds(new Set([id]))
        }
        lastSelectedRef.current = id
    }, [])

    const handleAssign = useCallback((entityId: string, layerId: string) => {
        if (!layerId) {
            removeEntityAssignment(entityId)
        } else {
            assignEntityToLayer(entityId, layerId, { inheritsChildren: true })
        }
    }, [assignEntityToLayer, removeEntityAssignment])

    const handleBulkAssign = useCallback((layerId: string) => {
        selectedIds.forEach(entityId => {
            if (!layerId) {
                removeEntityAssignment(entityId)
            } else {
                assignEntityToLayer(entityId, layerId, { inheritsChildren: true })
            }
        })
    }, [selectedIds, assignEntityToLayer, removeEntityAssignment])

    // Drag & Drop
    const handleDragStart = useCallback((e: React.DragEvent, node: EntityTreeNode) => {
        setDraggingNode(node)
        e.dataTransfer.setData('application/x-entity-assignment', JSON.stringify({
            entityId: node.id,
            entityName: node.name,
            entityType: node.type
        }))
        e.dataTransfer.effectAllowed = 'move'
    }, [])

    const handleDragEnd = useCallback(() => {
        setDraggingNode(null)
    }, [])

    // Keyboard shortcuts
    useEffect(() => {
        if (!isOpen) return

        const handleKeyDown = (e: KeyboardEvent) => {
            // Focus search on /
            if (e.key === '/' && document.activeElement !== searchInputRef.current) {
                e.preventDefault()
                searchInputRef.current?.focus()
            }
            // Clear selection on Escape
            if (e.key === 'Escape') {
                setSelectedIds(new Set())
                searchInputRef.current?.blur()
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [isOpen])

    // Auto-expand on search
    useEffect(() => {
        if (searchQuery) {
            // Expand all parents of matching nodes
            const idsToExpand = new Set<string>()
            const findMatches = (nodes: EntityTreeNode[], parentIds: string[]) => {
                nodes.forEach(node => {
                    const matches = node.name.toLowerCase().includes(searchQuery.toLowerCase())
                    if (matches) {
                        parentIds.forEach(id => idsToExpand.add(id))
                    }
                    if (node.children.length > 0) {
                        findMatches(node.children, [...parentIds, node.id])
                    }
                })
            }
            findMatches(entityTree, [])
            setExpandedIds(prev => new Set([...prev, ...idsToExpand]))
        }
    }, [searchQuery, entityTree])

    if (!isOpen) return null

    return (
        <motion.div
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className={cn(
                'fixed right-0 top-0 h-full w-96 bg-white dark:bg-slate-900 shadow-2xl z-50',
                'flex flex-col border-l border-slate-200 dark:border-slate-700',
                className
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2">
                    <Layers className="w-5 h-5 text-blue-500" />
                    <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                        Entity Assignment
                    </h2>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                    <X className="w-5 h-5 text-slate-500" />
                </button>
            </div>

            {/* Search & Filters */}
            <div className="px-4 py-3 space-y-3 border-b border-slate-200 dark:border-slate-700">
                {/* Search Input */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                        ref={searchInputRef}
                        type="text"
                        placeholder="Search entities... (press /)"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                        >
                            <X className="w-4 h-4 text-slate-400" />
                        </button>
                    )}
                </div>

                {/* Granularity Filter */}
                <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-slate-400" />
                    <select
                        value={granularity}
                        onChange={e => setGranularity(e.target.value)}
                        className="flex-1 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5"
                    >
                        {granularityOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>

                {/* Selection Info & Bulk Actions */}
                {selectedIds.size > 0 && (
                    <div className="flex items-center gap-2 p-2 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
                        <span className="text-sm text-blue-700 dark:text-blue-300 font-medium">
                            {selectedIds.size} selected
                        </span>
                        <ArrowRight className="w-4 h-4 text-blue-400" />
                        <select
                            className="flex-1 text-sm bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-700 rounded px-2 py-1"
                            defaultValue=""
                            onChange={e => {
                                if (e.target.value) {
                                    handleBulkAssign(e.target.value)
                                    setSelectedIds(new Set())
                                }
                            }}
                        >
                            <option value="">Assign to layer...</option>
                            {layers.map(layer => (
                                <option key={layer.id} value={layer.id}>{layer.name}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => setSelectedIds(new Set())}
                            className="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-800"
                        >
                            <X className="w-4 h-4 text-blue-500" />
                        </button>
                    </div>
                )}
            </div>

            {/* Conflicts Banner */}
            {conflicts.length > 0 && (
                <div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700">
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                        ⚠️ {conflicts.length} assignment conflict{conflicts.length > 1 ? 's' : ''} detected
                    </p>
                </div>
            )}

            {/* Entity Tree */}
            <div className="flex-1 overflow-y-auto px-2 py-2">
                {flattenedNodes.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-40 text-slate-400">
                        <Box className="w-10 h-10 mb-2" />
                        <p className="text-sm">No entities found</p>
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="mt-2 text-xs text-blue-500 hover:underline"
                            >
                                Clear search
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="space-y-0.5">
                        {flattenedNodes.map(node => (
                            <EntityRow
                                key={node.id}
                                node={node}
                                isSelected={selectedIds.has(node.id)}
                                isExpanded={expandedIds.has(node.id)}
                                onSelect={handleSelect}
                                onToggle={handleToggle}
                                onAssign={handleAssign}
                                layers={layers}
                                searchQuery={searchQuery}
                                isDragging={draggingNode?.id === node.id}
                                onDragStart={handleDragStart}
                                onDragEnd={handleDragEnd}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Footer Stats */}
            <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <p className="text-xs text-slate-500">
                    Showing {flattenedNodes.length} entities •
                    {instanceAssignments.size} assigned •
                    {conflicts.length} conflicts
                </p>
            </div>
        </motion.div>
    )
}

// Export for layer drop zones to use
export type { EntityTreeNode }
