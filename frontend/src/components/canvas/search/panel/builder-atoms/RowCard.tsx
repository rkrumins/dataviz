/**
 * RowCard — the base card used by every row in the builder.
 *
 * A leaf condition (ConditionRow) renders inside a RowCard with
 * ``tone="neutral"``. A nested group (NestedGroupCard) renders inside
 * the same RowCard with ``tone="and" | "or" | "not"``. The card design
 * is identical aside from the left-accent stripe and the gradient
 * tint — so leaves and groups read as variants of one element.
 *
 * Incomplete state (a leaf with missing required fields) replaces the
 * border with the existing amber-dashed style.
 */
import type { FC, ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { TONE_STYLES, type RowTone } from './tones'


export interface RowCardProps {
    tone: RowTone
    children: ReactNode
    className?: string
    incomplete?: boolean
}


export const RowCard: FC<RowCardProps> = ({
    tone, children, className, incomplete,
}) => {
    const styles = TONE_STYLES[tone]
    return (
        <div className={cn(
            'relative rounded-xl border bg-gradient-to-br backdrop-blur-sm',
            'transition-colors',
            'pl-4 pr-3 py-3',
            // Tone-tinted body
            styles.bg,
            // Left-accent stripe — drawn as a pseudo-element so it
            // sits flush with the rounded corner.
            'before:absolute before:left-0 before:top-3 before:bottom-3',
            'before:w-[3px] before:rounded-full',
            styles.stripe,
            // Border + incomplete-state override
            incomplete
                ? 'border-dashed border-amber-500/40'
                : 'border-glass-border/70 hover:border-glass-border',
            className,
        )}>
            {children}
        </div>
    )
}
