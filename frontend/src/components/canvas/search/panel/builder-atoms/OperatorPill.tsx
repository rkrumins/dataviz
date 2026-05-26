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
import type { FC, ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { InfoTooltip } from './InfoTooltip'
import { TONE_STYLES, type OpTone } from './tones'


/**
 * Friendly tooltip copy aimed at non-technical users. Lives here
 * because it's tightly coupled to the pill UX; ``OP_HINTS`` in
 * tones.ts keeps the shorter one-liner copy used by other consumers.
 */
const TOOLTIP_COPY: Record<OpTone, ReactNode> = {
    and: (
        <span>
            <strong className="font-semibold text-accent-lineage">ALL</strong>{' '}
            — match <em>every</em> condition below. Narrows the search.
        </span>
    ),
    or: (
        <span>
            <strong className="font-semibold text-amber-300">ANY</strong>{' '}
            — match <em>at least one</em> condition below. Widens the search.
        </span>
    ),
    not: (
        <span>
            <strong className="font-semibold text-rose-300">NOT</strong>{' '}
            — invert: show only entities that <em>don&apos;t</em> match.
            Useful for &quot;everything except…&quot; patterns.
        </span>
    ),
}


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
            <InfoTooltip content={
                <>
                    {TOOLTIP_COPY[value]}
                    <div className="mt-1 text-ink-muted text-[10.5px]">
                        Click to switch.
                    </div>
                </>
            }>
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
                >
                    {meta.label}
                </button>
            </InfoTooltip>
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
                    <InfoTooltip
                        key={candidate}
                        content={TOOLTIP_COPY[candidate]}
                    >
                        <button
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => !disabled && onChange(candidate)}
                            disabled={disabled}
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
                    </InfoTooltip>
                )
            })}
        </div>
    )
}
