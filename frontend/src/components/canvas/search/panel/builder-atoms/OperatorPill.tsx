/**
 * OperatorPill — the segmented AND / OR / NOT toggle used everywhere
 * an operator is shown.
 *
 *   - Root match header (QueryCard): 3-segment ALL / ANY / NOT
 *   - Nested group header (NestedGroupCard): 3-segment ALL / ANY / NOT
 *   - Joiner between siblings (RowJoiner): 2-segment ALL / ANY view
 *     (NOT groups have at most one child so a between-rows joiner
 *      doesn't exist for them)
 *
 * Active segment uses its tone (purple AND, amber OR, rose NOT) on a
 * soft canvas chip. Inactive segments are muted ink with a hover lift.
 */
import type { FC } from 'react'

import { cn } from '@/lib/utils'

import { OP_HINTS, TONE_STYLES, type OpTone } from './tones'


export type OperatorSize = 'sm' | 'md'


export interface OperatorPillProps {
    value: OpTone
    onChange: (next: OpTone) => void
    /** ``'three'`` (default) shows AND / OR / NOT. ``'two'`` hides
     *  NOT — used by the between-siblings joiner. */
    segments?: 'three' | 'two'
    size?: OperatorSize
    disabled?: boolean
    /** When set, render as a clickable read-only chip (no segmented
     *  layout) showing only the active op. Used inline between
     *  sibling rows when ``onChange`` is provided. */
    compact?: boolean
}


const SEGMENT_VALUES_3: readonly OpTone[] = ['and', 'or', 'not']
const SEGMENT_VALUES_2: readonly OpTone[] = ['and', 'or']


export const OperatorPill: FC<OperatorPillProps> = ({
    value, onChange, segments = 'three', size = 'md', disabled, compact,
}) => {
    const values = segments === 'three' ? SEGMENT_VALUES_3 : SEGMENT_VALUES_2
    const padX = size === 'sm' ? 'px-2 py-0' : 'px-2.5 py-0.5'
    const textSize = size === 'sm' ? 'text-[10px]' : 'text-[10.5px]'

    if (compact) {
        const meta = TONE_STYLES[value]
        return (
            <button
                type="button"
                onClick={() => {
                    if (disabled) return
                    // Cycle through the available segments.
                    const idx = values.indexOf(value)
                    const next = values[(idx + 1) % values.length]
                    onChange(next)
                }}
                disabled={disabled}
                className={cn(
                    'inline-flex items-center gap-1 rounded-full',
                    'border border-glass-border/70 bg-canvas-base/50',
                    padX, textSize,
                    'font-semibold uppercase tracking-wider',
                    meta.ink,
                    'hover:bg-canvas-base/80 transition-colors',
                    disabled && 'opacity-50 cursor-not-allowed',
                )}
                title={`${OP_HINTS[value]} — click to switch`}
            >
                {meta.label}
            </button>
        )
    }

    return (
        <div
            role="radiogroup"
            className={cn(
                'inline-flex rounded-full p-0.5',
                'border border-glass-border/70 bg-canvas-elevated/50',
                'backdrop-blur-sm',
            )}
        >
            {values.map((candidate) => {
                const meta = TONE_STYLES[candidate]
                const active = value === candidate
                return (
                    <button
                        key={candidate}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => !disabled && onChange(candidate)}
                        disabled={disabled}
                        title={OP_HINTS[candidate]}
                        className={cn(
                            'inline-flex items-center gap-1 rounded-full',
                            'font-semibold uppercase tracking-wider',
                            'transition-colors',
                            padX, textSize,
                            active
                                ? cn(meta.ink, 'bg-canvas-base/50 shadow-sm')
                                : 'text-ink-muted/70 hover:text-ink',
                            disabled && 'opacity-50 cursor-not-allowed',
                        )}
                    >
                        {meta.label}
                        <span className={cn(
                            'text-[8.5px] uppercase tracking-wider',
                            active ? 'opacity-60' : 'opacity-40',
                        )}>
                            {meta.sub}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}
