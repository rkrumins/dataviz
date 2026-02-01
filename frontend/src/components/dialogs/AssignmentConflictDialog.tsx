/**
 * AssignmentConflictDialog - Warning dialog for layer assignment conflicts
 * 
 * Shows when a user tries to assign an entity to a layer that conflicts
 * with an existing assignment (parent/child inheritance conflicts)
 */

import React, { useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, X, ArrowRight, GitMerge, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReferenceModelStore, useLayers } from '@/store/referenceModelStore'
import type { AssignmentConflict } from '@/types/schema'

// ============================================
// Types
// ============================================

interface AssignmentConflictDialogProps {
    conflict: AssignmentConflict | null
    onResolve: (resolution: 'keep_parent' | 'override' | 'move_hierarchy') => void
    onCancel: () => void
    entityName?: string
    conflictingEntityName?: string
}

type Resolution = 'keep_parent' | 'override' | 'move_hierarchy'

interface ResolutionOption {
    value: Resolution
    label: string
    description: string
    icon: React.ReactNode
    warning?: string
}

// ============================================
// Component
// ============================================

export function AssignmentConflictDialog({
    conflict,
    onResolve,
    onCancel,
    entityName = 'This entity',
    conflictingEntityName = 'Parent entity'
}: AssignmentConflictDialogProps) {
    const layers = useLayers()

    // Find layer names for display
    const conflictingLayer = useMemo(() =>
        layers.find(l => l.id === conflict?.conflictingLayerId),
        [layers, conflict?.conflictingLayerId]
    )

    if (!conflict) return null

    const isParentConflict = conflict.type === 'parent_assigned'

    const resolutionOptions: ResolutionOption[] = [
        {
            value: 'keep_parent',
            label: isParentConflict
                ? 'Keep parent assignment (inherit)'
                : 'Keep existing child assignments',
            description: isParentConflict
                ? `${entityName} will inherit the "${conflictingLayer?.name || 'unknown'}" layer from ${conflictingEntityName}`
                : `Child entities will remain in their current layers`,
            icon: <GitMerge className="w-5 h-5" />
        },
        {
            value: 'override',
            label: 'Override for this entity only',
            description: isParentConflict
                ? `${entityName} will be assigned to the new layer, breaking inheritance`
                : `Only this entity is reassigned; child assignments stay as-is`,
            icon: <GitBranch className="w-5 h-5" />,
            warning: isParentConflict
                ? 'This may create inconsistent layer groupings'
                : undefined
        },
        {
            value: 'move_hierarchy',
            label: 'Move entire hierarchy to new layer',
            description: isParentConflict
                ? `Both ${conflictingEntityName} and ${entityName} (plus all descendants) will move to the new layer`
                : `This entity and all its children will move to the new layer`,
            icon: <ArrowRight className="w-5 h-5" />,
            warning: 'This may affect many entities'
        }
    ]

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
                onClick={onCancel}
            >
                <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-md w-full p-6"
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-start gap-4 mb-4">
                        <div className="p-2 rounded-full bg-amber-100 dark:bg-amber-900/50">
                            <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="flex-1">
                            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                                Assignment Conflict Detected
                            </h3>
                            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                                {conflict.message}
                            </p>
                        </div>
                        <button
                            onClick={onCancel}
                            className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                            <X className="w-5 h-5 text-slate-400" />
                        </button>
                    </div>

                    {/* Conflict Details */}
                    <div className="mb-6 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
                        <div className="flex items-center gap-2 text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-300">
                                {conflictingEntityName}
                            </span>
                            <ArrowRight className="w-4 h-4 text-slate-400" />
                            <span
                                className="px-2 py-0.5 rounded-full text-xs font-medium"
                                style={{
                                    backgroundColor: (conflictingLayer?.color || '#888') + '20',
                                    color: conflictingLayer?.color || '#888'
                                }}
                            >
                                {conflictingLayer?.name || 'Unknown Layer'}
                            </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                            {isParentConflict
                                ? 'The parent entity is assigned to this layer with inheritance enabled.'
                                : 'One or more child entities are assigned to different layers.'}
                        </p>
                    </div>

                    {/* Resolution Options */}
                    <div className="space-y-3 mb-6">
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                            How would you like to resolve this?
                        </p>
                        {resolutionOptions.map(option => (
                            <button
                                key={option.value}
                                onClick={() => onResolve(option.value)}
                                className={cn(
                                    'w-full p-3 rounded-lg border-2 text-left transition-all',
                                    'hover:border-blue-300 dark:hover:border-blue-700',
                                    'hover:bg-blue-50 dark:hover:bg-blue-900/20',
                                    'border-slate-200 dark:border-slate-700'
                                )}
                            >
                                <div className="flex items-center gap-3">
                                    <span className="text-slate-500">{option.icon}</span>
                                    <div>
                                        <p className="font-medium text-slate-800 dark:text-slate-200">
                                            {option.label}
                                        </p>
                                        <p className="text-xs text-slate-500 mt-0.5">
                                            {option.description}
                                        </p>
                                        {option.warning && (
                                            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                                                ⚠️ {option.warning}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>

                    {/* Cancel Button */}
                    <div className="flex justify-end">
                        <button
                            onClick={onCancel}
                            className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                        >
                            Cancel
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}

/**
 * Hook to manage conflict dialog state
 */
export function useConflictDialog() {
    const [conflict, setConflict] = React.useState<AssignmentConflict | null>(null)
    const [pendingAssignment, setPendingAssignment] = React.useState<{
        entityId: string
        layerId: string
        options?: { logicalNodeId?: string; inheritsChildren?: boolean }
    } | null>(null)

    const assignEntityToLayer = useReferenceModelStore(s => s.assignEntityToLayer)
    const checkConflict = useReferenceModelStore(s => s.checkAssignmentConflict)

    const showConflict = useCallback((c: AssignmentConflict, pending: typeof pendingAssignment) => {
        setConflict(c)
        setPendingAssignment(pending)
    }, [])

    const handleResolve = useCallback((resolution: Resolution) => {
        if (!pendingAssignment) return

        const { entityId, layerId, options } = pendingAssignment

        switch (resolution) {
            case 'keep_parent':
                // Don't make the assignment; parent wins
                break

            case 'override':
                // Make the assignment without inheritance
                assignEntityToLayer(entityId, layerId, { ...options, inheritsChildren: false })
                break

            case 'move_hierarchy':
                // Move the conflicting entity too (if parent conflict)
                if (conflict?.type === 'parent_assigned' && conflict.conflictingEntityId) {
                    assignEntityToLayer(conflict.conflictingEntityId, layerId, { inheritsChildren: true })
                }
                // Also assign current entity
                assignEntityToLayer(entityId, layerId, { ...options, inheritsChildren: true })
                break
        }

        setConflict(null)
        setPendingAssignment(null)
    }, [pendingAssignment, conflict, assignEntityToLayer])

    const handleCancel = useCallback(() => {
        setConflict(null)
        setPendingAssignment(null)
    }, [])

    /**
     * Attempt to assign with conflict detection
     */
    const tryAssign = useCallback((
        entityId: string,
        layerId: string,
        options?: { logicalNodeId?: string; inheritsChildren?: boolean }
    ) => {
        const detectedConflict = checkConflict(entityId, layerId)

        if (detectedConflict) {
            showConflict(detectedConflict, { entityId, layerId, options })
            return false
        }

        // No conflict - proceed with assignment
        assignEntityToLayer(entityId, layerId, options)
        return true
    }, [checkConflict, assignEntityToLayer, showConflict])

    return {
        conflict,
        tryAssign,
        handleResolve,
        handleCancel
    }
}
