/**
 * RowSelectionCheckbox — hover-revealed checkbox shown on the left
 * of each row in the builder. Drives the multi-select "Group selected
 * as AND / OR" affordance.
 *
 * Visual rules:
 *   - Hidden when the row is unhovered AND unselected — keeps the
 *     row clean by default.
 *   - Subtle ring when hovered but unchecked — "you can click this".
 *   - Accent-coloured fill when checked.
 *   - Permanently visible once the row is selected (so it doesn't
 *     disappear when the user moves their cursor to the action bar).
 *
 * Caller responsibility: pass ``selected`` and ``onToggle``. The atom
 * is dumb — selection state lives in ``searchStore``.
 */
import { Check } from 'lucide-react'
import type { FC } from 'react'

import { cn } from '@/lib/utils'


export interface RowSelectionCheckboxProps {
    selected: boolean
    onToggle: () => void
    /** Hide the box completely (e.g. in contexts where multi-select
     *  isn't supported — wrap-only rows, deeply-nested rows). */
    disabled?: boolean
    /** Accessibility label. */
    ariaLabel?: string
}


export const RowSelectionCheckbox: FC<RowSelectionCheckboxProps> = ({
    selected, onToggle, disabled, ariaLabel = 'Select row',
}) => {
    if (disabled) return null
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={ariaLabel}
            onClick={(e) => {
                // Don't bubble up to the row's click handler (which
                // can shift focus into an editor).
                e.stopPropagation()
                onToggle()
            }}
            className={cn(
                'inline-flex items-center justify-center shrink-0',
                'w-4 h-4 rounded-[5px]',
                'border transition-all',
                selected
                    ? 'bg-accent-lineage border-accent-lineage text-white shadow-sm shadow-accent-lineage/30'
                    : cn(
                        'border-glass-border/70 bg-canvas-base/40',
                        // Visible when hovered or when the parent row
                        // is hovered (group-hover); muted otherwise.
                        'opacity-0 group-hover/row:opacity-100',
                        'hover:border-accent-lineage/60 hover:bg-accent-lineage/10',
                    ),
            )}
        >
            {selected && <Check className="w-2.5 h-2.5" strokeWidth={3.5} />}
        </button>
    )
}
