/**
 * LayerDropZone - Visual drop target for entity-to-layer drag & drop assignment
 *
 * Used in the Reference Model Builder and ViewEditor to enable
 * intuitive drag-and-drop entity assignment.
 *
 * Features:
 * - Containment inheritance enforcement (children cannot override parent layer)
 * - Assigned entity list with remove buttons
 * - Bulk drop support (multiple selected entities)
 */

import React, { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Layers, Plus, X, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReferenceModelStore, useInstanceAssignments } from '@/store/referenceModelStore'
import { useCanvasStore } from '@/store/canvas'
import type { ViewLayerConfig } from '@/types/schema'

// ============================================
// Types
// ============================================

interface LayerDropZoneProps {
    layer: ViewLayerConfig
    onDrop?: (entityId: string, layerId: string) => void
    onUnassign?: (entityId: string) => void
    className?: string
    showEntityCount?: boolean
    entityCount?: number
    /** Show assigned entities with remove buttons */
    showAssignedEntities?: boolean
}

interface DroppedEntityData {
    entityId: string
    entityName?: string
    entityType?: string
    /** Bulk: multiple entity IDs (from WizardAssignmentTree multi-select) */
    entityIds?: string[]
}

// ============================================
// Component
// ============================================

export function LayerDropZone({
    layer,
    onDrop,
    onUnassign,
    className,
    showEntityCount = false,
    entityCount = 0,
    showAssignedEntities = true
}: LayerDropZoneProps) {
    const [isDraggingOver, setIsDraggingOver] = useState(false)
    const [warning, setWarning] = useState<string | null>(null)
    const warningTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

    const assignEntityToLayer = useReferenceModelStore(s => s.assignEntityToLayer)
    const removeEntityAssignment = useReferenceModelStore(s => s.removeEntityAssignment)
    const instanceAssignments = useInstanceAssignments()
    const nodes = useCanvasStore(s => s.nodes)

    // Build node name lookup for displaying assigned entities
    const nodeNameMap = useMemo(() => {
        const map = new Map<string, string>()
        nodes.forEach(n => {
            map.set(n.id, (n.data as { label?: string; businessLabel?: string }).label
                ?? (n.data as { businessLabel?: string }).businessLabel
                ?? n.id)
        })
        return map
    }, [nodes])

    // Get entities assigned to this layer
    const assignedEntities = useMemo(() => {
        const result: Array<{ id: string; name: string }> = []
        instanceAssignments.forEach((assignment, entityId) => {
            if (assignment.layerId === layer.id) {
                result.push({ id: entityId, name: nodeNameMap.get(entityId) ?? entityId })
            }
        })
        return result.sort((a, b) => a.name.localeCompare(b.name))
    }, [instanceAssignments, layer.id, nodeNameMap])

    const showWarning = useCallback((message: string) => {
        setWarning(message)
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
        warningTimerRef.current = setTimeout(() => setWarning(null), 5000)
    }, [])

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'

        if (e.dataTransfer.types.includes('application/x-entity-assignment')) {
            setIsDraggingOver(true)
        }
    }, [])

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX
        const y = e.clientY

        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
            setIsDraggingOver(false)
        }
    }, [])

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        setIsDraggingOver(false)

        const rawData = e.dataTransfer.getData('application/x-entity-assignment')
        if (!rawData) return

        try {
            const data: DroppedEntityData = JSON.parse(rawData)

            // Collect all entity IDs (single or bulk)
            const entityIds: string[] = data.entityIds?.length
                ? data.entityIds
                : data.entityId
                    ? [data.entityId]
                    : []

            if (entityIds.length === 0) return

            let blockedCount = 0
            entityIds.forEach(entityId => {
                if (onDrop) {
                    onDrop(entityId, layer.id)
                } else {
                    const result = assignEntityToLayer(entityId, layer.id, { inheritsChildren: true })
                    if (!result.success && result.conflict?.type === 'containment_locked') {
                        blockedCount++
                    }
                }
            })

            if (blockedCount > 0) {
                showWarning(
                    blockedCount === 1
                        ? 'Assignment blocked: child inherits its parent\'s layer.'
                        : `${blockedCount} assignment(s) blocked: children inherit their parent's layer.`
                )
            }
        } catch (err) {
            console.error('Failed to parse drop data:', err)
        }
    }, [layer.id, onDrop, assignEntityToLayer, showWarning])

    const handleUnassign = useCallback((entityId: string) => {
        if (onUnassign) {
            onUnassign(entityId)
        } else {
            removeEntityAssignment(entityId)
        }
    }, [onUnassign, removeEntityAssignment])

    const effectiveCount = showEntityCount ? entityCount : assignedEntities.length

    return (
        <motion.div
            className={cn(
                'relative min-h-[120px] p-4 rounded-xl border-2 border-dashed transition-all',
                isDraggingOver
                    ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20 scale-[1.02]'
                    : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50',
                className
            )}
            style={{
                borderColor: isDraggingOver ? undefined : layer.color + '40'
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            animate={{ scale: isDraggingOver ? 1.02 : 1 }}
            transition={{ duration: 0.15 }}
        >
            {/* Layer Header */}
            <div className="flex items-center gap-2 mb-3">
                <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: layer.color }}
                />
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    {layer.name}
                </span>
                {effectiveCount > 0 && (
                    <span className="ml-auto text-xs text-slate-400 px-2 py-0.5 bg-slate-100 dark:bg-slate-700 rounded-full">
                        {effectiveCount}
                    </span>
                )}
            </div>

            {/* Containment warning */}
            <AnimatePresence>
                {warning && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mb-2 overflow-hidden"
                    >
                        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-400">
                            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="flex-1">{warning}</span>
                            <button onClick={() => setWarning(null)} className="text-red-400 hover:text-red-600">&times;</button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Assigned Entities List */}
            {showAssignedEntities && assignedEntities.length > 0 && (
                <div className="mb-3 space-y-1 max-h-[160px] overflow-y-auto">
                    {assignedEntities.map(entity => (
                        <div
                            key={entity.id}
                            className="flex items-center gap-2 px-2 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 group"
                        >
                            <span
                                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: layer.color }}
                            />
                            <span className="text-xs text-slate-600 dark:text-slate-300 truncate flex-1">
                                {entity.name}
                            </span>
                            <button
                                onClick={() => handleUnassign(entity.id)}
                                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 transition-all"
                                title="Remove assignment"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Drop Indicator */}
            <div
                className={cn(
                    'flex flex-col items-center justify-center py-6 rounded-lg border border-dashed transition-all',
                    isDraggingOver
                        ? 'border-blue-500 bg-blue-100 dark:bg-blue-900/40'
                        : 'border-slate-200 dark:border-slate-600'
                )}
            >
                {isDraggingOver ? (
                    <>
                        <Plus className="w-8 h-8 text-blue-500 mb-2" />
                        <p className="text-sm text-blue-600 dark:text-blue-400 font-medium">
                            Drop to assign here
                        </p>
                    </>
                ) : (
                    <>
                        <Layers className="w-6 h-6 text-slate-300 dark:text-slate-600 mb-2" />
                        <p className="text-xs text-slate-400">
                            Drag entities here
                        </p>
                    </>
                )}
            </div>

            {/* Entity Types Info */}
            {layer.entityTypes.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                    {layer.entityTypes.slice(0, 3).map(type => (
                        <span
                            key={type}
                            className="text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400"
                        >
                            {type}
                        </span>
                    ))}
                    {layer.entityTypes.length > 3 && (
                        <span className="text-xs px-2 py-0.5 text-slate-400">
                            +{layer.entityTypes.length - 3} more
                        </span>
                    )}
                </div>
            )}
        </motion.div>
    )
}

/**
 * Multiple drop zones in a row for layer assignment
 */
interface LayerDropZoneRowProps {
    layers: ViewLayerConfig[]
    onDrop?: (entityId: string, layerId: string) => void
    onUnassign?: (entityId: string) => void
    className?: string
    entityCounts?: Map<string, number>
}

export function LayerDropZoneRow({
    layers,
    onDrop,
    onUnassign,
    className,
    entityCounts
}: LayerDropZoneRowProps) {
    return (
        <div className={cn('flex gap-4 overflow-x-auto p-2', className)}>
            {layers.map(layer => (
                <LayerDropZone
                    key={layer.id}
                    layer={layer}
                    onDrop={onDrop}
                    onUnassign={onUnassign}
                    showEntityCount={Boolean(entityCounts)}
                    entityCount={entityCounts?.get(layer.id) ?? 0}
                    className="flex-1 min-w-[180px]"
                />
            ))}
        </div>
    )
}
