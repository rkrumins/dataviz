import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Database, Plus, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig, EntityAssignmentConfig } from '@/types/schema'

interface AssignmentLayerCardProps {
    layer: ViewLayerConfig
    entityAssignments: EntityAssignmentConfig[]
    onAssign: (layerId: string, entityId: string) => void
    onUnassign: (layerId: string, entityId: string) => void
    onBulkAssign?: (layerId: string, entityIds: string[]) => void
    className?: string
}

export function AssignmentLayerCard({
    layer,
    entityAssignments,
    onAssign,
    onUnassign,
    onBulkAssign,
    className
}: AssignmentLayerCardProps) {
    const [isHovering, setIsHovering] = useState(false)
    const [lastDropped, setLastDropped] = useState<string | null>(null)

    // Filter assignments for this layer
    const layerAssignments = entityAssignments.filter(a => a.layerId === layer.id)

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setIsHovering(true)
    }

    const handleDragLeave = () => {
        setIsHovering(false)
    }

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault()
        setIsHovering(false)

        try {
            const dataStr = e.dataTransfer.getData('application/x-entity-assignment')
            if (!dataStr) return

            const data = JSON.parse(dataStr)
            const { entityId, entityName, entityIds, primaryEntity } = data

            // Target ID can be from top-level entityId or primaryEntity.id
            const targetId = entityId || primaryEntity?.id
            const targetName = entityName || primaryEntity?.name || targetId

            if (!targetId && (!entityIds || entityIds.length === 0)) return

            // Handle Bulk
            if (entityIds && entityIds.length > 1 && onBulkAssign) {
                onBulkAssign(layer.id, entityIds)
                setLastDropped(`${entityIds.length} entities`)
            } else if (targetId) {
                // Check if already assigned to this layer
                if (layerAssignments.some(a => a.entityId === targetId)) return
                onAssign(layer.id, targetId)
                setLastDropped(targetName)
            }

            // Show success feedback
            setTimeout(() => setLastDropped(null), 2000)
        } catch (err) {
            console.error('Failed to parse dropped entity data', err)
        }
    }

    // Determine colors
    const startColor = layer.color || '#3b82f6'

    return (
        <div
            className={cn(
                'relative p-4 rounded-xl border-2 transition-all duration-200',
                isHovering
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 scale-[1.02] shadow-lg'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800',
                className
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Success Feedback Overlay */}
            <AnimatePresence>
                {lastDropped && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-green-500/90 rounded-lg flex items-center justify-center z-10 text-white font-medium"
                    >
                        <Check className="w-5 h-5 mr-2" />
                        Added {lastDropped}
                    </motion.div>
                )}
            </AnimatePresence>

            <div className="flex items-center gap-3">
                {/* Color/Icon Box */}
                <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white shadow-sm"
                    style={{ backgroundColor: startColor }}
                >
                    <Database className="w-5 h-5" />
                </div>

                <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                        {layer.name}
                    </h3>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>{layerAssignments.length} assigned manually</span>
                        {layer.rules && layer.rules.length > 0 && (
                            <>
                                <span className="w-1 h-1 rounded-full bg-slate-300" />
                                <span>{layer.rules.length} rules</span>
                            </>
                        )}
                    </div>
                </div>

                {isHovering ? (
                    <div className="animate-bounce">
                        <Plus className="w-6 h-6 text-blue-500" />
                    </div>
                ) : (
                    <div className="text-sm font-medium text-slate-400">
                        Drop here
                    </div>
                )}
            </div>

            {/* Assignments List (Preview) */}
            {layerAssignments.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700">
                    <div className="flex flex-wrap gap-1.5">
                        {layerAssignments.slice(0, 5).map((a) => (
                            <span
                                key={a.entityId}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded text-xs max-w-[120px] truncate"
                            >
                                <span className="truncate">{a.entityId}</span>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        onUnassign(layer.id, a.entityId)
                                    }}
                                    className="hover:text-red-500"
                                >
                                    &times;
                                </button>
                            </span>
                        ))}
                        {layerAssignments.length > 5 && (
                            <span className="text-xs text-slate-400 py-0.5">
                                +{layerAssignments.length - 5} more
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
