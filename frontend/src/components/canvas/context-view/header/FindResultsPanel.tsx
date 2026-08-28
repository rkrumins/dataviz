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
 *   │ 4 already on this canvas · showing 100  Load all matches  │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ▾ WAREHOUSE · Snowflake                         214  📍  │  Grouped-
 *   │    ◆ revenue_gross      GOLD ›            dataset        │  HitBrowser
 *   │ ▸ SOURCE · Commerce                               3  📍  │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ⚡ Open in Advanced Search — combine filters, save, share │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The scope row, the stepper and the isolate/exclude toggle are the same
 * components the Advanced Search rail uses. That is deliberate: one
 * search means one results shape, one row renderer, one stepper, one
 * isolate/exclude toggle, whichever box the user typed into. The results
 * list itself is `GroupedHitBrowser` rather than the rail's
 * `HitsByParent`, because this panel groups by the canvas's top-level
 * nodes — which only the canvas knows — and has to stay grouped and
 * browsable at 500 hits, where the rail's grouping bails out to a flat
 * list.
 *
 * The escalation to Advanced Search is pinned outside the scroll area,
 * so it stays one click away however far down a long result list the
 * user has scrolled.
 */
import { AnimatePresence, motion } from 'framer-motion'
import {
    AlertTriangle, Clock, Info, Loader2, Pin, RotateCw, Sparkles, WifiOff,
} from 'lucide-react'
import { type FC, forwardRef, useCallback, useRef } from 'react'

import { GroupedHitBrowser } from '@/components/canvas/search/panel/GroupedHitBrowser'
import type { CanvasRoot } from '@/components/canvas/search/panel/groupHitsByTopLevel'
import { SearchOmnibox } from '@/components/canvas/search/panel/omnibox/SearchOmnibox'
import { stringifyPredicate } from '@/components/canvas/search/panel/predicateDsl'
import { useOmniboxFacets } from '@/components/canvas/search/panel/useOmniboxFacets'
import { MatchBar } from '@/components/canvas/search/panel/MatchBar'
import { formatPredicateAsSentence } from '@/components/canvas/search/panel/predicateSentence'
import {
    FIND_MODE_LABELS,
    FIND_SCOPE_HINTS,
    FIND_SCOPE_LABELS,
    type FindMode,
    type FindScope,
} from '@/components/canvas/search/find/compileFind'
import { extractErrorMessageFromText } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import {
    useCanvasFilterMode,
    useFocusedMatchUrn,
    useRecentQueries,
    useSearchStore,
} from '@/store/searchStore'
import type { FindInViewState } from '@/hooks/useFindInView'
import type { AncestorRef, Predicate } from '@/types/search'


const SCOPE_ORDER: FindScope[] = ['everything', 'names', 'descriptions', 'tags']
const MODE_ORDER: FindMode[] = ['contains', 'startsWith', 'exact']

const MODE_HINTS: Record<FindMode, string> = {
    contains: 'Match anywhere in the text',
    startsWith: 'Match from the beginning',
    exact: 'Match the whole value, nothing more',
}


export interface FindResultsPanelProps {
    /** Fixed-position coordinates from the field's anchor measurement —
     *  this panel is portaled to the body, so it cannot lay itself out
     *  relative to a trigger it is no longer inside. */
    style?: React.CSSProperties
    state: FindInViewState
    viewId: string
    viewName?: string
    /** Walk + hydrate the ancestor spine and land on the hit. */
    onReveal: (urn: string, ancestorPath: AncestorRef[]) => void
    /** Open the entity drawer for a hit. */
    onOpen?: (urn: string) => void
    /** The canvas's top-level nodes, by URN. Results group under these so
     *  the list is arranged the way the canvas is. Empty is valid. */
    canvasRoots: ReadonlyMap<string, CanvasRoot>
    /** Scroll the canvas to a group's top-level node. */
    onRevealRoot?: (root: CanvasRoot) => void
    /** Fly the viewport to encompass every match. */
    onFrame?: () => void
    /** Hand the compiled query to the Advanced Search rail. */
    onEscalate: () => void
}


export const FindResultsPanel = forwardRef<HTMLDivElement, FindResultsPanelProps>(
    function FindResultsPanel({
        state, viewId, viewName, style, canvasRoots,
        onReveal, onOpen, onRevealRoot, onFrame, onEscalate,
    }, ref) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const focusedUrn = useFocusedMatchUrn()
    const filterMode = useCanvasFilterMode()

    const {
        hits, localCount, serverTotal, status, errorMessage,
        truncated, deadlineExceeded, elapsedMs, compiled, mode, scope,
        hasMore, loadMore, isLoadingMore, loadAll, isLoadingAll, retry,
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
    // The server's total is authoritative for the view — it counts matches
    // nobody has expanded. But the local tier reads a few fields the
    // server's indexed text doesn't carry (property keys, numeric values),
    // so it can legitimately hold rows the server didn't count. Take the
    // larger: a headline that says "0 in this view" over a list of three
    // rows is worse than either number alone.
    const totalMatches = serverTotal !== null
        ? Math.max(serverTotal, hits.length)
        : hits.length
    const showZeroState = !isRunning && !hasHits && status !== 'idle'
    const isIdle = status === 'idle'

    // A server failure with local matches still on screen is a PARTIAL
    // failure, and MatchBar treats any error as total — it hides the
    // stepper and the Highlight / Isolate / Exclude cluster. That is the
    // right contract for the Advanced rail, where an error means no
    // results at all, and the wrong one here, where the local tier is
    // designed to survive the server going down. So the error only
    // reaches MatchBar when there is genuinely nothing to act on;
    // otherwise it renders below as its own line and the controls stay.
    const failed = status === 'error' && errorMessage !== null
    const partialFailure = failed && hasHits

    // The same facets, the same ranking, the same component the Advanced
    // builder uses. A clicked suggestion lands in the box as DSL text
    // rather than as hidden state, so the user can see it, edit it, and
    // delete it like any other word they typed — and the readback above
    // explains it back to them in English.
    const facets = useOmniboxFacets(viewId || null)
    const appendFilter = useCallback((predicate: Predicate) => {
        const fragment = stringifyPredicate(predicate)
        if (!fragment) return
        const current = state.text.trim()
        state.setText(current ? `${current} ${fragment}` : fragment)
    }, [state])

    return (
        <motion.div
            ref={ref}
            role="dialog"
            aria-label="Search results"
            style={style}
            initial={{ opacity: 0, y: -6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            className={cn(
                'z-[60] flex flex-col overflow-hidden',
                'rounded-2xl glass-panel',
                'border border-black/[0.08] dark:border-white/[0.10]',
                'shadow-2xl shadow-black/20 dark:shadow-black/50',
            )}
        >
            {/* ---- Scope chips + readback -------------------------------
                Hidden while idle: with nothing typed there is nothing for
                them to scope, and the launcher below is the useful thing
                to show instead. */}
            {!isIdle && (
            <div className="shrink-0 px-3 pt-3 pb-2 border-b border-black/[0.06] dark:border-white/[0.06]">
                {/* How to match, then where to look. Both shape the query,
                    so they sit together and next to the results they
                    change — in the field they competed with the text being
                    typed and had no room to explain themselves. */}
                <div
                    role="radiogroup"
                    aria-label="How to match"
                    className="flex items-center gap-1 flex-wrap mb-1.5"
                >
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/60 mr-1">
                        Match
                    </span>
                    {MODE_ORDER.map((m) => (
                        <button
                            key={m}
                            role="radio"
                            aria-checked={mode === m}
                            title={MODE_HINTS[m]}
                            onClick={() => state.setMode(m)}
                            className={cn(
                                'px-2 py-1 rounded-lg text-[11.5px] font-medium',
                                'border transition-all duration-150',
                                mode === m
                                    ? 'bg-accent-lineage/15 border-accent-lineage/45 text-accent-lineage'
                                    : cn(
                                        'border-transparent text-ink-muted',
                                        'hover:bg-black/[0.05] dark:hover:bg-white/[0.06] hover:text-ink',
                                    ),
                            )}
                        >
                            {FIND_MODE_LABELS[m]}
                        </button>
                    ))}
                </div>
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
            )}

            {/* ---- Match bar: counts, stepper, Highlight/Isolate/Exclude -- */}
            {!isIdle && (
            <div className="shrink-0 px-3 py-2">
                <MatchBar
                    count={totalMatches}
                    elapsedMs={elapsedMs}
                    isRunning={isRunning}
                    errorMessage={partialFailure ? null : humaneError(errorMessage)}
                    truncated={truncated}
                    deadlineExceeded={deadlineExceeded}
                    candidateCount={serverTotal}
                    onFrame={onFrame}
                    onShowFocusedOnCanvas={showFocusedOnCanvas}
                    onClear={state.clear}
                    viewId={viewId}
                />
                {/* The headline count is the whole view. This line says how
                    much of it is on screen — the thing the old box hid by
                    only ever searching what had loaded. */}
                {hasHits && (
                    <div className="mt-1.5 px-0.5 text-[10.5px] text-ink-muted/70">
                        {localCount > 0 && localCount < totalMatches && (
                            <span>
                                {localCount.toLocaleString()} already on this canvas
                                {viewName ? `, the rest deeper in ${viewName}` : ''}
                            </span>
                        )}
                        {hits.length < totalMatches && (
                            <span>
                                {localCount > 0 && localCount < totalMatches ? ' · ' : ''}
                                showing {hits.length.toLocaleString()} so far
                            </span>
                        )}
                        {/* Scrolling loads the next page on its own, but a
                            user who wants the WHOLE set — to isolate on it,
                            to trust the roll-up counts, to read it top to
                            bottom — shouldn't have to scroll to the end of a
                            partial list to ask for it. */}
                        {hasMore && (
                            <button
                                onClick={loadAll}
                                disabled={isLoadingAll || isLoadingMore}
                                className={cn(
                                    'ml-1.5 font-semibold text-accent-lineage',
                                    'hover:underline disabled:opacity-60 disabled:no-underline',
                                )}
                            >
                                {isLoadingAll
                                    ? 'Loading every match…'
                                    : 'Load all matches'}
                            </button>
                        )}
                        {status === 'localOnly' && (
                            <span className="text-amber-600 dark:text-amber-400">
                                <WifiOff className="inline w-2.5 h-2.5 mr-0.5 -mt-px" strokeWidth={2.4} />
                                entities loaded on this canvas only
                            </span>
                        )}
                    </div>
                )}
                {/* Isolate and Exclude act on the matches that have LOADED.
                    While pages remain, "only these" would be a false claim —
                    the canvas would hide matches this panel just counted. */}
                {hasMore && hasHits && filterMode !== 'highlight' && (
                    <div className="mt-1.5 px-0.5 flex items-start gap-1.5 text-[10.5px] leading-snug text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="w-2.5 h-2.5 mt-[3px] shrink-0" strokeWidth={2.4} />
                        <span>
                            {filterMode === 'isolate' ? 'Isolate' : 'Exclude'} is
                            {' '}acting on the {hits.length.toLocaleString()} matches loaded
                            so far, not all {totalMatches.toLocaleString()}. Load the rest
                            to cover them.
                        </span>
                    </div>
                )}
                {partialFailure && (
                    <PartialFailureNotice
                        detail={errorMessage}
                        localCount={hits.length}
                        viewName={viewName}
                        onRetry={retry}
                    />
                )}
            </div>
            )}

            {/* ---- Results --------------------------------------------- */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
                {hasHits && (
                    <GroupedHitBrowser
                        hits={hits}
                        canvasRoots={canvasRoots}
                        scrollElementRef={scrollRef}
                        onReveal={onReveal}
                        onOpen={onOpen}
                        onRevealRoot={onRevealRoot}
                        hasMore={hasMore}
                        loadMore={loadMore}
                        isLoadingMore={isLoadingMore}
                        loadAll={loadAll}
                        isLoadingAll={isLoadingAll}
                        serverTotal={serverTotal}
                    />
                )}

                {isIdle && (
                    <IdleLauncher
                        viewId={viewId}
                        viewName={viewName}
                        onPick={(entry) => state.setText(stringifyPredicate(entry))}
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

            {/* ---- Narrow it down -------------------------------------- */}
            <div className="shrink-0 px-2 py-1.5 border-t border-black/[0.06] dark:border-white/[0.06]">
                <SearchOmnibox
                    variant="inline"
                    onAdd={appendFilter}
                    entityTypes={facets.entityTypes}
                    tagValues={facets.tagValues}
                    propertyKeys={facets.propertyKeys}
                    valueSamples={facets.valueSamples}
                    layers={facets.layers}
                    discoveryLoading={facets.isLoading}
                />
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
})


/**
 * Turn a transport error into something a business user can read.
 *
 * ``RemoteGraphProvider`` builds ``API Error 500: {"detail": ...}`` and
 * this panel used to render it verbatim, which is how a JSON blob ends
 * up in front of someone looking for a table. Pull the human sentence
 * out of the body when there is one; otherwise say what happened without
 * pretending to know why.
 */
function humaneError(raw: string | null): string | null {
    if (!raw) return null
    const body = raw.match(/^API Error \d{3}: ([\s\S]*)$/)
    if (!body) return raw
    const extracted = extractErrorMessageFromText(body[1].trim(), '')
    // A JSON dump that survived extraction is still a JSON dump.
    if (!extracted || extracted.trimStart().startsWith('{')) {
        return 'This view couldn\u2019t be searched on the server just now.'
    }
    return extracted
}


/**
 * The server tier failed but the local one didn't.
 *
 * Says which half of the answer survived, offers the one action that
 * could fix it, and keeps the technical detail available for support
 * without putting it in the user's face.
 */
const PartialFailureNotice: FC<{
    detail: string | null
    localCount: number
    viewName?: string
    onRetry: () => void
}> = ({ detail, localCount, viewName, onRetry }) => {
    const humane = humaneError(detail)
    return (
        <div className={cn(
            'mt-1.5 px-2 py-1.5 rounded-lg',
            'bg-rose-500/[0.07] border border-rose-500/25',
        )}>
            <div className="flex items-start gap-1.5 text-[10.5px] leading-snug text-rose-700 dark:text-rose-300">
                <AlertTriangle className="w-2.5 h-2.5 mt-[3px] shrink-0" strokeWidth={2.4} />
                <span className="min-w-0">
                    Couldn&rsquo;t search the rest of
                    {viewName ? ` ${viewName}` : ' this view'} — showing the
                    {' '}{localCount.toLocaleString()} match{localCount === 1 ? '' : 'es'}
                    {' '}already on this canvas.
                </span>
                <button
                    onClick={onRetry}
                    className={cn(
                        'shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md',
                        'font-semibold hover:bg-rose-500/15 transition-colors',
                    )}
                >
                    <RotateCw className="w-2.5 h-2.5" strokeWidth={2.6} />
                    Retry
                </button>
            </div>
            {humane && (
                <details className="mt-1 pl-4">
                    <summary className="cursor-pointer text-[10px] text-ink-muted/70 hover:text-ink-muted">
                        Details for support
                    </summary>
                    <p className="mt-0.5 font-mono text-[10px] text-ink-muted/80 break-all">
                        {humane}
                    </p>
                </details>
            )}
        </div>
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


/**
 * What you searched last, per view.
 *
 * An empty search box is a worse starting point than it looks: the user
 * knows what they want but not what this view calls it. Their own last
 * few queries are the highest-signal thing to offer, and they cost
 * nothing — the store already records every dispatched query, pinned
 * ones first.
 */
const IdleLauncher: FC<{
    viewId: string
    viewName?: string
    onPick: (predicate: Predicate) => void
}> = ({ viewId, viewName, onPick }) => {
    const recents = useRecentQueries(viewId || null)
    const togglePin = useSearchStore((s) => s.togglePinRecent)

    if (recents.length === 0) {
        return (
            <div className="px-3 py-4 text-[12px] text-ink-muted leading-relaxed">
                Type to search every entity in
                {viewName ? <strong className="text-ink"> {viewName}</strong> : ' this view'}
                {' '}— names, descriptions, tags and property values, at any
                depth, whether or not you&rsquo;ve opened the container it
                lives in. Or pick a filter below.
            </div>
        )
    }

    return (
        <div className="px-1 py-2">
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/60">
                Recent in this view
            </div>
            {recents.slice(0, 6).map((entry) => (
                <div key={entry.timestamp} className="flex items-center gap-1 group/recent">
                    <button
                        onClick={() => onPick(entry.predicate)}
                        className={cn(
                            'flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left',
                            'text-[12px] text-ink-secondary hover:text-ink',
                            'hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors',
                        )}
                    >
                        {entry.pinned
                            ? <Pin className="w-3 h-3 shrink-0 text-accent-lineage" strokeWidth={2.4} />
                            : <Clock className="w-3 h-3 shrink-0 text-ink-muted/50" strokeWidth={2.4} />}
                        <span className="truncate font-mono text-[11.5px]">
                            {entry.name ?? entry.label}
                        </span>
                    </button>
                    <button
                        onClick={() => togglePin(entry.timestamp)}
                        aria-label={entry.pinned ? 'Unpin this search' : 'Pin this search'}
                        className={cn(
                            'p-1 rounded-md shrink-0 transition-opacity',
                            'text-ink-muted/60 hover:text-accent-lineage',
                            entry.pinned ? 'opacity-100' : 'opacity-0 group-hover/recent:opacity-100',
                        )}
                    >
                        <Pin className="w-3 h-3" strokeWidth={2.4} />
                    </button>
                </div>
            ))}
        </div>
    )
}
