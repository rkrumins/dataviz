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
    Filter,
    CornerDownRight,
    Info,
    Loader2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    useAssignmentConflicts,
    useEffectiveAssignments
} from '@/store/referenceModelStore'
import type { ViewLayerConfig, LayerAssignmentEntry, AssignmentConflict } from '@/types/schema'
import { useContainmentEdgeTypes, useEntityTypes, useSchemaIsLoading } from '@/store/schema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { ActiveTarget } from '@/components/views/LayerHierarchyPanel'

import { useEntityBrowser } from '@/hooks/useEntityBrowser'
import { useLoadingToast } from '@/components/ui/toast'


// ============================================
// Types
// ============================================

export interface EntityTreeNode {
    id: string
    urn: string
    name: string
    type: string
    childCount: number
    /** False when childCount is only a floor (server gave no count) — render "N+". */
    childCountExact: boolean
    children: EntityTreeNode[]
    depth: number
    parentId?: string
    assignedLayerId?: string
    isInherited?: boolean
    hasConflict?: boolean
    conflictMessage?: string
}

/** One entry of the published browser directory — enough identity for any
 *  consumer (left panel, Magic Map) to render a node it hasn't fetched itself. */
export interface BrowserSnapshotEntry {
    name: string
    type: string
    childCount: number
}

/** Live snapshot of everything the entity browser has loaded. Published via
 *  `onBrowserSnapshot` so sibling panels resolve names/children from the SAME
 *  data the tree shows — never from the (empty-in-wizard) canvas store. */
export interface BrowserSnapshot {
    directory: Map<string, BrowserSnapshotEntry>
    topLevelIds: string[]
    topLevelTotalCount: number
    topLevelHasMore: boolean
    /** Fully paginate the top level (stable identity — safe to hold). */
    loadAllTopLevel: () => Promise<void>
}

interface WizardAssignmentTreeProps {
    /** Layers to assign to */
    layers: ViewLayerConfig[]
    /** Canonical flattened urn -> layer assignment map (the wizard's live buffer). */
    assignments?: Record<string, LayerAssignmentEntry>
    /** Active drop target from the Layer Studio (shows strip indicator) */
    activeTarget?: ActiveTarget | null
    /** Callback when assignment changes */
    onAssignmentChange?: (entityId: string, layerId: string | null) => void
    /** Callback for bulk assignment */
    onBulkAssign?: (layerId: string, entityIds: string[]) => void
    /** Callback when the containment parentMap changes (for AssignmentStep inheritance) */
    onParentMapChange?: (map: Map<string, string>) => void
    /** Publishes the browser's loaded directory + top-level state (see BrowserSnapshot). */
    onBrowserSnapshot?: (snapshot: BrowserSnapshot) => void
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
    /** An ancestor is selected — this row comes along automatically. */
    isCoveredByParent?: boolean
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
    isCoveredByParent,
    onToggle,
    onSelect,
    onAssign,
    onDragStart,
    onDragEnd,
    isDragging,
    isNodeLoading
}: TreeRowProps) {
    const hasChildren = node.childCount > 0 || node.children.length > 0
    // "200" when the server counted them; "50+" when all we know is what we hold.
    const childCountLabel = node.childCountExact
        ? node.childCount.toLocaleString()
        : `${(node.childCount || node.children.length).toLocaleString()}+`
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
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-xl transition-colors duration-150 group cursor-pointer',
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
                        transition={{ duration: 0.12 }}
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
                <span
                    className="text-xs px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 rounded-full flex-shrink-0 tabular-nums"
                    title={node.childCountExact
                        ? `${node.childCount.toLocaleString()} children`
                        : `At least ${node.childCount || node.children.length} children — the server didn’t report a total`}
                >
                    {childCountLabel}
                </span>
            )}

            {/* Covered-by-parent: this row inherits its ancestor's placement, so
                the user doesn't need to (and shouldn't) place it separately. */}
            {isCoveredByParent && !node.isSelected && (
                <span
                    className="hidden sm:inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700/60 text-slate-500 dark:text-slate-400 flex-shrink-0"
                    title="Its parent is selected — this entity comes with it"
                >
                    <CornerDownRight className="w-2.5 h-2.5" />
                    included
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
                        data-testid="assigned-layer-badge"
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
    assignments,
    onAssignmentChange,
    onBulkAssign,
    onParentMapChange,
    onBrowserSnapshot,
    className
}: WizardAssignmentTreeProps) {
    // ── API-driven Entity Browser (replaces canvas store + useGraphHydration) ──
    // The browser now queries GET /nodes/top-level, so we no longer need to
    // pass a list of "root entity types" — the server defines top-level
    // structurally (no incoming containment edge). Orphan instances of
    // non-root types surface automatically.
    const provider = useGraphProvider()
    const containmentEdgeTypes = useContainmentEdgeTypes()
    const entityTypeDefinitions = useEntityTypes()
    const isSchemaLoading = useSchemaIsLoading()

    const browser = useEntityBrowser({
        provider,
        containmentEdgeTypes,
        entityTypeDefinitions,
        enabled: !isSchemaLoading,
    })
    useLoadingToast('wizard-entities', browser.isLoading, 'Loading entities')
    useLoadingToast('wizard-schema', isSchemaLoading, 'Loading schema')

    // Load top-level entities from API when schema is ready.
    useEffect(() => {
        if (!isSchemaLoading && entityTypeDefinitions.length > 0) {
            browser.loadTopLevel()
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSchemaLoading, entityTypeDefinitions.length])

    // Propagate parentMap changes to AssignmentStep for containment inheritance
    useEffect(() => {
        onParentMapChange?.(browser.parentMap)
    }, [browser.parentMap, onParentMapChange])

    // Publish the loaded directory + top-level state so sibling panels
    // (Layers & Groups, Magic Map) resolve identity from the browser's data.
    const { loadAllTopLevel } = browser
    useEffect(() => {
        if (!onBrowserSnapshot) return
        const directory = new Map<string, BrowserSnapshotEntry>()
        browser.nodes.forEach((entry, urn) => {
            directory.set(urn, {
                name: entry.node.displayName,
                type: entry.node.entityType,
                childCount: entry.totalChildren,
            })
        })
        onBrowserSnapshot({
            directory,
            topLevelIds: browser.topLevelIds,
            topLevelTotalCount: browser.topLevelTotalCount,
            topLevelHasMore: browser.topLevelHasMore,
            loadAllTopLevel,
        })
    }, [
        onBrowserSnapshot,
        browser.nodes,
        browser.topLevelIds,
        browser.topLevelTotalCount,
        browser.topLevelHasMore,
        loadAllTopLevel,
    ])

    // Store hooks (assignment-related — read-only; the tree never writes to the
    // store, it communicates assignment changes ONLY via onAssignmentChange/onBulkAssign).
    const effectiveAssignments = useEffectiveAssignments()
    const conflicts = useAssignmentConflicts()

    // The wizard's canonical assignments buffer (formData.assignments), keyed
    // by urn — same shape/precedence the canvas resolves from.
    const manualAssignmentMap = useMemo(() => {
        const map = new Map<string, string>()
        Object.entries(assignments ?? {}).forEach(([urn, entry]) => {
            map.set(urn, entry.layerId)
        })
        return map
    }, [assignments])

    // Local UI state
    const [searchQuery, setSearchQuery] = useState('')
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [draggingNode, setDraggingNode] = useState<EntityTreeNode | null>(null)
    /** "Unassigned only" — hides every node whose effective layer resolves
     *  (explicit OR inherited: an inherited child is, correctly, assigned). */
    const [hideAssigned, setHideAssigned] = useState(false)
    const [selectAllBusy, setSelectAllBusy] = useState(false)

    const parentRef = useRef<HTMLDivElement>(null)
    const searchInputRef = useRef<HTMLInputElement>(null)

    // Build entity tree from API-driven browser data (ontology-hierarchical).
    // Type filter is a pure frontend visibility filter using ontology canContain chains.
    const pathTypes = useMemo(
        () => browser.typeFilter ? browser.typesOnPathTo(browser.typeFilter) : null,
        [browser.typeFilter, browser.typesOnPathTo]
    )

    // Roots actually displayable at the top level (drops entries whose parent
    // was discovered on a later expand). Shared by the tree and the coverage meter.
    const visibleRootIds = useMemo(
        () => browser.topLevelIds.filter(urn => !browser.parentMap.has(urn)),
        [browser.topLevelIds, browser.parentMap]
    )

    const entityTree = useMemo<EntityTreeNode[]>(() => {
        if (browser.topLevelIds.length === 0) return []

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

            // "Unassigned only": an assigned node drops out together with its
            // subtree (children inherit its layer, so they're assigned too).
            if (hideAssigned && effectiveLayerId) return null

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
                childCountExact: entry.totalIsExact,
                children,
                depth,
                parentId,
                assignedLayerId: effectiveLayerId,
                isInherited,
                hasConflict: !!conflict,
                conflictMessage: conflict?.message,
            }
        }

        // Exclude nodes that have a known parent (from containment edges loaded
        // on expand). These appear in topLevelIds because the initial top-level
        // query pre-dated the expand — once a parent link is discovered they
        // belong as children in the hierarchy, not as roots.
        return visibleRootIds
            .map(urn => buildNode(urn, 0))
            .filter((n): n is EntityTreeNode => n !== null)
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [browser.nodes, browser.topLevelIds, visibleRootIds, browser.typeFilter, pathTypes, conflicts, effectiveAssignments, manualAssignmentMap, hideAssigned])

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

        // Top-level "load more" sentinel
        if (browser.topLevelHasMore) {
            result.push({
                id: '__more:top-level',
                isLoadMore: true as const,
                depth: 0,
            })
        }

        return result
    }, [entityTree, expandedIds, selectedIds, browser.nodes, browser.topLevelHasMore])

    // Virtualization
    const rowVirtualizer = useVirtualizer({
        count: flattenedNodes.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 52,
        overscan: 10
    })

    // ── Auto-load-more ────────────────────────────────────────────────────────
    // A "Load more" sentinel that scrolls into the rendered window fetches its
    // next page by itself — no clicking through 17 pages of an 888-child node.
    // Guarded per (target, cursor) so each page fires exactly once, and it
    // self-limits: once the new rows push the sentinel out of the window, it
    // stops. The explicit button + "Load all" stay for deliberate control.
    const browserRef = useRef(browser)
    browserRef.current = browser
    const autoLoadedRef = useRef<Set<string>>(new Set())
    const virtualItems = rowVirtualizer.getVirtualItems()

    useEffect(() => {
        const b = browserRef.current
        for (const item of virtualItems) {
            const row = flattenedNodes[item.index]
            if (!row || !('isLoadMore' in row) || !row.isLoadMore) continue

            const parentId = 'parentId' in row ? row.parentId : undefined
            const key = parentId ?? '__top-level'
            if (b.loadingNodes.has(key)) continue

            // Cursor identity — advances with every loaded page.
            const cursor = parentId
                ? b.peekNode(parentId)?.nextCursor ?? ''
                : String(b.topLevelIds.length)
            const guard = `${key}:${cursor}`
            if (autoLoadedRef.current.has(guard)) continue
            autoLoadedRef.current.add(guard)

            if (parentId) void b.loadMoreChildren(parentId)
            else void b.loadMoreTopLevel()
        }
    }, [virtualItems, flattenedNodes])

    // ── Coverage ──────────────────────────────────────────────────────────────
    // Top-level coverage is the honest denominator: a top-level node has no
    // parent, so it can only be placed EXPLICITLY (children inherit). Y comes
    // from the server's total, so it doesn't lie while pages are still loading.
    const coverage = useMemo(() => {
        const explicit = assignments ?? {}
        const assignedRoots = visibleRootIds.filter(urn => !!explicit[urn]).length
        const perLayer = new Map<string, number>()
        Object.values(explicit).forEach(a => {
            perLayer.set(a.layerId, (perLayer.get(a.layerId) ?? 0) + 1)
        })
        const loadedRoots = visibleRootIds.length
        const totalRoots = Math.max(browser.topLevelTotalCount, loadedRoots)
        return {
            assignedRoots,
            loadedRoots,
            totalRoots,
            partial: loadedRoots < totalRoots,
            perLayer,
            totalPlacements: Object.keys(explicit).length,
            pct: totalRoots > 0 ? Math.round((assignedRoots / totalRoots) * 100) : 0,
        }
    }, [assignments, visibleRootIds, browser.topLevelTotalCount])

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

    /** Find a node anywhere in the loaded tree (the old code used `.find()` with a
     *  recursive predicate, which returned the top-level ANCESTOR, not the node —
     *  so "select all children" of a nested node grabbed the whole root subtree). */
    const findTreeNode = useCallback((id: string): EntityTreeNode | null => {
        const walk = (nodes: EntityTreeNode[]): EntityTreeNode | null => {
            for (const n of nodes) {
                if (n.id === id) return n
                const hit = walk(n.children)
                if (hit) return hit
            }
            return null
        }
        return walk(entityTree)
    }, [entityTree])

    /** Loaded descendants of a node, in the tree we currently show. */
    const descendantsOf = useCallback((id: string): string[] => {
        const start = findTreeNode(id)
        if (!start) return []
        const out: string[] = []
        const stack = [...start.children]
        while (stack.length > 0) {
            const n = stack.pop()!
            out.push(n.id)
            stack.push(...n.children)
        }
        return out
    }, [findTreeNode])

    /** URNs whose ANCESTOR is selected — they ride along with the parent and must
     *  never be placed separately (that's what flattened the hierarchy before). */
    const coveredByParent = useMemo(() => {
        const covered = new Set<string>()
        if (selectedIds.size === 0) return covered
        const walk = (nodes: EntityTreeNode[], underSelected: boolean) => {
            for (const n of nodes) {
                const isSel = selectedIds.has(n.id)
                if (underSelected && !isSel) covered.add(n.id)
                walk(n.children, underSelected || isSel)
            }
        }
        walk(entityTree, false)
        return covered
    }, [entityTree, selectedIds])

    /**
     * What placing the current selection will actually do.
     *
     * A selected entity whose ancestor is ALSO selected needs no placement of
     * its own — it inherits. Counting that here (and collapsing it at commit
     * time) is what keeps a "parent + its 200 children" selection from turning
     * into 201 flat entries that destroy the hierarchy in the Layers panel.
     */
    const selectionPlan = useMemo(() => {
        if (selectedIds.size === 0) return { placedCount: 0, inheritedCount: 0 }

        const selectedRoots: EntityTreeNode[] = []
        const walk = (nodes: EntityTreeNode[], underSelected: boolean) => {
            for (const n of nodes) {
                const isSel = selectedIds.has(n.id)
                if (isSel && !underSelected) selectedRoots.push(n)
                walk(n.children, underSelected || isSel)
            }
        }
        walk(entityTree, false)

        // Children that come along for the ride: the true subtree size of each
        // placed root (server counts, not just what's loaded).
        const inheritedCount = selectedRoots.reduce((sum, n) => sum + n.childCount, 0)

        return { placedCount: selectedRoots.length, inheritedCount }
    }, [entityTree, selectedIds])

    // Deselecting a parent releases its whole subtree — leaving orphaned child
    // selections behind (the old behaviour) meant the next assignment silently
    // placed entities the user thought they'd just let go of.
    const handleSelect = useCallback((id: string, isMulti: boolean) => {
        setSelectedIds(prev => {
            const isSelected = prev.has(id)
            const subtree = descendantsOf(id)

            if (isMulti) {
                const next = new Set(prev)
                if (isSelected) {
                    next.delete(id)
                    subtree.forEach(cid => next.delete(cid))
                } else {
                    next.add(id)
                }
                return next
            }

            if (prev.size === 1 && isSelected) return new Set()
            return new Set([id])
        })
    }, [descendantsOf])

    // Communicates ONLY via onAssignmentChange/onBulkAssign — no direct store
    // writes. The owner (LayerStudio / AssignmentStepLegacy) does its own
    // containment-conflict check and warning UI before committing.
    const handleAssign = useCallback((entityId: string, layerId: string) => {
        onAssignmentChange?.(entityId, layerId || null)
    }, [onAssignmentChange])

    const handleBulkAssign = useCallback((layerId: string) => {
        const ids = Array.from(selectedIds)
        if (ids.length === 0) return

        if (onBulkAssign) {
            onBulkAssign(layerId, ids)
        } else {
            // Fallback: forward one-by-one via onAssignmentChange (no direct store writes).
            ids.forEach(entityId => onAssignmentChange?.(entityId, layerId || null))
        }

        // Clear selection after bulk action
        setSelectedIds(new Set())
    }, [selectedIds, onBulkAssign, onAssignmentChange])

    // TRUE select-all-children: pages in EVERY remaining child of the selected
    // node BEFORE selecting them — so "select all 200 children" is one click,
    // not four "Load more"s.
    //
    // It uses the ids RETURNED by loadAllChildren rather than re-reading state:
    // React hasn't re-rendered when the await resolves, which is exactly why
    // this used to select nothing on the first click and work on the second.
    //
    // Deliberately does NOT explode *unexpanded* grandchildren: placement
    // inherits down containment, so the parent already covers them, and walking
    // a million-node subtree to tick boxes helps nobody.
    const handleSelectAllChildren = useCallback(async () => {
        if (selectedIds.size !== 1 || selectAllBusy) return
        const rootId = Array.from(selectedIds)[0]

        setSelectAllBusy(true)
        try {
            const childIds = await browser.loadAllChildren(rootId)

            const selected = new Set<string>([rootId, ...childIds])
            // Any descendant the user had already expanded gets completed too,
            // so what they can see is what they get.
            for (const childId of childIds) {
                if (!expandedIds.has(childId)) continue
                const grandChildren = await browser.loadAllChildren(childId)
                grandChildren.forEach(id => selected.add(id))
            }

            setExpandedIds(prev => new Set(prev).add(rootId))
            setSelectedIds(selected)
        } finally {
            setSelectAllBusy(false)
        }
    }, [selectedIds, selectAllBusy, expandedIds, browser])

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
            const target = e.target as HTMLElement | null
            // Never hijack typing — search box, rename inputs, quick-assign selects.
            const isTyping = !!target?.closest?.('input, textarea, select, [contenteditable="true"]')

            if (e.key === '/' && document.activeElement !== searchInputRef.current) {
                e.preventDefault()
                searchInputRef.current?.focus()
                return
            }
            if (e.key === 'Escape') {
                setSelectedIds(new Set())
                searchInputRef.current?.blur()
                return
            }
            // Quick-assign: 1–9 drops the current selection into the Nth layer.
            if (!isTyping && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
                const layer = layers[Number(e.key) - 1]
                if (!layer || selectedIds.size === 0) return
                e.preventDefault()
                handleBulkAssign(layer.id)
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [layers, selectedIds, handleBulkAssign])

    return (
        <div className={cn(
            'flex flex-col h-full rounded-2xl overflow-hidden',
            'bg-gradient-to-br from-slate-50/80 to-slate-100/80',
            'dark:from-slate-900/80 dark:to-slate-800/80',
            'border border-slate-200/60 dark:border-slate-700/60',
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
                            {browser.isLoading ? (
                                <span className="inline-flex items-center gap-1.5">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Loading entities...
                                </span>
                            ) : `${flattenedNodes.length} entities`} • {selectedIds.size} selected
                        </p>
                        {!browser.isLoading && browser.topLevelTotalCount > 0 && (
                            <p className="text-[11px] text-slate-400 mt-0.5">
                                {browser.topLevelMetadata.rootTypeCount} top-level
                                {browser.topLevelMetadata.orphanCount > 0 && (
                                    <>
                                        {' · '}
                                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                                            {browser.topLevelMetadata.orphanCount} orphan
                                        </span>
                                    </>
                                )}
                                {' · '}
                                {browser.topLevelTotalCount} total
                            </p>
                        )}
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

                {/* Coverage — "am I done?" at a glance. Counts TOP-LEVEL nodes,
                    the only ones that must be placed by hand (children inherit). */}
                {coverage.totalRoots > 0 && (
                    <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/60 bg-white/70 dark:bg-slate-900/50 px-3 py-2">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                                {coverage.assignedRoots}
                                <span className="text-slate-400 font-normal"> / {coverage.totalRoots} placed</span>
                            </span>
                            <span
                                className="text-[10px] text-slate-400"
                                title={coverage.partial
                                    ? `${coverage.loadedRoots} of ${coverage.totalRoots} top-level entities loaded — load all to verify coverage`
                                    : 'All top-level entities loaded'}
                            >
                                {coverage.partial ? `${coverage.loadedRoots} loaded` : 'all loaded'}
                            </span>
                            <span className="flex-1" />
                            <span className="text-xs font-semibold tabular-nums text-slate-500 dark:text-slate-400">
                                {coverage.pct}%
                            </span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
                            {layers.map(layer => {
                                const count = coverage.perLayer.get(layer.id) ?? 0
                                if (count === 0) return null
                                const width = (count / coverage.totalRoots) * 100
                                return (
                                    <div
                                        key={layer.id}
                                        className="h-full first:rounded-l-full transition-[width] duration-200"
                                        style={{ width: `${width}%`, backgroundColor: layer.color || '#3b82f6' }}
                                        title={`${layer.name}: ${count}`}
                                    />
                                )
                            })}
                        </div>
                        {coverage.totalPlacements > 0 && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                {layers.map(layer => {
                                    const count = coverage.perLayer.get(layer.id) ?? 0
                                    if (count === 0) return null
                                    return (
                                        <span
                                            key={layer.id}
                                            className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-500 dark:text-slate-400"
                                        >
                                            <span
                                                className="w-2 h-2 rounded-full"
                                                style={{ backgroundColor: layer.color || '#3b82f6' }}
                                            />
                                            {layer.name}
                                            <span className="tabular-nums text-slate-400">{count}</span>
                                        </span>
                                    )
                                })}
                            </div>
                        )}
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
                            'placeholder:text-slate-400 transition-colors duration-150'
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
                            'px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-colors duration-150',
                            !browser.typeFilter
                                ? 'bg-blue-500 text-white shadow-md'
                                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        )}
                    >
                        All Types
                    </button>

                    {/* Unassigned-only — hides anything already placed (explicitly
                        OR by inheritance), so the list becomes a to-do list. */}
                    <button
                        onClick={() => setHideAssigned(v => !v)}
                        title="Show only entities with no layer yet"
                        className={cn(
                            'px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-colors duration-150 flex items-center gap-1.5',
                            hideAssigned
                                ? 'bg-emerald-500 text-white shadow-md'
                                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                        )}
                    >
                        <Filter className="w-3 h-3" />
                        Unassigned only
                    </button>
                    {entityTypes.map(type => (
                        <button
                            key={type}
                            onClick={() => browser.setTypeFilter(browser.typeFilter === type ? null : type)}
                            className={cn(
                                'px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-colors duration-150 flex items-center gap-1.5',
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

            {/* Selection Toolbar — says exactly what a placement will do. */}
            <AnimatePresence>
                {selectedIds.size > 0 && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="px-4 py-3 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/30 dark:to-indigo-900/30 border-b border-blue-100 dark:border-blue-800 space-y-2">
                            <div className="flex items-center gap-3">
                                <span className="text-sm font-semibold text-blue-700 dark:text-blue-300 shrink-0">
                                    {selectedIds.size} selected
                                </span>

                                <div className="flex-1" />

                                {selectedIds.size === 1 && (() => {
                                    const only = Array.from(selectedIds)[0]
                                    const entry = browser.nodes.get(only)
                                    const total = entry?.totalChildren ?? 0
                                    if (total === 0) return null
                                    const label = entry?.totalIsExact ? total.toLocaleString() : `${total}+`
                                    return (
                                        <button
                                            onClick={handleSelectAllChildren}
                                            disabled={selectAllBusy}
                                            title="Tick every child individually — only needed if you want to place them in DIFFERENT layers"
                                            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-white dark:bg-slate-800 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors disabled:opacity-60 shrink-0"
                                        >
                                            {selectAllBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                                            {selectAllBusy ? 'Loading children…' : `Select all ${label} children`}
                                        </button>
                                    )
                                })()}

                                <select
                                    className="text-sm bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-700 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 shrink-0"
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
                                    <option value="">Place in layer…</option>
                                    {layers.map(layer => (
                                        <option key={layer.id} value={layer.id}>
                                            {layer.name}
                                        </option>
                                    ))}
                                    <option value="__unassign__">Remove from layer</option>
                                </select>

                                <button
                                    onClick={() => setSelectedIds(new Set())}
                                    title="Clear selection"
                                    className="p-1.5 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors shrink-0"
                                >
                                    <X className="w-4 h-4 text-blue-500" />
                                </button>
                            </div>

                            {/* The placement contract, spelled out — this is the rule that
                                used to bite people: children follow their parent, so placing
                                a parent is enough, and a child cannot live in another layer. */}
                            <div className="flex items-start gap-1.5 text-[11px] text-blue-700/80 dark:text-blue-300/80">
                                <Info className="w-3 h-3 mt-0.5 shrink-0" />
                                <span>
                                    {selectionPlan.inheritedCount > 0 ? (
                                        <>
                                            Placing <strong>{selectionPlan.placedCount}</strong>{' '}
                                            {selectionPlan.placedCount === 1 ? 'entity' : 'entities'} —{' '}
                                            <strong>{selectionPlan.inheritedCount.toLocaleString()}</strong>{' '}
                                            {selectionPlan.inheritedCount === 1 ? 'child follows' : 'children follow'} automatically,
                                            keeping the hierarchy intact.
                                        </>
                                    ) : (
                                        <>Children always follow their parent’s layer. To split them up, place the children themselves.</>
                                    )}
                                </span>
                            </div>
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
                    (browser.isLoading || isSchemaLoading) ? (
                        <div className="flex flex-col items-center justify-center h-40 text-slate-400">
                            <Loader2 className="w-8 h-8 mb-3 animate-spin text-blue-500/60" />
                            <p className="text-sm font-medium text-slate-500">Loading entities...</p>
                        </div>
                    ) : (
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
                    )
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

                            // "Load more" sentinel row — auto-fires when scrolled
                            // into view; "Load all N" pages in the whole remainder.
                            if ('isLoadMore' in node && node.isLoadMore) {
                                const parentId = 'parentId' in node ? node.parentId : undefined
                                const isLoadingMore = browser.loadingNodes.has(parentId ?? '__top-level')
                                const entry = parentId ? browser.nodes.get(parentId) : undefined
                                // Only claim a remaining COUNT when we actually know the total
                                // (see BrowserNode.totalIsExact — a paged response's
                                // totalChildren is a heuristic, not a count).
                                const remaining = parentId
                                    ? (entry?.totalIsExact
                                        ? Math.max(0, entry.totalChildren - entry.childIds.length)
                                        : null)
                                    : Math.max(0, browser.topLevelTotalCount - browser.topLevelIds.length)
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
                                        <div
                                            className="flex items-center gap-1"
                                            style={{ paddingLeft: `${(node.depth ?? 0) * 20 + 32}px` }}
                                        >
                                            <button
                                                className="flex items-center gap-2 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors disabled:opacity-50"
                                                onClick={() => parentId ? browser.loadMoreChildren(parentId) : browser.loadMoreTopLevel()}
                                                disabled={isLoadingMore}
                                            >
                                                {isLoadingMore
                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    : <ChevronRight className="w-3.5 h-3.5" />
                                                }
                                                {isLoadingMore ? 'Loading…' : 'Load more'}
                                            </button>
                                            {(remaining === null || remaining > 0) && (
                                                <button
                                                    className="px-2.5 py-2 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-xl transition-colors disabled:opacity-50"
                                                    onClick={() => parentId ? void browser.loadAllChildren(parentId) : void browser.loadAllTopLevel()}
                                                    disabled={isLoadingMore}
                                                    title="Load every remaining page"
                                                >
                                                    {remaining === null ? 'Load all' : `Load all ${remaining.toLocaleString()}`}
                                                </button>
                                            )}
                                        </div>
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
                                        isCoveredByParent={coveredByParent.has(node.id)}
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
                    Tip: Shift+click for range select • Cmd+click for multi-select • Drag to layers •{' '}
                    <kbd className="px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[10px] font-medium">1</kbd>
                    –
                    <kbd className="px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[10px] font-medium">9</kbd>
                    {' '}assigns the selection to that layer
                </p>
            </div>

        </div>
    )
}

export default WizardAssignmentTree
