/**
 * ChildReassignConfirmDialog — Confirmation dialog shown when a parent entity
 * is assigned to a layer that differs from its children's current assignments.
 *
 * Two options:
 *  1. "Move all" — reassign parent + children to the target layer
 *  2. "Cancel"   — abort the assignment
 */

import { useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowRight, X, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig } from '@/types/schema'

// ============================================
// Types
// ============================================

export interface ChildReassignInfo {
    /** The parent entity being assigned */
    entityId: string
    entityName: string
    /** Target layer for the parent */
    targetLayerId: string
    /** Children that will be moved */
    descendantsToMove: Array<{
        id: string
        name: string
        currentLayerId: string
    }>
}

interface ChildReassignConfirmDialogProps {
    info: ChildReassignInfo | null
    layers: ViewLayerConfig[]
    onConfirm: () => void
    onCancel: () => void
}

// ============================================
// Component
// ============================================

export function ChildReassignConfirmDialog({
    info,
    layers,
    onConfirm,
    onCancel,
}: ChildReassignConfirmDialogProps) {
    const targetLayer = useMemo(
        () => layers.find(l => l.id === info?.targetLayerId),
        [layers, info?.targetLayerId]
    )

    // Group children by their current layer for a compact summary
    const childrenByLayer = useMemo(() => {
        if (!info) return []
        const map = new Map<string, { layer: ViewLayerConfig | undefined; children: string[] }>()
        info.descendantsToMove.forEach(d => {
            const entry = map.get(d.currentLayerId) ?? {
                layer: layers.find(l => l.id === d.currentLayerId),
                children: [],
            }
            entry.children.push(d.name)
            map.set(d.currentLayerId, entry)
        })
        return Array.from(map.values())
    }, [info, layers])

    if (!info) return null

    const count = info.descendantsToMove.length

    return (
        <AnimatePresence>
            {/* Backdrop */}
            <motion.div
                key="backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4"
                onClick={onCancel}
            >
                {/* Dialog */}
                <motion.div
                    key="dialog"
                    initial={{ scale: 0.92, opacity: 0, y: 12 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 8 }}
                    transition={{ type: 'spring', damping: 28, stiffness: 350 }}
                    className={cn(
                        'relative w-full max-w-[420px] rounded-2xl overflow-hidden',
                        'bg-white dark:bg-slate-900',
                        'border border-slate-200 dark:border-slate-700/80',
                        'shadow-lg shadow-black/20'
                    )}
                    onClick={e => e.stopPropagation()}
                >
                    {/* Top accent bar */}
                    <div
                        className="h-1 w-full"
                        style={{ background: `linear-gradient(90deg, ${targetLayer?.color ?? '#3b82f6'}, ${targetLayer?.color ?? '#3b82f6'}80)` }}
                    />

                    <div className="p-5">
                        {/* Header */}
                        <div className="flex items-start gap-3.5 mb-4">
                            <div className="p-2.5 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex-shrink-0">
                                <Users className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-base font-semibold text-slate-900 dark:text-white leading-tight">
                                    Move {count} child{count !== 1 ? 'ren' : ''} with parent?
                                </h3>
                                <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                                    <span className="font-medium text-slate-700 dark:text-slate-200">{info.entityName}</span>
                                    {' '}has children assigned to other layers. They must follow their parent.
                                </p>
                            </div>
                            <button
                                onClick={onCancel}
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex-shrink-0"
                            >
                                <X className="w-4 h-4 text-slate-400" />
                            </button>
                        </div>

                        {/* Children summary */}
                        <div className="mb-5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700/60 overflow-hidden">
                            {childrenByLayer.map((group, i) => (
                                <div
                                    key={group.layer?.id ?? i}
                                    className={cn(
                                        'px-3.5 py-2.5',
                                        i > 0 && 'border-t border-slate-100 dark:border-slate-700/50'
                                    )}
                                >
                                    <div className="flex items-center gap-2 mb-1.5">
                                        <div
                                            className="w-2 h-2 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: group.layer?.color ?? '#888' }}
                                        />
                                        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                            Currently in {group.layer?.name ?? 'Unknown'}
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {group.children.slice(0, 5).map(name => (
                                            <span
                                                key={name}
                                                className="text-xs px-2 py-0.5 rounded-md bg-white dark:bg-slate-700/80 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-600/50"
                                            >
                                                {name}
                                            </span>
                                        ))}
                                        {group.children.length > 5 && (
                                            <span className="text-xs px-2 py-0.5 text-slate-400">
                                                +{group.children.length - 5} more
                                            </span>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Target */}
                        <div className="flex items-center gap-2 mb-5 px-3.5 py-2.5 rounded-xl bg-emerald-50/80 dark:bg-emerald-900/20 border border-emerald-200/60 dark:border-emerald-700/40">
                            <ArrowRight className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                            <span className="text-sm text-emerald-700 dark:text-emerald-300">
                                All will move to{' '}
                                <span
                                    className="inline-flex items-center gap-1.5 font-semibold"
                                >
                                    <span
                                        className="w-2 h-2 rounded-full inline-block"
                                        style={{ backgroundColor: targetLayer?.color ?? '#3b82f6' }}
                                    />
                                    {targetLayer?.name ?? 'Unknown'}
                                </span>
                            </span>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-3">
                            <button
                                onClick={onCancel}
                                className={cn(
                                    'flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150',
                                    'text-slate-600 dark:text-slate-300',
                                    'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700',
                                    'border border-slate-200 dark:border-slate-600',
                                    'active:scale-[0.98]'
                                )}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={onConfirm}
                                className={cn(
                                    'flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors duration-150',
                                    'text-white',
                                    'shadow-md hover:shadow-lg',
                                    'active:scale-[0.98]'
                                )}
                                style={{
                                    background: `linear-gradient(135deg, ${targetLayer?.color ?? '#3b82f6'}, ${targetLayer?.color ?? '#3b82f6'}cc)`,
                                }}
                            >
                                Move {count === 1 ? 'child' : `all ${count}`}
                            </button>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}
