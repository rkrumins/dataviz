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

import { useState, useCallback, useMemo } from 'react'
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
    Box,
    Eraser,
    Loader2,
    X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig, LogicalNodeConfig, EntityAssignmentConfig, LayerAssignmentEntry } from '@/types/schema'
import type { UseLogicalNodesReturn } from '@/hooks/useLogicalNodes'
import { useEntityTypes } from '@/store/schema'
import {
    fallbackNameFromUrn,
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

interface LayerHierarchyPanelProps {
    layers: ViewLayerConfig[]
    /** Canonical urn-keyed assignment map (formData.assignments) — source of truth
     *  for per-layer/per-node entity lists and count badges; layer.entityAssignments
     *  is deprecated and no longer written. */
    assignments: Record<string, LayerAssignmentEntry>
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
}: {
    entityId: string
    depth: number
    entityIndex: WizardEntityIndex
    onUnassign: (entityId: string) => void
    /** Descendant shown under its assigned ancestor — it inherits the layer, so
     *  it is read-only here (no unassign, no drag: moving it would violate the
     *  containment rule the Studio already enforces). */
    inherited?: boolean
}) {
    const [isExpanded, setIsExpanded] = useState(false)

    // Identity + children come from the entity browser's data (via the wizard
    // entity index) — NOT the canvas store, which is empty inside the wizard
    // and used to make every assigned row render as a raw URN fragment.
    const identity = entityIndex.resolve(entityId)
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

    return (
        <div>
            <div
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
                <div className="flex-1 min-w-0 flex items-center gap-1">
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
                {/* Unassign — only the explicit placement can be removed. */}
                {!inherited && (
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

    const isActive = activeTarget?.layerId === layerId && activeTarget?.nodeId === node.id
    const isCollapsed = node.collapsed ?? false
    // Get actual assigned identities
    const assignedEntities = entityAssignments.filter(a => a.logicalNodeId === node.id).map(a => a.entityId)
    const assignedCount = assignedEntities.length
    const hasChildren = !!(node.children && node.children.length > 0) || assignedCount > 0

    // Build the display label for this node's path
    const pathLabel = `${layerName} → ${logicalNodes.nodePathLabel(layerId, node.id)}`

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
                        onClick={e => { e.stopPropagation(); logicalNodes.deleteNode(layerId, node.id) }}
                        className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40 text-slate-400 hover:text-red-500"
                        title="Delete group"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </motion.div>

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
    const unassignedEntities = layerEntityAssignments.filter(a => !a.logicalNodeId).map(a => a.entityId)
    const totalAssigned = layerEntityAssignments.length
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
                    {totalAssigned > 0 && !isDragOver && (
                        <span className="text-xs text-slate-400 shrink-0">{totalAssigned}</span>
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
                            <span className="font-semibold">{layer.name}</span>? The layer stays.
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

                                {/* Entities placed directly in the layer */}
                                {unassignedEntities.length > 0 && (
                                    <div className="mt-2 space-y-0.5 border-t border-slate-100 dark:border-slate-800 pt-1">
                                        <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
                                            <Layers className="w-3 h-3" />
                                            Layer Entities ({unassignedEntities.length})
                                        </div>
                                        {unassignedEntities.map(entityId => (
                                            <AssignedEntityItem
                                                key={entityId}
                                                entityId={entityId}
                                                depth={0}
                                                entityIndex={entityIndex}
                                                onUnassign={onUnassign}
                                            />
                                        ))}
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
