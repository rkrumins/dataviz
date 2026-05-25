/**
 * Tone tokens shared by every row in the visual query builder.
 *
 * One row card design (RowCard atom) consumes these to encode meaning
 * through a left-accent stripe + subtle gradient tint:
 *
 *   neutral — a leaf condition (TextPredicate, TagPredicate, …)
 *   and     — an AND group ("ALL")
 *   or      — an OR group ("ANY")
 *   not     — a NOT group ("invert")
 *
 * The same tokens drive the active state of the OperatorPill and the
 * coloured chip used by RowJoiner — so a leaf, its op header, and the
 * joiner between siblings all read as one visual family.
 */
export type RowTone = 'neutral' | 'and' | 'or' | 'not'


export type OpTone = Exclude<RowTone, 'neutral'>


export interface ToneStyle {
    /** Tailwind classes for the 3px left-accent stripe pseudo-element. */
    stripe: string
    /** Tailwind ``from-`` ``to-`` gradient classes for the card body. */
    bg: string
    /** Tailwind text colour for the operator label / active pill. */
    ink: string
    /** Short human label shown on the pill ("ALL", "ANY", "NOT"). */
    label: string
    /** Long-form helper ("and", "or", "invert"). */
    sub: string
}


export const TONE_STYLES: Record<RowTone, ToneStyle> = {
    neutral: {
        stripe: 'before:bg-glass-border/70',
        bg: 'from-canvas-base/55 to-canvas-base/30',
        ink: 'text-ink-muted',
        label: '',
        sub: '',
    },
    and: {
        stripe: 'before:bg-accent-lineage/55',
        bg: 'from-accent-lineage/[0.07] to-accent-lineage/[0.02]',
        ink: 'text-accent-lineage',
        label: 'ALL',
        sub: 'and',
    },
    or: {
        stripe: 'before:bg-amber-500/55',
        bg: 'from-amber-500/[0.07] to-amber-500/[0.02]',
        ink: 'text-amber-300',
        label: 'ANY',
        sub: 'or',
    },
    not: {
        stripe: 'before:bg-rose-500/55',
        bg: 'from-rose-500/[0.07] to-rose-500/[0.02]',
        ink: 'text-rose-300',
        label: 'NOT',
        sub: 'invert',
    },
}


/** Helpful long-form description used as an aria-label / tooltip. */
export const OP_HINTS: Record<OpTone, string> = {
    and: 'ALL — every condition must match',
    or:  'ANY — at least one condition matches',
    not: 'NOT — invert the result',
}


/**
 * Depth-attenuated background gradients used by NestedGroupCard at
 * depth ≥ 1. The accent stripe stays at full saturation (so the role
 * of the card is still glanceable) but the background tint is muted
 * so deeply-nested groups don't compete with the parent for
 * attention. Top-level groups (depth 0) use ``TONE_STYLES[op].bg``.
 */
export const NESTED_TONE_BG: Record<OpTone, string> = {
    and: 'from-accent-lineage/[0.035] to-accent-lineage/[0.01]',
    or:  'from-amber-500/[0.035] to-amber-500/[0.01]',
    not: 'from-rose-500/[0.035] to-rose-500/[0.01]',
}
