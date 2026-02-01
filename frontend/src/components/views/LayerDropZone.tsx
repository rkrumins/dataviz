/**
 * LayerDropZone - Visual drop target for entity-to-layer drag & drop assignment
 * 
 * Used in the Reference Model Builder and ViewEditor to enable
 * intuitive drag-and-drop entity assignment.
 */

import React, { useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Layers, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { ViewLayerConfig } from '@/types/schema'

// ============================================
// Types
// ============================================

interface LayerDropZoneProps {
    layer: ViewLayerConfig
    onDrop?: (entityId: string, layerId: string) => void
    className?: string
    showEntityCount?: boolean
    entityCount?: number
}

interface DroppedEntityData {
    entityId: string
    entityName: string
    entityType: string
}

// ============================================
// Component
// ============================================

export function LayerDropZone({
    layer,
    onDrop,
    className,
    showEntityCount = false,
    entityCount = 0
}: LayerDropZoneProps) {
    const [isDraggingOver, setIsDraggingOver] = useState(false)
    const assignEntityToLayer = useReferenceModelStore(s => s.assignEntityToLayer)

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'

        // Only show drop indicator if we're dragging entity data
        if (e.dataTransfer.types.includes('application/x-entity-assignment')) {
            setIsDraggingOver(true)
        }
    }, [])

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        // Only trigger if we're actually leaving the drop zone
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

            // Call parent handler if provided
            if (onDrop) {
                onDrop(data.entityId, layer.id)
            } else {
                // Default: use store action
                assignEntityToLayer(data.entityId, layer.id, { inheritsChildren: true })
            }
        } catch (err) {
            console.error('Failed to parse drop data:', err)
        }
    }, [layer.id, onDrop, assignEntityToLayer])

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
                {showEntityCount && (
                    <span className="ml-auto text-xs text-slate-400 px-2 py-0.5 bg-slate-100 dark:bg-slate-700 rounded-full">
                        {entityCount}
                    </span>
                )}
            </div>

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
    className?: string
    entityCounts?: Map<string, number>
}

export function LayerDropZoneRow({
    layers,
    onDrop,
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
                    showEntityCount={Boolean(entityCounts)}
                    entityCount={entityCounts?.get(layer.id) ?? 0}
                    className="flex-1 min-w-[180px]"
                />
            ))}
        </div>
    )
}
