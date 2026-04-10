/**
 * WizardAssignmentTree - Enhanced Entity Tree for ViewWizard Assignments
 * 
 * Features:
 * - Virtualized tree rendering for 100k+ entities
 * - Configurable containment edge types per ontology
 * - Lazy child loading on expand
 * - Multi-select with bulk operations
 * - Modern glassmorphism UI with smooth animations
 * - Conflict detection and warnings
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import {
    Search,
    ChevronRight,
    GripVertical,
    Box,
    X,
    AlertTriangle,
    CheckSquare,
    Square,
    GitBranch,
    Loader2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    useReferenceModelStore,
    useInstanceAssignments,
    useAssignmentConflicts,
    useEffectiveAssignments
} from '@/store/referenceModelStore'
import type { ViewLayerConfig, AssignmentConflict } from '@/types/schema'
import { useContainmentEdgeTypes, useEntityTypes, useRootEntityTypes, useSchemaIsLoading } from '@/store/schema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { ActiveTarget } from '@/components/views/LayerHierarchyPanel'

import { useEntityBrowser } from '@/hooks/useEntityBrowser'


// ============================================
// Types
// ============================================

export interface EntityTreeNode {
    id: string
    urn: string
    name: string
    type: string
    childCount: number
    children: EntityTreeNode[]
    depth: number
    parentId?: string
    assignedLayerId?: string
    isInherited?: boolean
    hasConflict?: boolean
    conflictMessage?: string
}

interface WizardAssignmentTreeProps {
    /** Layers to assign to */
    layers: ViewLayerConfig[]
    /** Active drop target from the Layer Studio (shows strip indicator) */
    activeTarget?: ActiveTarget | null
    /** Callback when assignment changes */
    onAssignmentChange?: (entityId: string, layerId: string | null) => void
    /** Callback for bulk assignment */
    onBulkAssign?: (layerId: string, entityIds: string[]) => void
    /** Callback when the containment parentMap changes (for AssignmentStep inheritance) */
    onParentMapChange?: (map: Map<string, string>) => void
    /** Additional class name */
    className?: string
}

interface FlatNode extends EntityTreeNode {
    isExpanded: boolean
    isVisible: boolean
    isSelected: boolean
}

// ============================================
// Constants
// ============================================


// Visual config lookup built dynamically from ontology entity types.
// See entityVisualMap in WizardAssignmentTree for the hook-driven map.
type EntityVisualEntry = { icon?: string; color?: string }

// ============================================
// Tree Row Component
// ============================================

interface ChildAllocationSummary {
    layerId: string
    layerName: string
    layerColor: string
    count: number
}

interface TreeRowProps {
    node: FlatNode
    layers: ViewLayerConfig[]
    searchQuery: string
    entityVisualMap: Record<string, EntityVisualEntry>
    childAllocations?: ChildAllocationSummary[]
    onToggle: (id: string) => void
    onSelect: (id: string, multi: boolean) => void
    onAssign: (entityId: string, layerId: string) => void
    onDragStart: (e: React.DragEvent, node: EntityTreeNode) => void
    onDragEnd: () => void
    isDragging: boolean
    isNodeLoading?: boolean
}

function TreeRow({
    node,
    layers,
    searchQuery,
    entityVisualMap,
    childAllocations,
    onToggle,
    onSelect,
    onAssign,
    onDragStart,
    onDragEnd,
    isDragging,
    isNodeLoading
}: TreeRowProps) {
    const hasChildren = node.childCount > 0 || node.children.length > 0
    const typeLower = node.type.toLowerCase()
    const visual = entityVisualMap[typeLower]
    const icon = (() => {
        const Cmp = visual?.icon ? (LucideIcons as Record<string, any>)[visual.icon] : null
        return Cmp ? <Cmp className="w-4 h-4" /> : <Box className="w-4 h-4" />
    })()
    const typeColor = visual?.color ?? '#94a3b8'
    const assignedLayer = layers.find(l => l.id === node.assignedLayerId)

    // Highlight search match
    const highlightMatch = (text: string) => {
        if (!searchQuery) return text
        const idx = text.toLowerCase().indexOf(searchQuery.toLowerCase())
        if (idx === -1) return text
        return (
            <>
                {text.slice(0, idx)}
                <mark className="bg-amber-200 dark:bg-amber-700 px-0.5 rounded font-semibold">
                    {text.slice(idx, idx + searchQuery.length)}
                </mark>
                {text.slice(idx + searchQuery.length)}
            </>
        )
    }

    return (
        <motion.div
            layout
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-150 group cursor-pointer',
                'hover:bg-white/60 dark:hover:bg-slate-800/60 hover:shadow-sm',
                'border border-transparent',
                node.isSelected && 'bg-blue-50/80 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700 shadow-sm',
                isDragging && 'opacity-50 scale-95',
                node.hasConflict && 'bg-amber-50/50 dark:bg-amber-900/20'
            )}
            style={{ paddingLeft: `${node.depth * 20 + 12}px` }}
            onClick={(e) => onSelect(node.id, e.shiftKey || e.metaKey)}
            draggable
            onDragStart={(e) => onDragStart(e as unknown as React.DragEvent, node)}
            onDragEnd={onDragEnd}
        >
            {/* Selection Checkbox */}
            <div
                className={cn(
                    'w-5 h-5 flex items-center justify-center rounded transition-colors',
                    node.isSelected ? 'text-blue-500' : 'text-slate-300 group-hover:text-slate-400'
                )}
                onClick={(e) => {
                    e.stopPropagation()
                    onSelect(node.id, true)
                }}
            >
                {node.isSelected ? (
                    <CheckSquare className="w-4 h-4" />
                ) : (
                    <Square className="w-4 h-4" />
                )}
            </div>

            {/* Expand/Collapse Toggle */}
            {hasChildren ? (
                <button
                    className="p-1 rounded-lg hover:bg-white dark:hover:bg-slate-700 transition-colors"
                    onClick={(e) => {
                        e.stopPropagation()
                        onToggle(node.id)
                    }}
                >
                    {isNodeLoading ? (
                        <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                    ) : (
                    <motion.div
                        animate={{ rotate: node.isExpanded ? 90 : 0 }}
                        transition={{ duration: 0.15 }}
                    >
                        <ChevronRight className="w-4 h-4 text-slate-400" />
                    </motion.div>
                    )}
                </button>
            ) : (
                <span className="w-6" />
            )}

            {/* Drag Handle */}
            <GripVertical className="w-3 h-3 text-slate-300 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing transition-opacity flex-shrink-0" />

            {/* Type Icon with Color */}
            <div
                className="w-6 h-6 rounded-lg flex items-center justify-center text-white shadow-sm flex-shrink-0"
                style={{ backgroundColor: typeColor }}
            >
                {icon}
            </div>

            {/* Entity Name - takes priority */}
            <div className="flex-1 min-w-[120px] overflow-hidden">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate" title={node.name}>
                    {highlightMatch(node.name)}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{node.type}</p>
            </div>

            {/* Child Count Badge */}
            {hasChildren && (
                <span className="text-xs px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 rounded-full flex-shrink-0">
                    {node.childCount || node.children.length}
                </span>
            )}

            {/* Children Allocated Indicator */}
            {childAllocations && childAllocations.length > 0 && (
                <div
                    className="flex items-center gap-1.5 flex-shrink-0 px-2 py-1 rounded-lg bg-indigo-50/80 dark:bg-indigo-950/30 border border-indigo-200/60 dark:border-indigo-800/40"
                    title={childAllocations.map(a => `${a.layerName}: ${a.count} child${a.count > 1 ? 'ren' : ''}`).join('\n')}
                >
                    <GitBranch className="w-3 h-3 text-indigo-500 dark:text-indigo-400 flex-shrink-0" />
                    <span className="text-[10px] font-medium text-indigo-600 dark:text-indigo-300 whitespace-nowrap">
                        {childAllocations.reduce((sum, a) => sum + a.count, 0)} in
                    </span>
                    {childAllocations.slice(0, 3).map(a => (
                        <span
                            key={a.layerId}
                            className="text-[10px] font-medium px-1.5 py-px rounded whitespace-nowrap"
                            style={{
                                backgroundColor: (a.layerColor) + '20',
                                color: a.layerColor,
                            }}
                        >
                            {a.layerName}
                        </span>
                    ))}
                    {childAllocations.length > 3 && (
                        <span className="text-[10px] text-indigo-400 dark:text-indigo-500">+{childAllocations.length - 3}</span>
                    )}
                </div>
            )}

            {/* Conflict Warning */}
            {node.hasConflict && (
                <div className="flex items-center gap-1 text-amber-500 flex-shrink-0" title={node.conflictMessage}>
                    <AlertTriangle className="w-4 h-4" />
                </div>
            )}

            {/* Assignment Badge with Remove Button */}
            {assignedLayer && (
                <div className="flex items-center gap-1 flex-shrink-0">
                    <span
                        className={cn(
                            'text-xs px-2 py-0.5 rounded-full font-medium',
                            node.isInherited && 'opacity-70'
                        )}
                        style={{
                            backgroundColor: (assignedLayer.color || '#3b82f6') + '20',
                            color: assignedLayer.color || '#3b82f6'
                        }}
                    >
                        {node.isInherited ? '↳ ' : ''}{assignedLayer.name}
                    </span>
                    {/* Remove assignment button */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onAssign(node.id, '')
                        }}
                        className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 transition-colors"
                        title="Remove assignment"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}

            {/* Quick Assign Dropdown - only show on hover */}
            <select
                className={cn(
                    'text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600',
                    'rounded-lg px-1.5 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0',
                    'focus:outline-none focus:ring-2 focus:ring-blue-400 max-w-[80px]'
                )}
                value={node.assignedLayerId || ''}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                    e.stopPropagation()
                    onAssign(node.id, e.target.value)
                }}
            >
                <option value="">Assign...</option>
                {layers.map(layer => (
                    <option key={layer.id} value={layer.id}>{layer.name}</option>
                ))}
            </select>
        </motion.div>
    )
}

// ============================================
// Main Component
// ============================================

export function WizardAssignmentTree({
    layers,
    onAssignmentChange,
    onBulkAssign,
    onParentMapChange,
    className
}: WizardAssignmentTreeProps) {
    // ── API-driven Entity Browser (replaces canvas store + useGraphHydration) ──
    const provider = useGraphProvider()
    const rootEntityTypes = useRootEntityTypes()
    const containmentEdgeTypes = useContainmentEdgeTypes()
    const entityTypeDefinitions = useEntityTypes()
    const isSchemaLoading = useSchemaIsLoading()

    const browser = useEntityBrowser({
        provider,
        rootEntityTypes,
        containmentEdgeTypes,
        entityTypeDefinitions,
        enabled: !isSchemaLoading,
    })

    // Load roots from API when schema is ready.
    // Uses rootEntityTypes if defined, falls back to all entity types.
    useEffect(() => {
        if (!isSchemaLoading && (rootEntityTypes.length > 0 || entityTypeDefinitions.length > 0)) {
            browser.loadRoots()
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSchemaLoading, rootEntityTypes.length, entityTypeDefinitions.length])

    // Propagate parentMap changes to AssignmentStep for containment inheritance
    useEffect(() => {
        onParentMapChange?.(browser.parentMap)
    }, [browser.parentMap, onParentMapChange])

    // Store hooks (assignment-related — unchanged)
    const instanceAssignments = useInstanceAssignments()
    const effectiveAssignments = useEffectiveAssignments()
    const conflicts = useAssignmentConflicts()

    const manualAssignmentMap = useMemo(() => {
        const map = new Map<string, string>()
        layers.forEach(l => {
            l.entityAssignments?.forEach(a => {
                map.set(a.entityId, l.id)
            })
        })
        return map
    }, [layers])
    const assignEntityToLayer = useReferenceModelStore(s => s.assignEntityToLayer)
    const removeEntityAssignment = useReferenceModelStore(s => s.removeEntityAssignment)

    // Local UI state
    const [searchQuery, setSearchQuery] = useState('')
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [draggingNode, setDraggingNode] = useState<EntityTreeNode | null>(null)
    const [assignmentWarning, setAssignmentWarning] = useState<string | null>(null)
    const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const parentRef = useRef<HTMLDivElement>(null)
    const searchInputRef = useRef<HTMLInputElement>(null)

    // Build entity tree from API-driven browser data (ontology-hierarchical).
    // Type filter is a pure frontend visibility filter using ontology canContain chains.
    const pathTypes = useMemo(
        () => browser.typeFilter ? browser.typesOnPathTo(browser.typeFilter) : null,
        [browser.typeFilter, browser.typesOnPathTo]
    )

    const entityTree = useMemo<EntityTreeNode[]>(() => {
        if (browser.rootIds.length === 0) return []

        const conflictMap = new Map<string, AssignmentConflict>()
        conflicts.forEach(c => conflictMap.set(c.entityId, c))

        // Track visited URNs to guarantee no node appears more than once in the tree
        const visited = new Set<string>()

        const buildNode = (
            urn: string,
            depth: number,
            parentId?: string,
            parentEffectiveLayerId?: string
        ): EntityTreeNode | null => {
            // Prevent duplicates: each URN renders exactly once
            if (visited.has(urn)) return null
            visited.add(urn)

            const entry = browser.nodes.get(urn)
            if (!entry) return null
            const { node } = entry

            // Type filter: hide branches that can't contain the filtered type (ontology-driven)
            if (pathTypes && node.entityType !== browser.typeFilter && !pathTypes.has(node.entityType)) {
                return null
            }

            // Determine effective assignment (Top-Down)
            const effectiveAssignment = effectiveAssignments.get(urn)
            let effectiveLayerId = effectiveAssignment?.layerId ?? manualAssignmentMap.get(urn)
            let isInherited = effectiveAssignment?.isInherited ?? false
            if (!effectiveLayerId && parentEffectiveLayerId) {
                effectiveLayerId = parentEffectiveLayerId
                isInherited = true
            }

            // Recurse into loaded children only (lazy — children are loaded on expand)
            const children = entry.loaded
                ? entry.childIds
                    .map(id => buildNode(id, depth + 1, urn, effectiveLayerId))
                    .filter((n): n is EntityTreeNode => n !== null)
                    .sort((a, b) => a.name.localeCompare(b.name))
                : []

            const conflict = conflictMap.get(urn)

            return {
                id: urn,
                urn: node.urn,
                name: node.displayName,
                type: node.entityType,
                childCount: entry.totalChildren,
                children,
                depth,
                parentId,
                assignedLayerId: effectiveLayerId,
                isInherited,
                hasConflict: !!conflict,
                conflictMessage: conflict?.message,
            }
        }

        // Exclude nodes that have a known parent (from containment edges loaded on expand).
        // These appear in rootIds because the initial flat query returned them, but they
        // belong as children in the hierarchy, not as top-level roots.
        return browser.rootIds
            .filter(urn => !browser.parentMap.has(urn))
            .map(urn => buildNode(urn, 0))
            .filter((n): n is EntityTreeNode => n !== null)
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [browser.nodes, browser.rootIds, browser.parentMap, browser.typeFilter, pathTypes, conflicts, effectiveAssignments, manualAssignmentMap])

    // Build child allocation map: for each entity with children, which layers are descendants assigned to?
    const childAllocationMap = useMemo(() => {
        const map = new Map<string, ChildAllocationSummary[]>()
        const layerLookup = new Map(layers.map(l => [l.id, l]))

        const collectDescendantLayers = (node: EntityTreeNode): Map<string, number> => {
            const layerCounts = new Map<string, number>()
            for (const child of node.children) {
                if (child.assignedLayerId && !child.isInherited) {
                    layerCounts.set(child.assignedLayerId, (layerCounts.get(child.assignedLayerId) ?? 0) + 1)
                }
                // Recurse into grandchildren
                const childLayers = collectDescendantLayers(child)
                childLayers.forEach((count, layerId) => {
                    layerCounts.set(layerId, (layerCounts.get(layerId) ?? 0) + count)
                })
            }
            return layerCounts
        }

        const processNode = (node: EntityTreeNode) => {
            if (node.children.length > 0) {
                const layerCounts = collectDescendantLayers(node)
                if (layerCounts.size > 0) {
                    const summaries: ChildAllocationSummary[] = []
                    layerCounts.forEach((count, layerId) => {
                        const layer = layerLookup.get(layerId)
                        if (layer) {
                            summaries.push({ layerId, layerName: layer.name, layerColor: layer.color ?? '#94a3b8', count })
                        }
                    })
                    if (summaries.length > 0) {
                        map.set(node.id, summaries.sort((a, b) => b.count - a.count))
                    }
                }
                node.children.forEach(processNode)
            }
        }
        entityTree.forEach(processNode)
        return map
    }, [entityTree, layers])

    // Use schema entity types for filter (same as Entities step) — not tree-derived.
    // This ensures Column, Term, Type, Glossary (and any custom types) always appear.
    const schemaEntityTypes = useEntityTypes()
    const entityTypes = useMemo(
        () => schemaEntityTypes.map(et => et.id).sort(),
        [schemaEntityTypes]
    )

    // Visual map: entity type id (lowercased) → { icon, color } from ontology
    const entityVisualMap = useMemo<Record<string, EntityVisualEntry>>(
        () => Object.fromEntries(schemaEntityTypes.map(et => [et.id.toLowerCase(), et.visual])),
        [schemaEntityTypes]
    )

    // Flatten tree for virtualized rendering — server handles search/filter,
    // so no client-side matchesSearch/matchesType needed. Insert "Load more"
    // sentinels where browser.hasMore is true (same pattern as LayerColumn).
    const flattenedNodes = useMemo<(FlatNode | { id: string; isLoadMore: true; parentId?: string; depth: number })[]>(() => {
        const result: (FlatNode | { id: string; isLoadMore: true; parentId?: string; depth: number })[] = []

        const traverse = (nodes: EntityTreeNode[]) => {
            nodes.forEach(node => {
                result.push({
                    ...node,
                    isExpanded: expandedIds.has(node.id),
                    isVisible: true,
                    isSelected: selectedIds.has(node.id),
                })

                if (expandedIds.has(node.id)) {
                    if (node.children.length > 0) {
                        traverse(node.children)
                    }
                    // "Load more" sentinel for this parent (from API hasMore)
                    const entry = browser.nodes.get(node.id)
                    if (entry?.hasMore) {
                        result.push({
                            id: `__more:${node.id}`,
                            isLoadMore: true as const,
                            parentId: node.id,
                            depth: node.depth + 1,
                        })
                    }
                }
            })
        }

        traverse(entityTree)

        // Root "load more" sentinel
        if (browser.rootHasMore) {
            result.push({
                id: '__more:roots',
                isLoadMore: true as const,
                depth: 0,
            })
        }

        return result
    }, [entityTree, expandedIds, selectedIds, browser.nodes, browser.rootHasMore])

    // Virtualization
    const rowVirtualizer = useVirtualizer({
        count: flattenedNodes.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 52,
        overscan: 10
    })

    // Handlers
    // CRITICAL: expandNode() ONLY loads direct children of the clicked node.
    // It NEVER recursively loads grandchildren. Even with a type filter active,
    // expanding a domain only loads its systems — the user must click again to
    // expand a system, then a dataset, to see columns. O(pageSize) per click.
    const handleToggle = useCallback(async (id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
            }
            return next
        })
        // Lazy load children from API if not already loaded
        const entry = browser.nodes.get(id)
        if (entry && !entry.loaded && (entry.node.childCount ?? 0) > 0) {
            await browser.expandNode(id)
        }
    }, [browser])

    const handleSelect = useCallback((id: string, isMulti: boolean) => {
        if (isMulti) {
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
            setSelectedIds(prev => {
                const next = new Set(prev)
                if (next.size === 1 && next.has(id)) {
                    next.delete(id)
                } else {
                    next.clear()
                    next.add(id)
                }
                return next
            })
        }
    }, [])

    const showAssignmentWarning = useCallback((message: string) => {
        setAssignmentWarning(message)
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
        warningTimerRef.current = setTimeout(() => setAssignmentWarning(null), 5000)
    }, [])

    const handleAssign = useCallback((entityId: string, layerId: string) => {
        if (!layerId) {
            // "Remove" action logic
            const instanceAssignment = instanceAssignments.get(entityId)
            const isExplicitlyExcluded = instanceAssignment?.layerId === '__UNASSIGNED__'

            if (isExplicitlyExcluded) {
                // Was excluded -> Revert to Default (Inheritance)
                removeEntityAssignment(entityId)
            } else {
                const nodeInTree = flattenedNodes.find(n => n.id === entityId)

                if (nodeInTree && 'isInherited' in nodeInTree && nodeInTree.isInherited) {
                    assignEntityToLayer(entityId, '__UNASSIGNED__', { inheritsChildren: true })
                } else {
                    removeEntityAssignment(entityId)
                }
            }
            onAssignmentChange?.(entityId, null)
        } else {
            const result = assignEntityToLayer(entityId, layerId, { inheritsChildren: true })
            if (!result.success && result.conflict?.type === 'containment_locked') {
                showAssignmentWarning(result.conflict.message)
                return // Don't propagate blocked assignment
            }
            onAssignmentChange?.(entityId, layerId)
        }
    }, [assignEntityToLayer, removeEntityAssignment, onAssignmentChange, instanceAssignments, flattenedNodes, showAssignmentWarning])

    const handleBulkAssign = useCallback((layerId: string) => {
        const ids = Array.from(selectedIds)
        if (ids.length === 0) return

        if (onBulkAssign) {
            onBulkAssign(layerId, ids)
            // Clear selection after bulk action
            setSelectedIds(new Set())
            return
        }

        // Fallback to one-by-one if onBulkAssign not provided
        let blockedCount = 0
        ids.forEach(entityId => {
            if (!layerId) {
                removeEntityAssignment(entityId)
                onAssignmentChange?.(entityId, null)
            } else {
                const result = assignEntityToLayer(entityId, layerId, { inheritsChildren: true })
                if (!result.success && result.conflict?.type === 'containment_locked') {
                    blockedCount++
                    return
                }
                onAssignmentChange?.(entityId, layerId)
            }
        })
        if (blockedCount > 0) {
            showAssignmentWarning(`${blockedCount} assignment(s) blocked: children inherit their parent's layer.`)
        }

        // Clear selection after bulk action
        setSelectedIds(new Set())
    }, [selectedIds, onBulkAssign, onAssignmentChange, removeEntityAssignment, assignEntityToLayer, showAssignmentWarning])

    const handleSelectAllChildren = useCallback(() => {
        if (selectedIds.size !== 1) return
        const selectedId = Array.from(selectedIds)[0]
        const node = flattenedNodes.find(n => n.id === selectedId)
        if (!node) return

        const collectChildren = (n: EntityTreeNode): string[] => {
            return [n.id, ...n.children.flatMap(collectChildren)]
        }

        const originalNode = entityTree.find(function findNode(t): t is EntityTreeNode {
            if (t.id === selectedId) return true
            return t.children.some(findNode)
        })

        if (originalNode) {
            const allIds = collectChildren(originalNode)
            setSelectedIds(new Set(allIds))
        }
    }, [selectedIds, flattenedNodes, entityTree])

    // Drag & Drop
    const handleDragStart = useCallback((e: React.DragEvent, node: EntityTreeNode) => {
        setDraggingNode(node)

        // Include all selected entities if dragging a selected one
        const idsToTransfer = selectedIds.has(node.id)
            ? Array.from(selectedIds)
            : [node.id]

        e.dataTransfer.setData('application/x-entity-assignment', JSON.stringify({
            entityId: node.id,
            entityName: node.name,
            entityIds: idsToTransfer,
            entityCount: idsToTransfer.length,
            primaryEntity: { id: node.id, name: node.name, type: node.type }
        }))
        e.dataTransfer.effectAllowed = 'move'
    }, [selectedIds])

    const handleDragEnd = useCallback(() => {
        setDraggingNode(null)
    }, [])

    // Search is server-side — no client-side auto-expand needed.
    // Results come back as flat root items from the API.

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === '/' && document.activeElement !== searchInputRef.current) {
                e.preventDefault()
                searchInputRef.current?.focus()
            }
            if (e.key === 'Escape') {
                setSelectedIds(new Set())
                searchInputRef.current?.blur()
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [])

    return (
        <div className={cn(
            'flex flex-col h-full rounded-2xl overflow-hidden',
            'bg-gradient-to-br from-slate-50/80 to-slate-100/80',
            'dark:from-slate-900/80 dark:to-slate-800/80',
            'backdrop-blur-xl border border-slate-200/60 dark:border-slate-700/60',
            'shadow-lg',
            className
        )}>
            {/* Header */}
            <div className="p-4 space-y-3 border-b border-slate-200/60 dark:border-slate-700/60 bg-white/50 dark:bg-slate-900/50">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-semibold text-slate-800 dark:text-white">
                            Entity Browser
                        </h3>
                        <p className="text-sm text-slate-500">
                            {browser.isLoading ? 'Loading...' : `${flattenedNodes.length} entities`} • {selectedIds.size} selected
                        </p>
                    </div>

                    {conflicts.length > 0 && (
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-100 dark:bg-amber-900/40 rounded-full">
                            <AlertTriangle className="w-4 h-4 text-amber-600" />
                            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                                {conflicts.length} conflict{conflicts.length > 1 ? 's' : ''}
                            </span>
                        </div>
                    )}
                </div>

                {/* Containment inheritance warning */}
                {assignmentWarning && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-400">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                        <span className="flex-1"><span className="font-medium">Assignment blocked.</span> {assignmentWarning}</span>
                        <button onClick={() => setAssignmentWarning(null)} className="text-red-400 hover:text-red-600">&times;</button>
                    </div>
                )}

                {/* Search */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                        ref={searchInputRef}
                        type="text"
                        placeholder="Search entities... (press /)"
                        value={searchQuery}
                        onChange={e => {
                            setSearchQuery(e.target.value)
                            browser.setSearch(e.target.value)  // Server-side search (debounced)
                        }}
                        className={cn(
                            'w-full pl-10 pr-10 py-2.5 rounded-xl text-sm',
                            'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700',
                            'focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent',
                            'placeholder:text-slate-400 transition-all'
                        )}
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700"
                        >
                            <X className="w-4 h-4 text-slate-400" />
                        </button>
                    )}
                </div>

                {/* Type Filter Pills */}
                <div className="flex flex-wrap gap-2 pb-1">
                    <button
                        onClick={() => browser.setTypeFilter(null)}
                        className={cn(
                            'px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-all',
                            !browser.typeFilter
                                ? 'bg-blue-500 text-white shadow-md'
                                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        )}
                    >
                        All Types
                    </button>
                    {entityTypes.map(type => (
                        <button
                            key={type}
                            onClick={() => browser.setTypeFilter(browser.typeFilter === type ? null : type)}
                            className={cn(
                                'px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-all flex items-center gap-1.5',
                                browser.typeFilter === type
                                    ? 'text-white shadow-md'
                                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                            )}
                            style={browser.typeFilter === type ? { backgroundColor: entityVisualMap[type.toLowerCase()]?.color ?? '#94a3b8' } : {}}
                        >
                            {(() => {
                                const vis = entityVisualMap[type.toLowerCase()]
                                const Cmp = vis?.icon ? (LucideIcons as Record<string, any>)[vis.icon] : null
                                return Cmp ? <Cmp className="w-3 h-3" /> : <Box className="w-3 h-3" />
                            })()}
                            {type}
                        </button>
                    ))}
                </div>
            </div>

            {/* Selection Toolbar */}
            <AnimatePresence>
                {selectedIds.size > 0 && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/30 dark:to-indigo-900/30 border-b border-blue-100 dark:border-blue-800">
                            <span className="text-sm font-semibold text-blue-700 dark:text-blue-300">
                                {selectedIds.size} selected
                            </span>

                            <div className="flex-1" />

                            {selectedIds.size === 1 && (
                                <button
                                    onClick={handleSelectAllChildren}
                                    className="text-xs px-3 py-1.5 bg-white dark:bg-slate-800 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                                >
                                    Select all children
                                </button>
                            )}

                            <select
                                className="text-sm bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-700 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
                                defaultValue=""
                                onChange={e => {
                                    if (e.target.value === '__unassign__') {
                                        handleBulkAssign('')
                                    } else if (e.target.value) {
                                        handleBulkAssign(e.target.value)
                                    }
                                    e.target.value = ''
                                }}
                            >
                                <option value="">Assign to layer...</option>
                                {layers.map(layer => (
                                    <option key={layer.id} value={layer.id}>
                                        {layer.name}
                                    </option>
                                ))}
                                <option value="__unassign__">Remove assignment</option>
                            </select>

                            <button
                                onClick={() => setSelectedIds(new Set())}
                                className="p-1.5 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors"
                            >
                                <X className="w-4 h-4 text-blue-500" />
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Virtualized Tree */}
            <div
                ref={parentRef}
                className="flex-1 overflow-auto px-2 py-2"
            >
                {flattenedNodes.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-40 text-slate-400">
                        <Search className="w-10 h-10 mb-2 opacity-50" />
                        <p className="text-sm font-medium">No entities found</p>
                        <p className="text-xs mt-1 text-center max-w-[260px] text-slate-500">
                            The graph may be empty or entity types may not match the schema.
                        </p>
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
                    <div
                        style={{
                            height: `${rowVirtualizer.getTotalSize()}px`,
                            width: '100%',
                            position: 'relative'
                        }}
                    >
                        {rowVirtualizer.getVirtualItems().map(virtualRow => {
                            const node = flattenedNodes[virtualRow.index]

                            // "Load more" sentinel row
                            if ('isLoadMore' in node && node.isLoadMore) {
                                const parentId = 'parentId' in node ? node.parentId : undefined
                                const isLoadingMore = browser.loadingNodes.has(parentId ?? '__roots')
                                return (
                                    <div
                                        key={node.id}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            width: '100%',
                                            height: `${virtualRow.size}px`,
                                            transform: `translateY(${virtualRow.start}px)`
                                        }}
                                    >
                                        <button
                                            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors disabled:opacity-50"
                                            style={{ paddingLeft: `${(node.depth ?? 0) * 20 + 32}px` }}
                                            onClick={() => parentId ? browser.loadMoreChildren(parentId) : browser.loadMoreRoots()}
                                            disabled={isLoadingMore}
                                        >
                                            {isLoadingMore
                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                : <ChevronRight className="w-3.5 h-3.5" />
                                            }
                                            {isLoadingMore ? 'Loading...' : 'Load more'}
                                        </button>
                                    </div>
                                )
                            }

                            return (
                                <div
                                    key={node.id}
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        height: `${virtualRow.size}px`,
                                        transform: `translateY(${virtualRow.start}px)`
                                    }}
                                >
                                    <TreeRow
                                        node={node as FlatNode}
                                        layers={layers}
                                        searchQuery={searchQuery}
                                        entityVisualMap={entityVisualMap}
                                        childAllocations={childAllocationMap.get(node.id)}
                                        onToggle={handleToggle}
                                        onSelect={handleSelect}
                                        onAssign={handleAssign}
                                        onDragStart={handleDragStart}
                                        onDragEnd={handleDragEnd}
                                        isDragging={draggingNode?.id === node.id}
                                        isNodeLoading={browser.loadingNodes.has(node.id)}
                                    />
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-slate-200/60 dark:border-slate-700/60 bg-white/30 dark:bg-slate-900/30">
                <p className="text-xs text-slate-500">
                    Tip: Shift+click for range select • Cmd+click for multi-select • Drag to layers
                </p>
            </div>
        </div>
    )
}

export default WizardAssignmentTree
