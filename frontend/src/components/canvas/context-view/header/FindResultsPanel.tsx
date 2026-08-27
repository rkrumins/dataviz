/**
 * FindResultsPanel — everything the header search shows once you type.
 *
 * Anchored under the field rather than docked as a rail, so the canvas
 * stays fully visible behind it: the point of searching here is watching
 * your own hierarchy light up as you narrow, and a rail that shoulders
 * the canvas aside takes that away.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Everything · Names & IDs · Descriptions · Tags           │  scope
 *   │ Reading this as: their name contains "revenue"           │  readback
 *   ├──────────────────────────────────────────────────────────┤
 *   │ 47 matches · 240 ms   ‹3 of 47›  Highlight Isolate Excl. │  MatchBar
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ▾ SALES · Orders (Data)                               12 │  HitsByParent
 *   │    ◆ revenue_gross      dataset                          │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ⚡ Open in Advanced Search — combine filters, save, share │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Everything below the scope row is a component the Advanced Search rail
 * already uses. That is deliberate: one search means one results shape,
 * one row renderer, one stepper, one isolate/exclude toggle, whichever
 * box the user typed into.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Info, Loader2, Sparkles, WifiOff } from 'lucide-react'
import { type FC, useCallback, useRef } from 'react'

import { HitsByParent } from '@/components/canvas/search/panel/HitsByParent'
import { MatchBar } from '@/components/canvas/search/panel/MatchBar'
import { formatPredicateAsSentence } from '@/components/canvas/search/panel/predicateSentence'
import {
    FIND_SCOPE_HINTS,
    FIND_SCOPE_LABELS,
    type FindScope,
} from '@/components/canvas/search/find/compileFind'
import { cn } from '@/lib/utils'
import { useFocusedMatchUrn } from '@/store/searchStore'
import type { FindInViewState } from '@/hooks/useFindInView'
import type { AncestorRef } from '@/types/search'


const SCOPE_ORDER: FindScope[] = ['everything', 'names', 'descriptions', 'tags']


export interface FindResultsPanelProps {
    state: FindInViewState
    viewId: string
    viewName?: string
    /** Walk + hydrate the ancestor spine and land on the hit. */
    onReveal: (urn: string, ancestorPath: AncestorRef[]) => void
    /** Open the entity drawer for a hit. */
    onOpen?: (urn: string) => void
    /** Fly the viewport to encompass every match. */
    onFrame?: () => void
    /** Hand the compiled query to the Advanced Search rail. */
    onEscalate: () => void
}


export const FindResultsPanel: FC<FindResultsPanelProps> = ({
    state, viewId, viewName, onReveal, onOpen, onFrame, onEscalate,
}) => {
    const scrollRef = useRef<HTMLDivElement>(null)
    const focusedUrn = useFocusedMatchUrn()

    const {
        hits, localCount, serverTotal, status, errorMessage,
        truncated, deadlineExceeded, elapsedMs, compiled, mode, scope,
    } = state

    // The stepper moves focus; walking the canvas to the focused match is
    // a separate, deliberate press, so stepping through 40 results doesn't
    // expand 40 ancestor spines behind you.
    const showFocusedOnCanvas = useCallback(() => {
        if (!focusedUrn) return
        const hit = hits.find((h) => h.node?.urn === focusedUrn)
        onReveal(focusedUrn, [...(hit?.ancestorPath ?? [])])
    }, [focusedUrn, hits, onReveal])

    const isRunning = status === 'running'
    const hasHits = hits.length > 0
    const showZeroState = !isRunning && !hasHits && status !== 'idle'

    return (
        <motion.div
            role="dialog"
            aria-label="Search results"
            initial={{ opacity: 0, y: -6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className={cn(
                'absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50',
                'w-[min(34rem,calc(100vw-2rem))] max-h-[60vh]',
                'flex flex-col overflow-hidden',
                'rounded-2xl glass-panel',
                'border border-black/[0.08] dark:border-white/[0.10]',
                'shadow-2xl shadow-black/20 dark:shadow-black/50',
            )}
        >
            {/* ---- Scope chips + readback ------------------------------- */}
            <div className="shrink-0 px-3 pt-3 pb-2 border-b border-black/[0.06] dark:border-white/[0.06]">
                <div
                    role="radiogroup"
                    aria-label="Which fields to search"
                    className="flex items-center gap-1 flex-wrap"
                >
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/60 mr-1">
                        Look in
                    </span>
                    {SCOPE_ORDER.map((s) => (
                        <button
                            key={s}
                            role="radio"
                            aria-checked={scope === s}
                            title={FIND_SCOPE_HINTS[s]}
                            onClick={() => state.setScope(s)}
                            className={cn(
                                'px-2 py-1 rounded-lg text-[11.5px] font-medium',
                                'border transition-all duration-150',
                                scope === s
                                    ? 'bg-accent-lineage/15 border-accent-lineage/45 text-accent-lineage'
                                    : cn(
                                        'border-transparent text-ink-muted',
                                        'hover:bg-black/[0.05] dark:hover:bg-white/[0.06] hover:text-ink',
                                    ),
                            )}
                        >
                            {FIND_SCOPE_LABELS[s]}
                        </button>
                    ))}
                </div>

                {/* Plain-English readback. Shown only once the user has
                    typed an operator — for a bare word the chips above
                    already say everything, and a sentence restating
                    "contains revenue" would be noise. */}
                <AnimatePresence>
                    {compiled.usedOperators && compiled.predicate && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-muted"
                        >
                            <Info className="w-3 h-3 mt-[3px] shrink-0 text-accent-lineage/70" strokeWidth={2.4} />
                            <span className="min-w-0">
                                {formatPredicateAsSentence(compiled.predicate)}
                            </span>
                        </motion.div>
                    )}
                </AnimatePresence>

                {compiled.error && (
                    <div className="mt-2 text-[11.5px] text-amber-600 dark:text-amber-400">
                        {compiled.error}
                    </div>
                )}
            </div>

            {/* ---- Match bar: counts, stepper, Highlight/Isolate/Exclude -- */}
            <div className="shrink-0 px-3 py-2">
                <MatchBar
                    count={serverTotal ?? (hasHits ? hits.length : null)}
                    elapsedMs={elapsedMs}
                    isRunning={isRunning}
                    errorMessage={errorMessage}
                    truncated={truncated}
                    deadlineExceeded={deadlineExceeded}
                    candidateCount={serverTotal}
                    onFrame={onFrame}
                    onShowFocusedOnCanvas={showFocusedOnCanvas}
                    onClear={state.clear}
                    viewId={viewId}
                />
                {/* Two counts, never one. The local tier can legitimately
                    find things the server's indexed text can't see
                    (property keys, numeric values), so collapsing them
                    into a single number would make one of the two lie. */}
                {hasHits && (
                    <div className="mt-1.5 px-0.5 text-[10.5px] text-ink-muted/70">
                        {localCount > 0 && (
                            <span>{localCount.toLocaleString()} on this canvas</span>
                        )}
                        {localCount > 0 && serverTotal !== null && <span> · </span>}
                        {serverTotal !== null && (
                            <span>
                                {serverTotal.toLocaleString()} in this view
                                {viewName ? ` (${viewName})` : ''}
                            </span>
                        )}
                        {status === 'localOnly' && (
                            <span className="ml-1 text-amber-600 dark:text-amber-400">
                                <WifiOff className="inline w-2.5 h-2.5 mr-0.5 -mt-px" strokeWidth={2.4} />
                                loaded entities only
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* ---- Results --------------------------------------------- */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
                {hasHits && (
                    <HitsByParent
                        hits={hits}
                        onReveal={onReveal}
                        onOpen={onOpen}
                        scrollElementRef={scrollRef}
                    />
                )}

                {isRunning && !hasHits && (
                    <div className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-ink-muted">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2.4} />
                        Searching this view…
                    </div>
                )}

                {showZeroState && (
                    <ZeroState
                        query={state.text.trim()}
                        viewName={viewName}
                        scope={scope}
                        usedOperators={compiled.usedOperators}
                        onWiden={() => state.setScope('everything')}
                        onLoosen={() => state.setMode('contains')}
                        canLoosen={mode !== 'contains'}
                        onEscalate={onEscalate}
                    />
                )}
            </div>

            {/* ---- Escalation ------------------------------------------ */}
            <button
                onClick={onEscalate}
                className={cn(
                    'shrink-0 flex items-center gap-2 px-3.5 py-2.5',
                    'border-t border-black/[0.06] dark:border-white/[0.06]',
                    'text-[12px] font-medium text-accent-lineage text-left',
                    'hover:bg-accent-lineage/[0.08] transition-colors',
                )}
            >
                <Sparkles className="w-3.5 h-3.5 shrink-0" strokeWidth={2.4} />
                <span>Open in Advanced Search</span>
                <span className="text-ink-muted/70 font-normal truncate">
                    — combine filters, save, share
                </span>
            </button>
        </motion.div>
    )
}


/**
 * Nothing matched. Say what was searched and offer the specific move
 * that would widen it, rather than a shrug — the user's next action is
 * almost always one of these three.
 */
const ZeroState: FC<{
    query: string
    viewName?: string
    scope: FindScope
    usedOperators: boolean
    canLoosen: boolean
    onWiden: () => void
    onLoosen: () => void
    onEscalate: () => void
}> = ({ query, viewName, scope, usedOperators, canLoosen, onWiden, onLoosen, onEscalate }) => (
    <div className="px-3 py-5">
        <div className="text-[13px] font-display font-semibold text-ink">
            No match for &ldquo;{query}&rdquo;{viewName ? ` in ${viewName}` : ''}
        </div>
        <div className="mt-1 text-[11.5px] text-ink-muted leading-relaxed">
            Searched {FIND_SCOPE_HINTS[scope].toLowerCase()} across every entity
            in this view, including containers you haven&rsquo;t opened.
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
            {scope !== 'everything' && (
                <ZeroAction onClick={onWiden}>
                    Look in <strong>everything</strong> — names, descriptions,
                    tags and property values
                </ZeroAction>
            )}
            {canLoosen && (
                <ZeroAction onClick={onLoosen}>
                    Loosen the match to <strong>contains</strong>
                </ZeroAction>
            )}
            {!usedOperators && (
                <ZeroAction onClick={onEscalate}>
                    Filter by tag, type or property instead
                </ZeroAction>
            )}
        </div>
    </div>
)


const ZeroAction: FC<{ onClick: () => void; children: React.ReactNode }> = ({
    onClick, children,
}) => (
    <button
        onClick={onClick}
        className={cn(
            'text-left px-2.5 py-1.5 rounded-lg text-[11.5px] text-ink-secondary',
            'border border-black/[0.07] dark:border-white/[0.08]',
            'hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.07] hover:text-ink',
            'transition-colors',
        )}
    >
        {children}
    </button>
)
