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

import { useState, useCallback } from 'react'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig, LogicalNodeConfig, EntityAssignmentConfig } from '@/types/schema'
import type { UseLogicalNodesReturn } from '@/hooks/useLogicalNodes'

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

interface LayerHierarchyPanelProps {
    layers: ViewLayerConfig[]
    activeTarget: ActiveTarget | null
    logicalNodes: UseLogicalNodesReturn
    /** Called when user clicks OR drags onto a layer/node — becomes the active target */
    onSetActiveTarget: (target: ActiveTarget) => void
    /** Called when entities are dropped onto a layer or logical node */
    onDrop: (layerId: string, nodeId: string | undefined, payload: DropPayload) => void
    onReorderLayers: (layerIds: string[]) => void
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

// ─── Logical Node Item ────────────────────────────────────────────────────────

interface LogicalNodeItemProps {
    node: LogicalNodeConfig
    layerId: string
    layerName: string
    layerColor: string
    depth: number
    activeTarget: ActiveTarget | null
    logicalNodes: UseLogicalNodesReturn
    entityAssignments: EntityAssignmentConfig[]
    onSetActiveTarget: (target: ActiveTarget) => void
    onDrop: (layerId: string, nodeId: string | undefined, payload: DropPayload) => void
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
    onSetActiveTarget,
    onDrop,
}: LogicalNodeItemProps) {
    const [isRenaming, setIsRenaming] = useState(false)
    const [showAddChild, setShowAddChild] = useState(false)
    const [isDragOver, setIsDragOver] = useState(false)

    const isActive = activeTarget?.layerId === layerId && activeTarget?.nodeId === node.id
    const isCollapsed = node.collapsed ?? false
    const assignedCount = entityAssignments.filter(a => a.logicalNodeId === node.id).length
    const hasChildren = !!(node.children && node.children.length > 0)

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

            {/* Children */}
            {!isCollapsed && node.children && node.children.length > 0 && (
                <AnimatePresence>
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
                            onSetActiveTarget={onSetActiveTarget}
                            onDrop={onDrop}
                        />
                    ))}
                </AnimatePresence>
            )}
        </div>
    )
}

// ─── Layer Row (drag-to-reorder + drop zone) ──────────────────────────────────

interface LayerRowProps {
    layer: ViewLayerConfig
    activeTarget: ActiveTarget | null
    logicalNodes: UseLogicalNodesReturn
    onSetActiveTarget: (target: ActiveTarget) => void
    onDrop: (layerId: string, nodeId: string | undefined, payload: DropPayload) => void
}

function LayerRow({ layer, activeTarget, logicalNodes, onSetActiveTarget, onDrop }: LayerRowProps) {
    const [isExpanded, setIsExpanded] = useState(true)
    const [showAddRoot, setShowAddRoot] = useState(false)
    const [isDragOver, setIsDragOver] = useState(false)
    const dragControls = useDragControls()

    const isLayerActive = activeTarget?.layerId === layer.id && !activeTarget?.nodeId
    const nodes = logicalNodes.nodesForLayer(layer.id)
    const unassignedCount = (layer.entityAssignments ?? []).filter(a => !a.logicalNodeId).length
    const totalAssigned = (layer.entityAssignments ?? []).length
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

                    {/* Layer name */}
                    <span className="flex-1 text-sm font-semibold text-slate-800 dark:text-white truncate">
                        {layer.name}
                    </span>

                    {/* Drop indicator */}
                    {isDragOver && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-white animate-pulse shrink-0"
                            style={{ backgroundColor: color }}>
                            Drop here
                        </span>
                    )}

                    {/* Assignment count */}
                    {totalAssigned > 0 && !isDragOver && (
                        <span className="text-xs text-slate-400 shrink-0">{totalAssigned}</span>
                    )}

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
                                        entityAssignments={layer.entityAssignments ?? []}
                                        onSetActiveTarget={onSetActiveTarget}
                                        onDrop={onDrop}
                                    />
                                ))}

                                {/* Unorganised entity count */}
                                {unassignedCount > 0 && (
                                    <div className="flex items-center gap-1.5 px-2 py-1 ml-6 text-xs text-slate-400 italic">
                                        <Layers className="w-3 h-3" />
                                        {unassignedCount} unorganised
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
    activeTarget,
    logicalNodes,
    onSetActiveTarget,
    onDrop,
    onReorderLayers,
    className,
}: LayerHierarchyPanelProps) {
    const layerIds = layers.map(l => l.id)

    return (
        <div
            className={cn(
                'flex flex-col h-full rounded-2xl overflow-hidden',
                'bg-white/60 dark:bg-slate-900/60 backdrop-blur-xl',
                'border border-slate-200/70 dark:border-slate-700/60 shadow-lg',
                className
            )}
        >
            {/* Header */}
            <div className="px-4 pt-4 pb-2 border-b border-slate-200/60 dark:border-slate-700/60">
                <h3 className="text-sm font-semibold text-slate-800 dark:text-white">Layers & Groups</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                    Drag entities here or click to set active target
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
                    <div className="text-center py-8 text-slate-400 text-sm">
                        No layers configured
                    </div>
                ) : (
                    <Reorder.Group
                        axis="y"
                        values={layerIds}
                        onReorder={onReorderLayers}
                        className="space-y-1"
                    >
                        {layers.map(layer => (
                            <LayerRow
                                key={layer.id}
                                layer={layer}
                                activeTarget={activeTarget}
                                logicalNodes={logicalNodes}
                                onSetActiveTarget={onSetActiveTarget}
                                onDrop={onDrop}
                            />
                        ))}
                    </Reorder.Group>
                )}
            </div>
        </div>
    )
}
