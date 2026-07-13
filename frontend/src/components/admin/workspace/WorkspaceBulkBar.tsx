/**
 * WorkspaceBulkBar — the floating bar shown while workspaces are selected.
 *
 * Deliberately the same shape and position as ExplorerBulkActions (fixed pill,
 * bottom-centre, springs up) so selection behaves identically wherever the user
 * meets it.
 *
 * `onDelete` is OPTIONAL and the parent omits it when the user can't delete every
 * selected workspace — the same guard the Explorer uses. Offering a bulk action
 * that will half-succeed with 403s is worse than not offering it.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { Trash2, X, Boxes } from 'lucide-react'
import { cn } from '@/lib/utils'

export function WorkspaceBulkBar({ selectedCount, onDelete, onClearSelection, blockedReason }: {
    selectedCount: number
    onDelete?: () => void
    onClearSelection: () => void
    /** Why deletion isn't offered — shown instead of the button, never silently. */
    blockedReason?: string
}) {
    return (
        <AnimatePresence>
            {selectedCount > 0 && (
                <motion.div
                    initial={{ y: 80, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 80, opacity: 0 }}
                    transition={{ type: 'spring', damping: 26, stiffness: 320 }}
                    className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50"
                >
                    <div className="flex items-center gap-2 pl-4 pr-2 py-2 rounded-2xl border border-glass-border bg-canvas-elevated/95 backdrop-blur-xl shadow-2xl shadow-black/20">
                        <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink whitespace-nowrap">
                            <Boxes className="w-4 h-4 text-ink-muted" />
                            {selectedCount} workspace{selectedCount === 1 ? '' : 's'} selected
                        </span>

                        <span className="w-px h-5 bg-glass-border mx-1" />

                        {onDelete ? (
                            <button
                                type="button"
                                onClick={onDelete}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold',
                                    'text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors',
                                )}
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete ({selectedCount})
                            </button>
                        ) : (
                            <span className="px-3 py-1.5 text-xs text-ink-muted">
                                {blockedReason ?? 'You can’t delete all of these'}
                            </span>
                        )}

                        <button
                            type="button"
                            onClick={onClearSelection}
                            title="Clear selection"
                            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
