/**
 * LayerHierarchyPanel
 *
 * Left pane of the Layer Studio.
 * Every layer row AND every logical node works as a real HTML5 drop target.
 * Dragging an entity (or multi-select group) from WizardAssignmentTree onto any
 * layer/group triggers the onDrop callback, which routes the assignment.
 *
 * Features:
 * - Drag-to-reorder layers (framer-motion Reorder)
 * - Inline add / rename / delete logical nodes
 * - HTML5 drop zones on layers AND nodes — onDragOver highlights, onDrop assigns
 * - Active click-based target (also updated on drag-hover)
 * - Entity count badges per layer / node
 * - Collapse/expand per node
 */

import { useContext, useState, useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import {
    ChevronRight,
    ChevronDown,
    Plus,
    Trash2,
    Pencil,
    GripVertical,
    Folder,
    FolderOpen,
    Layers,
    FolderPlus,
    FolderInput,
    ArrowRightLeft,
    Ungroup,
    Box,
    Eraser,
    Loader2,
    X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PlacedTag } from '@/components/ui/PlacedTag'
import { PlacementPathsContext } from './placementPathsContext'
import { groupSubtreeIds, listGroups } from '@/components/canvas/context-view/layerMutations'
import type {
    ViewLayerConfig, LogicalNodeConfig, EntityAssignmentConfig, LayerAssignmentEntry,
    LayerNodeSortMode, LayerNodeSortAlgo,
} from '@/types/schema'
import { LayerSortMenu } from '@/components/canvas/context-view/LayerSortMenu'


/** Rows a column draws before it offers to show more. The rail is a 300px
 *  authoring aid, not the canvas — a long column is scrolled past, not read. */
const RAIL_PAGE = 50

/** An anchored column's unloaded remainder. `remaining` is `null` when the
 *  server has more but its size isn't known — said as "more", never as zero.
 *  `failed`: the last page request failed; the row offers a retry. */
export interface AnchorMore {
    anchorUrn: string
    remaining: number | null
    failed: boolean
}

/**
 * Fetch more when the row DWELLS in view (300ms), once per `latchKey` — which
 * the caller ties to what the column holds and shows, so it re-fires only after
 * something landed. Off while `enabled` is false (in flight, failed, nothing
 * left). The observer is rooted in the rail's own scroller. Same guards that
 * ended the historical load-more pump (see LoadMoreItem).
 */
function useAutoMore(
    ref: RefObject<HTMLElement | null>,
    latchKey: string,
    enabled: boolean,
    fire: () => void,
) {
    const firedRef = useRef<string | null>(null)
    const fireRef = useRef(fire)
    useEffect(() => { fireRef.current = fire }, [fire])
    useEffect(() => {
        if (!enabled) return
        const el = ref.current
        if (!el || typeof IntersectionObserver === 'undefined') return
        let dwell: ReturnType<typeof setTimeout> | null = null
        const io = new IntersectionObserver(([entry]) => {
            if (!entry?.isIntersecting) {
                if (dwell !== null) { clearTimeout(dwell); dwell = null }
                return
            }
            if (firedRef.current === latchKey) return
            dwell = setTimeout(() => {
                dwell = null
                firedRef.current = latchKey
                fireRef.current()
            }, 300)
        }, { root: el.closest('.overflow-y-auto'), rootMargin: '120px' })
        io.observe(el)
        return () => {
            io.disconnect()
            if (dwell !== null) clearTimeout(dwell)
        }
    }, [ref, latchKey, enabled])
}
import type { UseLogicalNodesReturn } from '@/hooks/useLogicalNodes'
import { useEntityTypes } from '@/store/schema'
import {
    fallbackNameFromUrn,
    WIZARD_CHILDREN_PAGE_SIZE,
    type WizardEntityIndex,
} from '@/components/views/ViewWizard/useWizardEntityIndex'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActiveTarget {
    layerId: string
    nodeId?: string
    label: string
}

export interface DropPayload {
    entityId?: string
    entityIds?: string[]
}

/** Entity placement derived from the canonical `assignments` map for a single
 *  layer — just the identity + optional logical-node scoping the list/badge
 *  rendering needs. */
type LayerEntityRef = Pick<EntityAssignmentConfig, 'entityId' | 'logicalNodeId'>

/** One root of a column, as the canvas will render it. Ordered by the Studio
 *  with the canvas's own comparators — the rail must not re-sort. */
export interface LayerRootRow {
    id: string
    urn: string
    name: string
    typeId: string
    childCount: number
    /** Placed by the layer's `entityTypes` rule, so it holds no assignment. */
    rulePlaced: boolean
}

interface LayerHierarchyPanelProps {
    layers: ViewLayerConfig[]
    /** Canonical urn-keyed assignment map (formData.assignments) — source of truth
     *  for per-layer/per-node entity lists and count badges; layer.entityAssignments
     *  is deprecated and no longer written. */
    assignments: Record<string, LayerAssignmentEntry>
    /** layerId -> the column's roots, already ordered. Includes rule-placed rows
     *  (which hold no assignment entry), so the rail is honest about what the
     *  canvas will render — see ViewWizard/effectivePlacement.ts. */
    rootsByLayer?: Map<string, LayerRootRow[]>
    /** View-wide default sort, for the per-column menu's "View default" item. */
    defaultNodeSortMode?: LayerNodeSortAlgo
    onSetLayerSortMode?: (layerId: string, mode: LayerNodeSortMode | null) => void
    onApplySortToView?: (mode: LayerNodeSortAlgo) => void
    onResetCustomOrder?: (layerId: string) => void
    /** Drop one root before/after another inside the same column. */
    onReorderRoot?: (layerId: string, draggedUrn: string, targetUrn: string, position: 'before' | 'after') => void
    /** layerId -> an anchored column's unloaded remainder, mirroring the canvas. */
    anchorMoreByLayer?: Map<string, AnchorMore>
    onLoadMoreAnchor?: (anchorUrn: string) => void
    activeTarget: ActiveTarget | null
    logicalNodes: UseLogicalNodesReturn
    /** Resolves assigned-entity identity + children. The wizard has no canvas
     *  store, so names/children MUST come from the entity browser's data. */
    entityIndex: WizardEntityIndex
    /** Called when user clicks OR drags onto a layer/node — becomes the active target */
    onSetActiveTarget: (target: ActiveTarget) => void
    /** Called when entities are dropped onto a layer or logical node */
    onDrop: (layerId: string, nodeId: string | undefined, payload: DropPayload) => void
    /** Called when user clicks the X button on an assigned entity */
    onUnassign: (entityId: string) => void
    onReorderLayers: (layerIds: string[]) => void
    /** Layer CRUD — routed through the Studio so undo/redo stays one history. */
    onAddLayer: (name: string) => void
    onRenameLayer: (layerId: string, name: string) => void
    onDeleteLayer: (layerId: string) => void
    /** Empty a layer without deleting it. */
    onClearLayer: (layerId: string) => void
    /** Drag-to-resize the rail (long names + deep nesting need room). */
    onStartResize?: (e: React.PointerEvent) => void
    isResizing?: boolean
    className?: string
}

// ─── Parse drop transfer data ─────────────────────────────────────────────────

function parseTransfer(e: React.DragEvent): DropPayload | null {
    try {
        const raw = e.dataTransfer.getData('application/x-entity-assignment')
        if (!raw) return null
        return JSON.parse(raw) as DropPayload
    } catch {
        return null
    }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Past this depth we stop indenting: the guide rail still shows nesting, but a
 *  deeply-nested name keeps its width instead of being crushed to "acc…". */
const MAX_INDENT_DEPTH = 6

// ─── Inline Text Input ────────────────────────────────────────────────────────

function InlineInput({
    defaultValue = '',
    placeholder = 'Group name…',
    onConfirm,
    onCancel,
}: {
    defaultValue?: string
    placeholder?: string
    onConfirm: (value: string) => void
    onCancel: () => void
}) {
    const [value, setValue] = useState(defaultValue)

    return (
        <input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
                if (e.key === 'Enter' && value.trim()) onConfirm(value.trim())
                if (e.key === 'Escape') onCancel()
                e.stopPropagation()
            }}
            onBlur={() => {
                if (value.trim()) onConfirm(value.trim())
                else onCancel()
            }}
            className={cn(
                'flex-1 min-w-0 bg-transparent border-b border-blue-400 outline-none',
                'text-sm text-slate-800 dark:text-white placeholder:text-slate-400',
                'py-0.5'
            )}
        />
    )
}

// ─── Assigned Entity Item ─────────────────────────────────────────────────────

function AssignedEntityItem({
    entityId,
    depth,
    entityIndex,
    onUnassign,
    inherited = false,
    rulePlaced = false,
    onReorder,
}: {
    entityId: string
    depth: number
    entityIndex: WizardEntityIndex
    onUnassign: (entityId: string) => void
    /** Descendant shown under its assigned ancestor — it inherits the layer, so
     *  it is read-only here (no unassign, no drag: moving it would violate the
     *  containment rule the Studio already enforces). */
    inherited?: boolean
    /** Placed by this layer's `entityTypes` rule, not by an assignment entry.
     *  There is no entry to remove, so no unassign — but it stays DRAGGABLE:
     *  dropping it on another layer writes the explicit override. */
    rulePlaced?: boolean
    /** Present on column roots: dropping another root on this row's top/bottom
     *  third reorders instead of re-assigning. Absent on inherited children,
     *  which have no independent position. */
    onReorder?: (draggedUrn: string, targetUrn: string, position: 'before' | 'after') => void
}) {
    // Which third of the row the pointer is over: the outer thirds reorder, the
    // middle falls through to the LAYER's drop handler (move to this column).
    const [band, setBand] = useState<'before' | 'after' | null>(null)
    /** The row's own header, so drop bands measure it and not its whole subtree. */
    const rowRef = useRef<HTMLDivElement | null>(null)
    const [isExpanded, setIsExpanded] = useState(false)

    // Identity + children come from the entity browser's data (via the wizard
    // entity index) — NOT the canvas store, which is empty inside the wizard
    // and used to make every assigned row render as a raw URN fragment.
    const identity = entityIndex.resolve(entityId)
    const dataPath = useContext(PlacementPathsContext).get(entityId)
    const isNodeLoading = entityIndex.isLoading(entityId)
    const childrenIds = entityIndex.childrenOf(entityId)

    const isResolving = identity === undefined
    const name = identity?.name ?? fallbackNameFromUrn(entityId)
    const type = identity?.type ?? 'unknown'
    const childCount = identity?.childCount ?? childrenIds.length
    const hasChildren = childCount > 0
    const isMissing = !!identity?.missing

    const handleToggle = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (!isExpanded) void entityIndex.loadChildren(entityId)
        setIsExpanded(v => !v)
    }

    /** Drag an already-assigned entity straight onto another layer/group —
     *  same payload the browser tree emits, so the existing drop targets and
     *  the Studio's move path (assignEntities) handle it unchanged. */
    const handleDragStart = (e: React.DragEvent) => {
        e.stopPropagation()
        e.dataTransfer.setData('application/x-entity-assignment', JSON.stringify({
            entityId,
            entityName: name,
            entityIds: [entityId],
            entityCount: 1,
            primaryEntity: { id: entityId, name, type },
        }))
        e.dataTransfer.effectAllowed = 'move'
    }

    const schemaEntityTypes = useEntityTypes()
    const typeLower = type.toLowerCase()
    const visual = useMemo(
        () => schemaEntityTypes.find(et => et.id.toLowerCase() === typeLower)?.visual,
        [schemaEntityTypes, typeLower]
    )
    const icon = (() => {
        const Cmp = visual?.icon ? (LucideIcons as Record<string, any>)[visual.icon] : null
        return Cmp ? <Cmp className="w-3 h-3" /> : <Box className="w-3 h-3" />
    })()
    const color = visual?.color ?? '#94a3b8'

    const handleDragOver = (e: React.DragEvent) => {
        if (!onReorder || !e.dataTransfer.types.includes('application/x-entity-assignment')) return
        // Measure the HEADER ROW, not the wrapper: the wrapper also contains the
        // expanded children, so on a root with 20 of them its top third reached
        // most of the way down the subtree and a drop over the 3rd child
        // reordered against the parent.
        const rect = (rowRef.current ?? e.currentTarget).getBoundingClientRect()
        const y = e.clientY - rect.top
        const next = y < rect.height * 0.3 ? 'before' : y > rect.height * 0.7 ? 'after' : null
        setBand(next)
        if (next) {
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
        }
    }

    const handleDrop = (e: React.DragEvent) => {
        const position = band
        setBand(null)
        if (!onReorder || !position) return   // middle third — let the layer take it
        const payload = parseTransfer(e)
        const draggedUrn = payload?.entityId ?? payload?.entityIds?.[0]
        if (!draggedUrn) return
        e.preventDefault()
        e.stopPropagation()
        if (draggedUrn !== entityId) onReorder(draggedUrn, entityId, position)
    }

    return (
        <div
            onDragOver={handleDragOver}
            onDragLeave={() => setBand(null)}
            onDrop={handleDrop}
            className="relative"
        >
            {band && (
                <div
                    aria-hidden
                    className={cn(
                        // pointer-events-none is not decoration: this sits ON the
                        // drop target's top/bottom edge, exactly where the cursor
                        // is when the band is showing, and must not take the
                        // dragover out from under it.
                        'absolute inset-x-1 h-0.5 rounded-full bg-blue-500 z-10 pointer-events-none',
                        band === 'before' ? 'top-0' : 'bottom-0',
                    )}
                />
            )}
            <div
                ref={rowRef}
                draggable={!inherited}
                onDragStart={!inherited ? handleDragStart : undefined}
                className={cn(
                    'group/entity flex items-center gap-1.5 pr-2 py-1 rounded-lg transition-colors min-w-0',
                    inherited ? 'cursor-default opacity-80' : 'cursor-grab active:cursor-grabbing',
                    'hover:bg-slate-100 dark:hover:bg-slate-800/50'
                )}
                // Indent is a real element (see the guide rails below), not padding,
                // so a deep name still gets the full remaining width instead of
                // being squeezed into nothing.
                style={{ paddingLeft: `${Math.min(depth, MAX_INDENT_DEPTH) * 12 + 8}px` }}
            >
                {depth > 0 && (
                    <span
                        aria-hidden
                        className="self-stretch w-px shrink-0 bg-slate-200 dark:bg-slate-700/70 mr-0.5"
                    />
                )}
                <div
                    onClick={hasChildren ? handleToggle : undefined}
                    role={hasChildren ? 'button' : undefined}
                    aria-label={hasChildren ? `${isExpanded ? 'Collapse' : 'Expand'} ${name}` : undefined}
                    className={cn(
                        'w-4 h-4 flex items-center justify-center shrink-0',
                        hasChildren ? 'cursor-pointer text-slate-400 hover:text-slate-600 dark:hover:text-slate-200' : ''
                    )}
                >
                    {isNodeLoading ? (
                        <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
                    ) : hasChildren ? (
                        isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
                    ) : null}
                </div>
                <div
                    className="w-4 h-4 flex items-center justify-center rounded shrink-0 text-white shadow-sm"
                    style={{ backgroundColor: color }}
                >
                    {icon}
                </div>
                <div className="flex-1 min-w-0 flex flex-col">
                <div className="min-w-0 flex items-center gap-1">
                    {isResolving ? (
                        <span className="h-2.5 w-24 rounded bg-slate-200 dark:bg-slate-700 animate-pulse" />
                    ) : (
                        <span
                            className={cn(
                                'text-[11px] font-medium truncate',
                                isMissing
                                    ? 'text-slate-400 italic'
                                    : 'text-slate-600 dark:text-slate-300',
                            )}
                            title={isMissing ? `${name} — not found in the graph` : `${name}${entityId ? `\n${entityId}` : ''}`}
                        >
                            {name}
                        </span>
                    )}
                    {hasChildren && !isExpanded && (
                        <span className="text-[9px] text-slate-400 shrink-0" title={`${childCount} children inherit this layer`}>
                            {childCount}
                        </span>
                    )}
                </div>
                {/* Where it sits in the DATA — the same "Placed · Part of …" the canvas shows. An
                    explicitly assigned entity that has a parent is a view placement; the data keeps
                    it inside that parent. */}
                {!inherited && dataPath && dataPath.length > 0 && (
                    <span
                        className="mt-0.5 flex items-center gap-1 min-w-0"
                        title={`Placed here for this view only — the data source is unchanged. In the data, ${name} is part of ${dataPath.map(a => a.displayName).join(' › ')}.`}
                    >
                        <PlacedTag />
                        <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                            Part of {(dataPath.length > 3
                                ? [dataPath[0].displayName, '…', ...dataPath.slice(-2).map(a => a.displayName)]
                                : dataPath.map(a => a.displayName)).join(' › ')}
                        </span>
                    </span>
                )}
                </div>
                {rulePlaced && (
                    <span
                        data-testid="rail-rule-placed-marker"
                        className="text-[9px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 shrink-0"
                        title={`Placed automatically because this layer covers the ${type} type. Drag it to another layer to override.`}
                    >
                        by type
                    </span>
                )}
                {/* Unassign — only the explicit placement can be removed. */}
                {!inherited && !rulePlaced && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onUnassign(entityId)
                        }}
                        className="opacity-0 group-hover/entity:opacity-100 p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-slate-400 hover:text-red-500 shrink-0 transition-all"
                        title="Remove assignment"
                    >
                        <X className="w-3 h-3" />
                    </button>
                )}
            </div>

            <AnimatePresence>
                {isExpanded && childrenIds.length > 0 && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        {childrenIds.map((childId: string) => (
                            <AssignedEntityItem
                                key={childId}
                                entityId={childId}
                                depth={depth + 1}
                                entityIndex={entityIndex}
                                onUnassign={onUnassign}
                                inherited
                            />
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// ─── Logical Node Item ────────────────────────────────────────────────────────

interface LogicalNodeItemProps {
    node: LogicalNodeConfig
    layerId: string
    layerName: string
    layerColor: string
    depth: number
    activeTarget: ActiveTarget | null
    logicalNodes: UseLogicalNodesReturn
    entityAssignments: LayerEntityRef[]
    entityIndex: WizardEntityIndex
    onSetActiveTarget: (target: ActiveTarget) => void
    onDrop: (layerId: string, nodeId: string | undefined, payload: DropPayload) => void
    onUnassign: (entityId: string) => void
}

function LogicalNodeItem({
    node,
    layerId,
    layerName,
    layerColor,
    depth,
    activeTarget,
    logicalNodes,
    entityAssignments,
    entityIndex,
    onSetActiveTarget,
    onDrop,
    onUnassign,
}: LogicalNodeItemProps) {
    const [isRenaming, setIsRenaming] = useState(false)
    const [showAddChild, setShowAddChild] = useState(false)
    const [isDragOver, setIsDragOver] = useState(false)
    // The same group actions the canvas offers (one set of operations — see useLogicalNodes).
    const [groupMode, setGroupMode] = useState<null | 'move' | 'contents' | 'confirmDelete'>(null)
    const layerGroups = [{ id: layerId, logicalNodes: logicalNodes.nodesForLayer(layerId) }] as unknown as ViewLayerConfig[]
    const ownSubtree = new Set(groupSubtreeIds(layerGroups, layerId, node.id))
    const moveTargets = listGroups(layerGroups, layerId).filter(g => !ownSubtree.has(g.id))

    const isActive = activeTarget?.layerId === layerId && activeTarget?.nodeId === node.id
    const isCollapsed = node.collapsed ?? false
    // Get actual assigned identities
    const assignedEntities = entityAssignments.filter(a => a.logicalNodeId === node.id).map(a => a.entityId)
    const assignedCount = assignedEntities.length
    const hasChildren = !!(node.children && node.children.length > 0) || assignedCount > 0

    // Build the display label for this node's path
    const pathLabel = `${layerName} › ${logicalNodes.nodePathLabel(layerId, node.id)}`

    // ── Drop zone handlers ────────────────────────────────────────────────────

    const handleDragOver = useCallback((e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('application/x-entity-assignment')) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setIsDragOver(true)
        // Auto-activate this node as target on hover
        onSetActiveTarget({ layerId, nodeId: node.id, label: pathLabel })
    }, [layerId, node.id, pathLabel, onSetActiveTarget])

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        // Only clear if leaving this element entirely (not moving to a child)
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragOver(false)
        }
    }, [])

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragOver(false)
        const payload = parseTransfer(e)
        if (!payload) return
        onDrop(layerId, node.id, payload)
    }, [layerId, node.id, onDrop])

    return (
        <div>
            <motion.div
                layout
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
                className={cn(
                    'group flex items-center gap-1.5 px-2 py-2 rounded-xl cursor-pointer',
                    'transition-all duration-150 border-2',
                    isDragOver
                        ? 'border-blue-400 bg-blue-100/80 dark:bg-blue-900/40 scale-[1.01] shadow-md shadow-blue-200 dark:shadow-blue-900/50'
                        : isActive
                            ? 'border-blue-300/60 bg-blue-50/60 dark:bg-blue-900/20 shadow-sm'
                            : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-700/60'
                )}
                onClick={() => onSetActiveTarget({ layerId, nodeId: node.id, label: pathLabel })}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {/* Collapse toggle */}
                <button
                    onClick={e => {
                        e.stopPropagation()
                        logicalNodes.toggleCollapse(layerId, node.id)
                    }}
                    className="w-4 h-4 flex items-center justify-center text-slate-400 shrink-0"
                >
                    {hasChildren
                        ? isCollapsed
                            ? <ChevronRight className="w-3 h-3" />
                            : <ChevronDown className="w-3 h-3" />
                        : null}
                </button>

                {/* Folder icon */}
                <div className="w-4 h-4 flex items-center justify-center shrink-0" style={{ color: layerColor }}>
                    {hasChildren && !isCollapsed
                        ? <FolderOpen className="w-4 h-4" />
                        : <Folder className="w-4 h-4" />}
                </div>

                {/* Name / rename input */}
                {isRenaming ? (
                    <InlineInput
                        defaultValue={node.name}
                        onConfirm={name => {
                            logicalNodes.renameNode(layerId, node.id, name)
                            setIsRenaming(false)
                        }}
                        onCancel={() => setIsRenaming(false)}
                    />
                ) : (
                    <span
                        className="flex-1 text-sm truncate text-slate-700 dark:text-slate-200"
                        onDoubleClick={e => {
                            e.stopPropagation()
                            setIsRenaming(true)
                        }}
                    >
                        {node.name}
                    </span>
                )}

                {/* Drop indicator badge */}
                {isDragOver && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-blue-500 text-white rounded-full shrink-0 font-medium animate-pulse">
                        Drop
                    </span>
                )}

                {/* Assigned count badge */}
                {assignedCount > 0 && !isDragOver && (
                    <span
                        className="text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0"
                        style={{ backgroundColor: layerColor + '20', color: layerColor }}
                    >
                        {assignedCount}
                    </span>
                )}

                {/* Hover action buttons */}
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
                    <button
                        onClick={e => { e.stopPropagation(); setShowAddChild(v => !v) }}
                        className="p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40 text-slate-400 hover:text-blue-500"
                        title="Add sub-group"
                    >
                        <FolderPlus className="w-3 h-3" />
                    </button>
                    <button
                        onClick={e => { e.stopPropagation(); setIsRenaming(true) }}
                        className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400"
                        title="Rename"
                    >
                        <Pencil className="w-3 h-3" />
                    </button>
                    <button
                        onClick={e => { e.stopPropagation(); setGroupMode('move') }}
                        className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400"
                        title={`Move group ${node.name} into another group`}
                        aria-label={`Move group ${node.name}`}
                    >
                        <FolderInput className="w-3 h-3" />
                    </button>
                    <button
                        onClick={e => { e.stopPropagation(); setGroupMode('contents') }}
                        className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400"
                        title={`Move everything in ${node.name} into another group`}
                        aria-label={`Move the contents of ${node.name}`}
                    >
                        <ArrowRightLeft className="w-3 h-3" />
                    </button>
                    <button
                        onClick={e => { e.stopPropagation(); logicalNodes.ungroupNode(layerId, node.id) }}
                        className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400"
                        title={`Ungroup ${node.name} — its contents move up a level`}
                        aria-label={`Ungroup ${node.name}`}
                    >
                        <Ungroup className="w-3 h-3" />
                    </button>
                    <button
                        onClick={e => { e.stopPropagation(); setGroupMode('confirmDelete') }}
                        className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-slate-400 hover:text-red-500"
                        title={`Delete group ${node.name}`}
                        aria-label={`Delete group ${node.name}`}
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </motion.div>

            {/* Move group / move contents / delete — inline, as on the canvas */}
            {groupMode && (
                <div style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }} className="px-2 py-1" onClick={e => e.stopPropagation()}>
                    {groupMode === 'confirmDelete' ? (
                        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 bg-red-50 dark:bg-red-900/20 text-xs text-slate-600 dark:text-slate-300">
                            <span className="flex-1">Delete “{node.name}”? Its entities stay in this layer, ungrouped.</span>
                            <button onClick={() => { logicalNodes.deleteNode(layerId, node.id); setGroupMode(null) }}
                                className="px-2 py-0.5 rounded-md bg-red-500/15 text-red-600 dark:text-red-400 font-semibold hover:bg-red-500/25">Delete</button>
                            <button onClick={() => setGroupMode(null)}
                                className="px-2 py-0.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700">Keep</button>
                        </div>
                    ) : (
                        <select
                            autoFocus
                            defaultValue=""
                            aria-label={groupMode === 'move' ? `Move group ${node.name} into` : `Move everything in ${node.name} into`}
                            onBlur={() => setGroupMode(null)}
                            onKeyDown={e => { if (e.key === 'Escape') setGroupMode(null) }}
                            onChange={e => {
                                const v = e.target.value
                                if (groupMode === 'move') logicalNodes.moveNode(layerId, node.id, v === '__top__' ? undefined : v)
                                else if (v) logicalNodes.moveContents(layerId, node.id, v)
                                setGroupMode(null)
                            }}
                            className="w-full px-2 py-1 rounded-lg text-xs bg-white dark:bg-slate-800 border border-violet-300 dark:border-violet-500/50 text-slate-700 dark:text-slate-200 outline-none"
                        >
                            <option value="" disabled>{groupMode === 'move' ? `Move “${node.name}” into…` : `Move everything in “${node.name}” into…`}</option>
                            {groupMode === 'move' && <option value="__top__">Top level of {layerName}</option>}
                            {moveTargets.map(g => <option key={g.id} value={g.id}>{g.path}</option>)}
                        </select>
                    )}
                </div>
            )}

            {/* Add child inline input */}
            <AnimatePresence>
                {showAddChild && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
                        className="px-2 py-1"
                    >
                        <div className="flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-2 py-1.5">
                            <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                            <InlineInput
                                placeholder="Sub-group name…"
                                onConfirm={name => {
                                    logicalNodes.addNode(layerId, name, node.id)
                                    setShowAddChild(false)
                                }}
                                onCancel={() => setShowAddChild(false)}
                            />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Children & Assigned Entities */}
            {!isCollapsed && (
                <AnimatePresence>
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        {node.children && node.children.length > 0 && (
                            <div className="space-y-0.5">
                                {node.children.map(child => (
                                    <LogicalNodeItem
                                        key={child.id}
                                        node={child}
                                        layerId={layerId}
                                        layerName={layerName}
                                        layerColor={layerColor}
                                        depth={depth + 1}
                                        activeTarget={activeTarget}
                                        logicalNodes={logicalNodes}
                                        entityAssignments={entityAssignments}
                                        entityIndex={entityIndex}
                                        onSetActiveTarget={onSetActiveTarget}
                                        onDrop={onDrop}
                                        onUnassign={onUnassign}
                                    />
                                ))}
                            </div>
                        )}
                        {assignedEntities.length > 0 && (
                            <div className="mt-1">
                                {assignedEntities.map(entityId => (
                                    <AssignedEntityItem
                                        key={entityId}
                                        entityId={entityId}
                                        depth={depth + 1}
                                        entityIndex={entityIndex}
                                        onUnassign={onUnassign}
                                    />
                                ))}
                            </div>
                        )}
                    </motion.div>
                </AnimatePresence>
            )}
        </div>
    )
}

// ─── Layer Row (drag-to-reorder + drop zone) ──────────────────────────────────

interface LayerRowProps {
    layer: ViewLayerConfig
    /** 0-based position — surfaces the 1–9 quick-assign shortcut. */
    layerIndex: number
    assignments: Record<string, LayerAssignmentEntry>
    /** This column's roots, already ordered by the Studio. */
    rows?: LayerRootRow[]
    defaultNodeSortMode?: LayerNodeSortAlgo
    onSetLayerSortMode?: (layerId: string, mode: LayerNodeSortMode | null) => void
    onApplySortToView?: (mode: LayerNodeSortAlgo) => void
    onResetCustomOrder?: (layerId: string) => void
    onReorderRoot?: (layerId: string, draggedUrn: string, targetUrn: string, position: 'before' | 'after') => void
    /** This column's unloaded remainder, when it is anchored. */
    anchorMore?: AnchorMore
    onLoadMoreAnchor?: (anchorUrn: string) => void
    activeTarget: ActiveTarget | null
    logicalNodes: UseLogicalNodesReturn
    entityIndex: WizardEntityIndex
    onSetActiveTarget: (target: ActiveTarget) => void
    onDrop: (layerId: string, nodeId: string | undefined, payload: DropPayload) => void
    onUnassign: (entityId: string) => void
    onRenameLayer: (layerId: string, name: string) => void
    onDeleteLayer: (layerId: string) => void
    onClearLayer: (layerId: string) => void
}

function LayerRow({
    layer,
    layerIndex,
    assignments,
    rows,
    defaultNodeSortMode,
    onSetLayerSortMode,
    onApplySortToView,
    onResetCustomOrder,
    onReorderRoot,
    anchorMore,
    onLoadMoreAnchor,
    activeTarget,
    logicalNodes,
    entityIndex,
    onSetActiveTarget,
    onDrop,
    onUnassign,
    onRenameLayer,
    onDeleteLayer,
    onClearLayer,
}: LayerRowProps) {
    const [isExpanded, setIsExpanded] = useState(true)
    const [showAddRoot, setShowAddRoot] = useState(false)
    const [isDragOver, setIsDragOver] = useState(false)
    const [isRenaming, setIsRenaming] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [confirmClear, setConfirmClear] = useState(false)
    const dragControls = useDragControls()

    const isLayerActive = activeTarget?.layerId === layer.id && !activeTarget?.nodeId
    const nodes = logicalNodes.nodesForLayer(layer.id)
    // Derived from the canonical urn-keyed assignments map — layer.entityAssignments
    // is legacy and no longer written by the wizard's assignment path.
    const layerEntityAssignments: LayerEntityRef[] = useMemo(
        () => Object.entries(assignments)
            .filter(([, entry]) => entry.layerId === layer.id)
            .map(([urn, entry]) => ({ entityId: urn, logicalNodeId: entry.logicalNodeId })),
        [assignments, layer.id]
    )
    // The column's roots in canvas order. Members of a logical group are drawn
    // inside that group instead, so they never appear in this list.
    const groupedIds = useMemo(
        () => new Set(layerEntityAssignments.filter(a => a.logicalNodeId).map(a => a.entityId)),
        [layerEntityAssignments],
    )
    const rootRows = useMemo(() => {
        if (rows) return rows.filter(r => !groupedIds.has(r.urn))
        // No ordered rows supplied — fall back to the canonical assignments, as
        // this panel always did. Identity is resolved per row anyway, so the
        // blank fields here are never rendered.
        return layerEntityAssignments
            .filter(a => !a.logicalNodeId)
            .map<LayerRootRow>(a => ({
                id: a.entityId, urn: a.entityId, name: '', typeId: '', childCount: 0, rulePlaced: false,
            }))
    }, [rows, groupedIds, layerEntityAssignments])
    // "Clear all" only ever removes explicit placements — a rule-placed row has
    // no entry to clear.
    // The rail is ONE scroller wrapping a Reorder.Group of layers, so a column
    // cannot own a virtualized viewport without breaking layer drag-reorder.
    // Render a window instead: a column that holds 50,000 scanned roots draws
    // RAIL_PAGE of them and says how many are left. Bounded either way.
    const [visibleCount, setVisibleCount] = useState(RAIL_PAGE)
    const totalAssigned = layerEntityAssignments.length
    const shownRows = useMemo(() => rootRows.slice(0, visibleCount), [rootRows, visibleCount])
    const heldButHidden = rootRows.length - shownRows.length
    // What the column has yet to show: rows it holds but has not drawn, plus
    // rows the server still has. Both read as "more" to the user. The server's
    // share is `null` when it has more but the count isn't known — said as
    // "more", never as zero.
    const serverRemaining = anchorMore ? anchorMore.remaining : 0
    const remaining = serverRemaining === null ? null : heldButHidden + serverRemaining
    const moreFailed = heldButHidden === 0 && (anchorMore?.failed ?? false)
    const hasMore = heldButHidden > 0 || (!!anchorMore && !anchorMore.failed)
    const anchorLoading = !!anchorMore && entityIndex.isLoading(anchorMore.anchorUrn)
    // How many the next click actually produces: revealing rows we hold is a
    // RAIL_PAGE, fetching the anchor's next page is a WIZARD_CHILDREN_PAGE_SIZE
    // (the wizard index's page — not the canvas's).
    // Naming the wrong one would promise 50 and deliver 100.
    const nextChunk = heldButHidden > 0
        ? Math.min(heldButHidden, RAIL_PAGE)
        : Math.min(serverRemaining ?? WIZARD_CHILDREN_PAGE_SIZE, WIZARD_CHILDREN_PAGE_SIZE)
    const totalShown = rootRows.length + (serverRemaining ?? 0)
    const totalLabel = serverRemaining === null
        ? `${totalShown.toLocaleString()}+`
        : totalShown.toLocaleString()
    const showMore = useCallback(() => {
        if (heldButHidden > 0) setVisibleCount(v => v + RAIL_PAGE)
        else if (anchorMore) onLoadMoreAnchor?.(anchorMore.anchorUrn)
    }, [heldButHidden, anchorMore, onLoadMoreAnchor])
    // Scroll-driven: the row fetches once per growth of what the column holds
    // or shows, never while its page is in flight or failed.
    const moreRowRef = useRef<HTMLButtonElement>(null)
    useAutoMore(moreRowRef, `${rootRows.length}:${visibleCount}`, hasMore && !anchorLoading, showMore)
    const sortMode: LayerNodeSortMode = layer.nodeSortMode ?? defaultNodeSortMode ?? 'alpha-asc'
    const hasCustomOrder = useMemo(
        () => Object.values(assignments).some(e => e.layerId === layer.id && e.orderKey),
        [assignments, layer.id],
    )
    const color = layer.color || '#3b82f6'

    // ── Layer-level drop zone (layer root, no node) ───────────────────────────

    const handleDragOver = useCallback((e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('application/x-entity-assignment')) return
        // Only activate if not already hovering a child node
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setIsDragOver(true)
        onSetActiveTarget({ layerId: layer.id, label: layer.name })
    }, [layer.id, layer.name, onSetActiveTarget])

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragOver(false)
        }
    }, [])

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        setIsDragOver(false)
        const payload = parseTransfer(e)
        if (!payload) return
        onDrop(layer.id, undefined, payload)
    }, [layer.id, onDrop])

    return (
        <Reorder.Item
            value={layer.id}
            dragListener={false}
            dragControls={dragControls}
            className="list-none"
        >
            <div className="mb-1">
                {/* Layer header — the root drop zone */}
                <motion.div
                    layout
                    className={cn(
                        'flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer border-2 transition-all duration-150',
                        isDragOver
                            ? 'border-dashed shadow-lg scale-[1.01]'
                            : isLayerActive
                                ? 'border-transparent shadow-sm'
                                : 'border-transparent hover:bg-slate-100/80 dark:hover:bg-slate-700/50'
                    )}
                    style={
                        isDragOver
                            ? { borderColor: color, backgroundColor: color + '15' }
                            : isLayerActive
                                ? { backgroundColor: color + '10', boxShadow: `0 0 0 2px ${color}30` }
                                : {}
                    }
                    onClick={() => onSetActiveTarget({ layerId: layer.id, label: layer.name })}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                >
                    {/* Drag handle for reordering layers (not entity drag) */}
                    <div
                        className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-400 shrink-0"
                        onPointerDown={e => dragControls.start(e)}
                        // Stop pointer events from triggering the drag system
                        onDragStart={e => e.preventDefault()}
                    >
                        <GripVertical className="w-4 h-4" />
                    </div>

                    {/* Color swatch */}
                    <div
                        className="w-3 h-3 rounded-full shrink-0 shadow-sm ring-2 ring-white dark:ring-slate-900"
                        style={{ backgroundColor: color }}
                    />

                    {/* Layer name (double-click to rename) */}
                    {isRenaming ? (
                        <InlineInput
                            defaultValue={layer.name}
                            placeholder="Layer name…"
                            onConfirm={name => {
                                onRenameLayer(layer.id, name)
                                setIsRenaming(false)
                            }}
                            onCancel={() => setIsRenaming(false)}
                        />
                    ) : (
                        <span
                            className="flex-1 min-w-0 text-sm font-semibold text-slate-800 dark:text-white truncate"
                            title={`${layer.name} — double-click to rename`}
                            onDoubleClick={e => {
                                e.stopPropagation()
                                setIsRenaming(true)
                            }}
                        >
                            {layer.name}
                        </span>
                    )}

                    {/* Drop indicator */}
                    {isDragOver && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-white animate-pulse shrink-0"
                            style={{ backgroundColor: color }}>
                            Drop here
                        </span>
                    )}

                    {/* Quick-assign shortcut hint (matches the tree's 1–9 keys) */}
                    {!isDragOver && layerIndex < 9 && (
                        <kbd
                            className="hidden group-hover:inline-block px-1 py-0.5 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-[9px] font-medium text-slate-400 shrink-0"
                            title={`Press ${layerIndex + 1} to assign the selection to this layer`}
                        >
                            {layerIndex + 1}
                        </kbd>
                    )}

                    {/* Assignment count */}
                    {totalShown > 0 && !isDragOver && (
                        <span
                            data-testid={`layer-count-${layer.id}`}
                            className="text-xs text-slate-400 shrink-0"
                        >{totalLabel}</span>
                    )}

                    {/* Column sort — the canvas's own menu, writing the same
                        fields, so the order chosen here is the order it renders. */}
                    {onSetLayerSortMode && (
                        <span onClick={e => e.stopPropagation()} className="shrink-0">
                            <LayerSortMenu
                                layerName={layer.name}
                                layerColor={color}
                                mode={sortMode}
                                isOverride={layer.nodeSortMode !== undefined}
                                viewDefault={defaultNodeSortMode ?? 'alpha-asc'}
                                canPersist
                                onSelectMode={mode => onSetLayerSortMode(layer.id, mode)}
                                onApplyToView={() => onApplySortToView?.(
                                    sortMode === 'custom' ? 'alpha-asc' : sortMode,
                                )}
                                onResetCustomOrder={hasCustomOrder && onResetCustomOrder
                                    ? () => onResetCustomOrder(layer.id)
                                    : undefined}
                            />
                        </span>
                    )}

                    {/* Layer actions */}
                    <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
                        {totalAssigned > 0 && (
                            <button
                                onClick={e => { e.stopPropagation(); setConfirmClear(true) }}
                                className="p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 text-slate-400 hover:text-amber-600"
                                title={`Remove all ${totalAssigned} placements from ${layer.name}`}
                            >
                                <Eraser className="w-3 h-3" />
                            </button>
                        )}
                        <button
                            onClick={e => { e.stopPropagation(); setIsRenaming(true) }}
                            className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400"
                            title="Rename layer"
                        >
                            <Pencil className="w-3 h-3" />
                        </button>
                        <button
                            onClick={e => {
                                e.stopPropagation()
                                if (totalAssigned > 0) setConfirmDelete(true)
                                else onDeleteLayer(layer.id)
                            }}
                            className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-slate-400 hover:text-red-500"
                            title={`Delete ${layer.name}`}
                        >
                            <Trash2 className="w-3 h-3" />
                        </button>
                    </div>

                    {/* Expand toggle */}
                    <button
                        onClick={e => { e.stopPropagation(); setIsExpanded(v => !v) }}
                        className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 shrink-0"
                    >
                        {isExpanded
                            ? <ChevronDown className="w-4 h-4" />
                            : <ChevronRight className="w-4 h-4" />}
                    </button>
                </motion.div>

                {/* Clear confirmation — empties the layer, keeps the layer. */}
                {confirmClear && (
                    <div className="mt-1 mx-1 px-3 py-2 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
                        <p className="text-[11px] text-amber-800 dark:text-amber-300">
                            Remove all {totalAssigned} {totalAssigned === 1 ? 'placement' : 'placements'} from{' '}
                            <span className="font-semibold">{layer.name}</span>? The layer stays, and this can be undone (⌘Z).
                        </p>
                        <div className="mt-1.5 flex items-center gap-2">
                            <button
                                onClick={e => {
                                    e.stopPropagation()
                                    onClearLayer(layer.id)
                                    setConfirmClear(false)
                                }}
                                className="px-2 py-1 rounded-lg bg-amber-500 text-white text-[11px] font-medium hover:bg-amber-600 transition-colors"
                            >
                                Clear layer
                            </button>
                            <button
                                onClick={e => { e.stopPropagation(); setConfirmClear(false) }}
                                className="px-2 py-1 rounded-lg text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Delete confirmation — deleting a layer also drops its
                    placements, so say so before it happens. */}
                {confirmDelete && (
                    <div className="mt-1 mx-1 px-3 py-2 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
                        <p className="text-[11px] text-red-700 dark:text-red-300">
                            Delete <span className="font-semibold">{layer.name}</span>? {totalAssigned} placement{totalAssigned !== 1 ? 's' : ''} will be unassigned.
                        </p>
                        <div className="mt-1.5 flex items-center gap-2">
                            <button
                                onClick={e => {
                                    e.stopPropagation()
                                    onDeleteLayer(layer.id)
                                    setConfirmDelete(false)
                                }}
                                className="px-2 py-1 rounded-lg bg-red-500 text-white text-[11px] font-medium hover:bg-red-600 transition-colors"
                            >
                                Delete layer
                            </button>
                            <button
                                onClick={e => { e.stopPropagation(); setConfirmDelete(false) }}
                                className="px-2 py-1 rounded-lg text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Nodes + Add Group */}
                <AnimatePresence>
                    {isExpanded && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                        >
                            <div className="mt-1 ml-2 space-y-0.5">
                                {nodes.map(node => (
                                    <LogicalNodeItem
                                        key={node.id}
                                        node={node}
                                        layerId={layer.id}
                                        layerName={layer.name}
                                        layerColor={color}
                                        depth={0}
                                        activeTarget={activeTarget}
                                        logicalNodes={logicalNodes}
                                        entityAssignments={layerEntityAssignments}
                                        entityIndex={entityIndex}
                                        onSetActiveTarget={onSetActiveTarget}
                                        onDrop={onDrop}
                                        onUnassign={onUnassign}
                                    />
                                ))}

                                {/* The column's roots, in the order the canvas draws
                                    them. Drag a row onto another row's top or bottom
                                    edge to rearrange; the middle drops into the layer.
                                    Also drawn with NO rows when the first page failed:
                                    the Retry lives here, and a blank column would look
                                    finished. */}
                                {(rootRows.length > 0 || moreFailed) && (
                                    <div
                                        data-testid={`layer-rows-${layer.id}`}
                                        className="mt-2 space-y-0.5 border-t border-slate-100 dark:border-slate-800 pt-1"
                                    >
                                        <div className="flex items-center gap-1.5 px-3 py-1">
                                            <Layers className="w-3 h-3 text-slate-400 shrink-0" />
                                            <span className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase truncate">
                                                In this column ({totalLabel})
                                            </span>
                                            <span className="flex-1" />
                                            {totalAssigned > 0 && (
                                                <button
                                                    onClick={e => { e.stopPropagation(); setConfirmClear(true) }}
                                                    title={`Remove all ${totalAssigned} placements from ${layer.name} — undoable`}
                                                    className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                                                >
                                                    Clear all
                                                </button>
                                            )}
                                        </div>
                                        {shownRows.map(row => (
                                            <AssignedEntityItem
                                                key={row.urn}
                                                entityId={row.urn}
                                                depth={0}
                                                entityIndex={entityIndex}
                                                onUnassign={onUnassign}
                                                rulePlaced={row.rulePlaced}
                                                onReorder={onReorderRoot
                                                    ? (dragged, target, position) =>
                                                        onReorderRoot(layer.id, dragged, target, position)
                                                    : undefined}
                                            />
                                        ))}
                                        {/* ONE affordance for both kinds of "more":
                                            reveal what this column already holds,
                                            and once it is all on screen, fetch the
                                            anchor's next page. An anchored column
                                            draws no anchor row, so this is also the
                                            only place its paging can live. */}
                                        {(hasMore || moreFailed) && (
                                            <button
                                                ref={moreRowRef}
                                                onClick={e => {
                                                    e.stopPropagation()
                                                    if (!anchorLoading) showMore()
                                                }}
                                                disabled={anchorLoading}
                                                className="w-full text-left px-3 py-1.5 rounded-lg text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors disabled:cursor-wait disabled:opacity-70"
                                            >
                                                {anchorLoading ? 'Loading…'
                                                    : moreFailed ? (
                                                        <>
                                                            Couldn't load the next {WIZARD_CHILDREN_PAGE_SIZE}
                                                            <span className="ml-1 text-slate-400 font-normal">· Retry</span>
                                                        </>
                                                    ) : (
                                                        <>
                                                            Show {nextChunk} more
                                                            {remaining !== null && (
                                                                <span className="ml-1 text-slate-400 font-normal tabular-nums">
                                                                    ({remaining.toLocaleString()} left)
                                                                </span>
                                                            )}
                                                        </>
                                                    )}
                                            </button>
                                        )}
                                    </div>
                                )}

                                {/* Add child group input */}
                                <AnimatePresence>
                                    {showAddRoot && (
                                        <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: 'auto', opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            className="px-2 py-1 ml-4"
                                        >
                                            <div className="flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-2 py-1.5">
                                                <Folder className="w-4 h-4 text-blue-400 shrink-0" />
                                                <InlineInput
                                                    placeholder="Group name…"
                                                    onConfirm={name => {
                                                        logicalNodes.addNode(layer.id, name)
                                                        setShowAddRoot(false)
                                                    }}
                                                    onCancel={() => setShowAddRoot(false)}
                                                />
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>

                                {/* + Add Group button */}
                                <button
                                    onClick={() => setShowAddRoot(v => !v)}
                                    className={cn(
                                        'flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs ml-4',
                                        'text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors'
                                    )}
                                >
                                    <Plus className="w-3 h-3" />
                                    Add Group
                                </button>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </Reorder.Item>
    )
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function LayerHierarchyPanel({
    layers,
    assignments,
    rootsByLayer,
    defaultNodeSortMode,
    onSetLayerSortMode,
    onApplySortToView,
    onResetCustomOrder,
    onReorderRoot,
    anchorMoreByLayer,
    onLoadMoreAnchor,
    activeTarget,
    logicalNodes,
    entityIndex,
    onSetActiveTarget,
    onDrop,
    onUnassign,
    onReorderLayers,
    onAddLayer,
    onRenameLayer,
    onDeleteLayer,
    onClearLayer,
    onStartResize,
    isResizing,
    className,
}: LayerHierarchyPanelProps) {
    const layerIds = layers.map(l => l.id)
    const [showAddLayer, setShowAddLayer] = useState(false)

    return (
        <div
            data-testid="layer-hierarchy-panel"
            className={cn(
                'relative flex flex-col h-full rounded-2xl overflow-hidden',
                'bg-white/60 dark:bg-slate-900/60 backdrop-blur-xl',
                'border border-slate-200/70 dark:border-slate-700/60 shadow-lg',
                className
            )}
        >
            {/* Drag-to-resize divider — nested names need room. */}
            {onStartResize && (
                <div
                    onPointerDown={onStartResize}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize layers panel"
                    title="Drag to resize"
                    className={cn(
                        'absolute right-0 top-0 bottom-0 w-1.5 z-20 cursor-col-resize group/resize',
                        'flex items-center justify-center',
                    )}
                >
                    <span className={cn(
                        'h-10 w-1 rounded-full transition-colors',
                        isResizing
                            ? 'bg-blue-500'
                            : 'bg-transparent group-hover/resize:bg-slate-300 dark:group-hover/resize:bg-slate-600',
                    )} />
                </div>
            )}

            {/* Header */}
            <div className="px-4 pt-4 pb-2 border-b border-slate-200/60 dark:border-slate-700/60">
                <h3 className="text-sm font-semibold text-slate-800 dark:text-white">Layers &amp; Groups</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                    Drop entities on a layer — their children follow
                </p>
            </div>

            {/* Active target pill */}
            {activeTarget && (
                <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-500/10 rounded-lg">
                        <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
                        <span className="text-xs text-blue-600 dark:text-blue-400 font-medium truncate">
                            {activeTarget.label}
                        </span>
                    </div>
                </div>
            )}

            {/* Drag hint */}
            <div className="px-3 py-1.5 bg-gradient-to-r from-blue-50/50 to-violet-50/50 dark:from-blue-950/30 dark:to-violet-950/30 border-b border-slate-100 dark:border-slate-800">
                <p className="text-[11px] text-slate-400 text-center">
                    ↓ Drag entities from the browser onto any layer or group
                </p>
            </div>

            {/* Layer list (scrollable) */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
                {layers.length === 0 ? (
                    <div className="text-center py-8">
                        <p className="text-sm text-slate-400">No layers yet</p>
                        <p className="text-xs text-slate-400 mt-1">Add one below to start placing entities</p>
                    </div>
                ) : (
                    <Reorder.Group
                        axis="y"
                        values={layerIds}
                        onReorder={onReorderLayers}
                        className="space-y-1"
                    >
                        {layers.map((layer, i) => (
                            <LayerRow
                                key={layer.id}
                                layer={layer}
                                layerIndex={i}
                                assignments={assignments}
                                rows={rootsByLayer?.get(layer.id)}
                                defaultNodeSortMode={defaultNodeSortMode}
                                onSetLayerSortMode={onSetLayerSortMode}
                                onApplySortToView={onApplySortToView}
                                onResetCustomOrder={onResetCustomOrder}
                                onReorderRoot={onReorderRoot}
                                anchorMore={anchorMoreByLayer?.get(layer.id)}
                                onLoadMoreAnchor={onLoadMoreAnchor}
                                activeTarget={activeTarget}
                                logicalNodes={logicalNodes}
                                entityIndex={entityIndex}
                                onSetActiveTarget={onSetActiveTarget}
                                onDrop={onDrop}
                                onUnassign={onUnassign}
                                onRenameLayer={onRenameLayer}
                                onDeleteLayer={onDeleteLayer}
                                onClearLayer={onClearLayer}
                            />
                        ))}
                    </Reorder.Group>
                )}

                {/* Add layer — no more going back a step because you forgot one. */}
                {showAddLayer ? (
                    <div className="flex items-center gap-2 mt-1 px-2 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20">
                        <Layers className="w-4 h-4 text-blue-400 shrink-0" />
                        <InlineInput
                            placeholder="Layer name…"
                            onConfirm={name => {
                                onAddLayer(name)
                                setShowAddLayer(false)
                            }}
                            onCancel={() => setShowAddLayer(false)}
                        />
                    </div>
                ) : (
                    <button
                        onClick={() => setShowAddLayer(true)}
                        className={cn(
                            'flex items-center gap-1.5 w-full px-2 py-1.5 mt-1 rounded-lg text-xs font-medium',
                            'text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors'
                        )}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Add layer
                    </button>
                )}
            </div>
        </div>
    )
}
