/**
 * WhatThisMeansDisclosure — collapsible card that explains the current
 * draft predicate in plain English. Pinned above the conditions list
 * inside QueryCard so non-technical / business users can verify what
 * the query *actually* does before running it.
 *
 * Mirrors CypherDisclosure's chrome (chevron toggle, border-on-open)
 * for a consistent disclosure family, but uses a slightly warmer
 * presentation (gradient header tint + Sparkles icon) because this is
 * the user's primary onboarding surface — not a power-user fallback.
 *
 * Collapsed by default so power users aren't slowed down. The header
 * stays informative even when collapsed: shows a one-line summary
 * ("Match all of 2 filters" / "Match any of 3 filters" / etc.) so the
 * user can glance and decide whether to expand.
 */
import { ChevronDown, Sparkles } from 'lucide-react'
import { type FC, useState } from 'react'

import { cn } from '@/lib/utils'
import { useDraftPredicate } from '@/store/searchStore'

import { formatPredicateAsSentence } from './predicateSentence'
import { rootGroupOp, topLevelConditions } from './predicateComposition'


export const WhatThisMeansDisclosure: FC = () => {
    const [open, setOpen] = useState(false)
    const draft = useDraftPredicate()

    const oneLiner = collapsedSummary(draft)

    return (
        <div className={cn(
            'rounded-xl border transition-colors',
            open
                ? 'border-accent-lineage/30 bg-gradient-to-b from-accent-lineage/[0.04] to-transparent'
                : 'border-glass-border/50 bg-canvas-base/20 hover:border-glass-border/80',
        )}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className={cn(
                    'w-full flex items-center justify-between gap-3 px-3 py-2.5',
                    'text-left',
                )}
            >
                <span className="inline-flex items-center gap-2 min-w-0">
                    <span className={cn(
                        'inline-flex items-center justify-center w-5 h-5 rounded-md shrink-0',
                        'bg-accent-lineage/15 text-accent-lineage',
                    )}>
                        <Sparkles className="w-3 h-3" strokeWidth={2.2} />
                    </span>
                    <span className="flex flex-col leading-tight min-w-0">
                        <span className="text-[11.5px] font-semibold text-ink">
                            What this means
                        </span>
                        <span className="text-[10.5px] text-ink-muted/80 truncate">
                            {oneLiner}
                        </span>
                    </span>
                </span>
                <ChevronDown
                    className={cn(
                        'w-3.5 h-3.5 text-ink-muted/70 shrink-0 transition-transform',
                        open && 'rotate-180',
                    )}
                    strokeWidth={2.2}
                />
            </button>
            {open && (
                <div className={cn(
                    'px-3 pb-3 pt-2 border-t border-glass-border/40',
                    'text-[12px] text-ink leading-relaxed',
                )}>
                    {formatPredicateAsSentence(draft)}
                </div>
            )}
        </div>
    )
}


/**
 * One-line summary shown when the disclosure is collapsed. Goal: tell
 * the user at a glance how many filters there are and how they
 * combine, so they can decide whether to expand.
 */
function collapsedSummary(draft: Parameters<typeof formatPredicateAsSentence>[0]): string {
    if (!draft) return 'No filters yet — add a condition to start.'
    const op = rootGroupOp(draft)
    const tops = topLevelConditions(draft)
    if (tops.length === 0) return 'No filters yet.'
    if (tops.length === 1) {
        if (op === 'not') return 'Inverts one condition.'
        return 'One condition.'
    }
    const joiner =
        op === 'and' ? 'all of'
            : op === 'or' ? 'any of'
                : 'inverts'
    return `Matches ${joiner} ${tops.length} filter${tops.length === 1 ? '' : 's'}.`
}
