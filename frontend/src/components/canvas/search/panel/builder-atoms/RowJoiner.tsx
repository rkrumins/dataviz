/**
 * RowJoiner — the small AND / OR chip rendered between two sibling
 * rows. Used at the root (between top-level conditions) and inside
 * groups (between children). One component, one visual identity.
 *
 * When ``onChange`` is supplied the chip is clickable and cycles
 * between AND and OR — useful at the root where the user controls the
 * top-level op without scrolling back up to the header. Inside a
 * group, the joiner is typically read-only (the group's own header
 * carries the op toggle) so ``onChange`` is omitted.
 */
import type { FC } from 'react'

import { OperatorPill } from './OperatorPill'


export interface RowJoinerProps {
    /** Tolerates ``'not'`` for type-flow convenience but renders
     *  nothing in that case — NOT groups have at most one child so a
     *  between-siblings joiner is meaningless. */
    op: 'and' | 'or' | 'not'
    /** When provided, the chip is clickable and toggles AND ↔ OR. */
    onChange?: (next: 'and' | 'or') => void
    disabled?: boolean
}


export const RowJoiner: FC<RowJoinerProps> = ({ op, onChange, disabled }) => {
    if (op === 'not') return null
    return (
        <div className="flex items-center justify-center -my-0.5">
            <OperatorPill
                value={op}
                onChange={(next) => {
                    if (next === 'not') return
                    onChange?.(next)
                }}
                segments="two"
                size="sm"
                compact={!onChange}
                disabled={disabled || !onChange}
            />
        </div>
    )
}
