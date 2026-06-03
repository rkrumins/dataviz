/**
 * BulkGroupActionBar — floating bar that slides up from the bottom of
 * the search panel when 2+ rows are selected. Lets the user wrap the
 * selected rows into a new AND / OR sub-group in one click.
 *
 * Mirrors the motion / chrome pattern used by ExplorerBulkActions so
 * the rest of the app feels consistent.
 *
 * Selection state lives in ``searchStore``:
 *   - selectionParent: path of the group whose children the user has
 *     selected (e.g. '' = root group, '0' = root's first child group)
 *   - selectedIndices: positions of the selected rows within that
 *     parent
 *
 * The bar is hidden when fewer than 2 rows are selected — wrapping a
 * single row already has a dedicated affordance (the per-row "⋯ →
 * Wrap in group" menu).
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Parentheses, X } from 'lucide-react'
import type { FC } from 'react'

import { cn } from '@/lib/utils'
import { useSearchStore } from '@/store/searchStore'

import { groupChildrenAtPath } from '../predicateComposition'
import { TONE_STYLES } from './tones'


export const BulkGroupActionBar: FC = () => {
    const selectionParent = useSearchStore((s) => s.selectionParent)
    const selectedIndices = useSearchStore((s) => s.selectedIndices)
    const draftPredicate = useSearchStore((s) => s.draftPredicate)
    const commitDraft = useSearchStore((s) => s.commitDraft)
    const clearRowSelection = useSearchStore((s) => s.clearRowSelection)

    const visible = selectionParent !== null && selectedIndices.length >= 2

    function applyGroup(op: 'and' | 'or') {
        if (!visible) return
        const next = groupChildrenAtPath(
            draftPredicate,
            selectionParent ?? '',
            selectedIndices,
            op,
        )
        commitDraft(next)
        clearRowSelection()
    }

    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    initial={{ y: 32, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 32, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    className={cn(
                        'absolute bottom-3 left-1/2 -translate-x-1/2 z-30',
                        'inline-flex items-center gap-2',
                        'rounded-xl border border-accent-lineage/40',
                        'bg-canvas-elevated/95 backdrop-blur-md',
                        'shadow-2xl shadow-black/50',
                        'px-2.5 py-2',
                    )}
                >
                    <div className="flex items-center gap-1.5 pr-1.5 border-r border-glass-border/50">
                        <span className={cn(
                            'inline-flex items-center justify-center w-5 h-5 rounded-md',
                            'bg-accent-lineage/15 text-accent-lineage',
                            'text-[10.5px] font-semibold',
                        )}>
                            {selectedIndices.length}
                        </span>
                        <span className="text-[11.5px] font-medium text-ink">
                            row{selectedIndices.length === 1 ? '' : 's'} selected
                        </span>
                    </div>

                    <span className="text-[10.5px] text-ink-muted/90 px-0.5">
                        Group as:
                    </span>

                    <GroupOpButton op="and" onClick={() => applyGroup('and')} />
                    <GroupOpButton op="or" onClick={() => applyGroup('or')} />

                    <div className="pl-1 border-l border-glass-border/50">
                        <button
                            type="button"
                            onClick={clearRowSelection}
                            className={cn(
                                'inline-flex items-center justify-center w-7 h-7 rounded-md',
                                'text-ink-muted/80 hover:text-ink hover:bg-glass/40',
                                'transition-colors',
                            )}
                            aria-label="Clear selection"
                            title="Clear selection"
                        >
                            <X className="w-3.5 h-3.5" strokeWidth={2.2} />
                        </button>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}


function GroupOpButton({
    op, onClick,
}: { op: 'and' | 'or'; onClick: () => void }) {
    const meta = TONE_STYLES[op]
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md',
                'text-[11px] font-semibold uppercase tracking-wider',
                'border transition-all',
                op === 'and'
                    ? 'border-accent-lineage/40 bg-accent-lineage/12 text-accent-lineage hover:bg-accent-lineage/20'
                    : 'border-amber-500/40 bg-amber-500/12 text-amber-300 hover:bg-amber-500/20',
            )}
            title={`Wrap selected rows in a new ${meta.label} (${meta.sub}) group`}
        >
            <Parentheses className="w-3 h-3" strokeWidth={2.2} />
            {meta.label}
            <span className="text-[9px] opacity-60 uppercase">{meta.sub}</span>
        </button>
    )
}
