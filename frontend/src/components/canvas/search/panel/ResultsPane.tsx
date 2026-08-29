/**
 * Persistent results pane.
 *
 * Rendered by SearchMapPanel only when a search is running, has results,
 * or has errored — the AskBar above IS the empty state, so this pane
 * never shows an "idle" coachmark. The count + stepper + canvas-filter
 * controls live in ``./MatchBar.tsx``; this component owns only the
 * scrollable body that paints aggregates / hits / paths / error AND
 * the focused-match auto-reveal effect.
 */
import { Filter, X } from 'lucide-react'
import { type FC, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { useSchemaStore } from '@/store/schema'
import {
    useAncestorMatchCounts,
    useDraftPredicate,
    useFocusedMatchUrn,
} from '@/store/searchStore'
import type {
    AncestorRef,
    SearchAggregateBucket,
    SearchHit,
    SearchQuery,
    SearchResultPage,
} from '@/types/search'

import { AggregateBucketCard } from '../AggregateBucketCard'
import { PathResultPanel } from '../PathResultPanel'
import { HIT_ROW_ID_PREFIX } from '../SearchHitRow'
import { ZeroResultsDiagnostic } from '../ZeroResultsDiagnostic'
import { useViewSearchSessionOptional } from '../session/ViewSearchSessionContext'

import { ErrorView } from './ErrorView'
import { HitsByLayer, groupHitsByLayer } from './HitsByLayer'
import { HitsByParent } from './HitsByParent'
import { RunningSkeleton } from './RunningSkeleton'
import { findScopeCondition } from './predicateComposition'


/**
 * Which aggregations still deserve a bucket CARD.
 *
 * The container roll-up (``by: 'parent'``, and ``by: 'ancestor'`` once
 * the backend ships it) is what makes the canvas badges and the panel's
 * per-container counts exact — up to 20 000 buckets of it. On a canvas
 * with a session those numbers are already rendered, in place, by the
 * layer › container grouping below; painting them again as a wall of
 * cards buries the results the user asked for. So there they are
 * badge-only, and every other facet (type, tag, property) still gets its
 * card.
 *
 * The canvases whose only search IS this panel have no such grouping,
 * and their bucket cards ARE the orientation step — they keep the lot.
 *
 * Buckets arrive as one list per requested aggregation, in request
 * order; a list we cannot attribute to a spec is kept, because
 * "unattributable" is not the same as "container-shaped" and dropping it
 * would silently lose a facet.
 */
export function visibleFacetBuckets(
    result: SearchResultPage,
    query: SearchQuery,
    hasSession: boolean,
): SearchAggregateBucket[] {
    const lists = result.aggregates ?? []
    if (!hasSession) return lists.flat()
    const specs = query.options?.aggregations ?? []
    return lists
        .filter((_, i) => {
            const by = specs[i]?.by as string | undefined
            return by !== 'parent' && by !== 'ancestor'
        })
        .flat()
}


export interface ResultsPaneProps {
    view: PanelView
    onScopeToGroup: (bucket: {
        ancestorUrn: string
        ancestorDisplayName: string
        ancestorEntityType: string
    }) => void
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
    /** W2.2 — Fetch the next page of hits using the current cursor.
     *  Only invoked when ``view.result.cursor`` is set. */
    onLoadMore?: () => void
    /** True while a ``loadMore`` request is in flight. */
    isLoadingMore?: boolean
    /** Page through the whole match set in one gesture — the panel loops
     *  ``onLoadMore`` until the cursor runs out. */
    onLoadAll?: () => void
    /** True while that loop is running. */
    isLoadingAll?: boolean
    /** Stop the loop where it is; the pages already loaded stay. */
    onCancelLoadAll?: () => void
}


export const ResultsPane: FC<ResultsPaneProps> = ({
    view, onScopeToGroup, onReveal, onOpen, onLoadMore, isLoadingMore,
    onLoadAll, isLoadingAll, onCancelLoadAll,
}) => {
    // Ref to the scroll container. Threaded through to HitsByParent →
    // VirtualizedHitList so the virtualizer can measure the visible
    // viewport when the hit page exceeds the virtualization threshold.
    const scrollContainerRef = useRef<HTMLDivElement>(null)

    // The panel doesn't render ResultsPane for idle / templateSelected —
    // the AskBar is the empty state. Defensive null kept for safety.
    if (view.kind === 'idle' || view.kind === 'templateSelected') return null

    return (
        <div className={cn(
            "rounded-2xl border border-glass-border bg-canvas-base/30",
            "overflow-hidden",
            "min-h-[180px] max-h-[60vh] flex flex-col",
        )}>
            <div
                ref={scrollContainerRef}
                className="flex-1 min-h-0 overflow-y-auto custom-scrollbar"
            >
                <Dispatch
                    view={view}
                    onScopeToGroup={onScopeToGroup}
                    onReveal={onReveal}
                    onOpen={onOpen}
                    onLoadMore={onLoadMore}
                    isLoadingMore={isLoadingMore}
                    onLoadAll={onLoadAll}
                    isLoadingAll={isLoadingAll}
                    onCancelLoadAll={onCancelLoadAll}
                    scrollElementRef={scrollContainerRef}
                />
            </div>
        </div>
    )
}


function Dispatch({
    view, onScopeToGroup, onReveal, onOpen, onLoadMore, isLoadingMore,
    onLoadAll, isLoadingAll, onCancelLoadAll, scrollElementRef,
}: ResultsPaneProps & { scrollElementRef: RefObject<HTMLDivElement | null> }) {
    switch (view.kind) {
        case 'running':
            return <RunningSkeleton label="Searching…" />
        case 'error':
            return <ErrorView message={view.message} />
        case 'results':
            return (
                <ResultsContent
                    view={view}
                    onScopeToGroup={onScopeToGroup}
                    onReveal={onReveal}
                    onOpen={onOpen}
                    onLoadMore={onLoadMore}
                    isLoadingMore={isLoadingMore}
                    onLoadAll={onLoadAll}
                    isLoadingAll={isLoadingAll}
                    onCancelLoadAll={onCancelLoadAll}
                    scrollElementRef={scrollElementRef}
                />
            )
        default:
            return null
    }
}


function ResultsContent({
    view, onScopeToGroup, onReveal, onOpen, onLoadMore, isLoadingMore,
    onLoadAll, isLoadingAll, onCancelLoadAll, scrollElementRef,
}: {
    view: Extract<PanelView, { kind: 'results' }>
    onScopeToGroup: ResultsPaneProps['onScopeToGroup']
    onReveal?: ResultsPaneProps['onReveal']
    onOpen?: ResultsPaneProps['onOpen']
    onLoadMore?: ResultsPaneProps['onLoadMore']
    isLoadingMore?: ResultsPaneProps['isLoadingMore']
    onLoadAll?: ResultsPaneProps['onLoadAll']
    isLoadingAll?: ResultsPaneProps['isLoadingAll']
    onCancelLoadAll?: ResultsPaneProps['onCancelLoadAll']
    scrollElementRef: RefObject<HTMLDivElement | null>
}) {
    const { result } = view
    // Present on the canvas that owns a search session; null on the ones
    // whose only search IS this panel. It decides both halves of the
    // results-first layout: which facets are worth a card, and whether
    // the rows group by layer or by immediate parent.
    const session = useViewSearchSessionOptional()

    const allBuckets: SearchAggregateBucket[] = useMemo(
        () => visibleFacetBuckets(result, view.query, Boolean(session)),
        [result, view.query, session],
    )
    const grandTotal = useMemo(
        () => allBuckets.reduce((sum, b) => sum + b.matchCount, 0),
        [allBuckets],
    )
    const hits: SearchHit[] = result.hits ?? []
    const paths = result.paths ?? null

    // Containers the draft is already scoped to, so a group card can
    // say "you're inside this" instead of offering a filter that would
    // replace itself with an identical one.
    const draftPredicate = useDraftPredicate()
    const scopedUrns = useMemo(
        () => new Set(findScopeCondition(draftPredicate)?.urns ?? []),
        [draftPredicate],
    )

    // ─── Client-side hit filter ─────────────────────────────────────
    // Pure list-narrowing tool — does NOT touch matchUrnSet, so the
    // canvas keeps highlighting every backend match while the user
    // narrows down what's visible in the rows below. Filters by
    // case-insensitive substring on displayName + qualifiedName.
    const [filter, setFilter] = useState('')
    // Entity-type facet filter — set of entity types the user wants to
    // include. Empty set = "show all types". Toggling the same pill
    // off twice removes the filter entirely.
    const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set())
    const toggleType = useCallback((typeId: string) => {
        setActiveTypes((prev) => {
            const next = new Set(prev)
            if (next.has(typeId)) next.delete(typeId)
            else next.add(typeId)
            return next
        })
    }, [])
    const resetTypes = useCallback(() => setActiveTypes(new Set()), [])

    // Per-entity-type counts across the full hits[] (NOT the filtered
    // subset) — so the pills always show the full breakdown of what's
    // available, not what's currently visible.
    const typeCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const h of hits) {
            const t = h.node.entityType ?? '(untyped)'
            counts.set(t, (counts.get(t) ?? 0) + 1)
        }
        return counts
    }, [hits])
    const sortedTypeCounts = useMemo(
        () => Array.from(typeCounts.entries())
            .sort((a, b) => b[1] - a[1]),
        [typeCounts],
    )
    const showFacets = sortedTypeCounts.length >= 2

    const filteredHits = useMemo(() => {
        const q = filter.trim().toLowerCase()
        const typeFilterActive = activeTypes.size > 0
        if (!q && !typeFilterActive) return hits
        return hits.filter((h) => {
            if (typeFilterActive && !activeTypes.has(h.node.entityType ?? '(untyped)')) {
                return false
            }
            if (q) {
                const dn = (h.node.displayName ?? '').toLowerCase()
                const qn = (h.node.qualifiedName ?? '').toLowerCase()
                if (!dn.includes(q) && !qn.includes(q)) return false
            }
            return true
        })
    }, [hits, filter, activeTypes])
    const filterActive = filter.trim().length > 0 || activeTypes.size > 0

    // Index of hits by URN for O(1) ancestor-path lookup when the
    // MatchBar stepper / J-K keyboard advances the focused match. We
    // build this from the unfiltered hits so the auto-reveal works
    // even when the user's row filter would have hidden the focused
    // hit — the focused URN is always a valid match regardless of
    // the presentational filter.
    // Layer › container grouping. Computed here rather than inside
    // HitsByLayer because the section header states how many layers the
    // page landed in — grouping twice is how those two numbers would come
    // to disagree. Empty (and unused) on the canvases with no session.
    const ancestorMatchCounts = useAncestorMatchCounts()
    const layerGroups = useMemo(
        () => (session
            ? groupHitsByLayer(
                filteredHits, session.resolveLayer, ancestorMatchCounts, session.layers)
            : []),
        [session, filteredHits, ancestorMatchCounts],
    )

    const hitsByUrn = useMemo(() => {
        const map = new Map<string, SearchHit>()
        for (const h of hits) {
            if (h.node.urn) map.set(h.node.urn, h)
        }
        return map
    }, [hits])

    // Focus-tracking effect: when the focused-match URN changes,
    // scroll the focused row into view in the panel. We deliberately
    // do NOT fire ``onReveal`` here anymore — that triggered the full
    // spine-walk + horizontal canvas pan on every J/K step, producing
    // the "jumping all over" UX the user reported. Reveal-on-canvas
    // is now an explicit action (the MatchBar "Show on canvas"
    // button, or Enter inside the panel) so stepping is light and
    // canvas motion is always deliberate.
    //
    // ``hitsByUrn`` is still indexed so the future prefetch-spine
    // wiring can resolve the focused URN's ancestor path without
    // re-walking ``hits``.
    void hitsByUrn
    const focusedMatchUrn = useFocusedMatchUrn()
    useEffect(() => {
        if (!focusedMatchUrn) return
        // Scroll the row into view (if rendered). The
        // ``HIT_ROW_ID_PREFIX`` id is stamped on each SearchHitRow's
        // outer div. ``block: 'nearest'`` avoids unnecessary jumps
        // when the row is already on-screen.
        const row = document.getElementById(`${HIT_ROW_ID_PREFIX}${focusedMatchUrn}`)
        if (row) {
            row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
    }, [focusedMatchUrn])

    const hasAggregates = allBuckets.length > 0
    const hasHits = hits.length > 0
    const hasPaths = paths !== null
    const isEmpty = !hasAggregates && !hasHits && !hasPaths

    // Headline numbers. ``candidateCount`` is the backend's count over the FULL
    // candidate set, so it is the honest total even when the hit list below is
    // only the first page. Bucket counts are computed server-side over that same
    // full set, so per-group numbers stay exact regardless of paging.
    // ``totalCount`` is the server's exact size of the whole match set and
    // outranks ``candidateCount`` (what the scan had to consider) wherever
    // the backend sends it. Read off-type: the schema regen that declares
    // it is a separate step, and a panel that waited for it would keep
    // reporting the scan size as the total.
    const totalCount = (result as { totalCount?: number | null }).totalCount ?? null
    const candidateCount = result.candidateCount ?? null
    const totalMatches = totalCount ?? candidateCount ?? hits.length
    // The hit list is a page; the counts are not. Say so, rather than letting
    // the user read "1,000 matches" and assume that's all there is.
    const hitsArePartial = hits.length < totalMatches

    return (
        <div className="flex flex-col">
            {isEmpty && (
                <div className="flex flex-col gap-3 p-4">
                    <ZeroResultsDiagnostic
                        result={result}
                        query={view.query}
                        // Switching the match mode re-runs the same word
                        // through the session's own debounce — the panel
                        // never dispatches a second query of its own.
                        onSwitchMatch={session
                            ? (match) => session.setQuick({ match })
                            : undefined}
                    />
                </div>
            )}

            {!isEmpty && !hasPaths && (
                <div className="px-4 pt-4 pb-1">
                    {/* "N matches · M groups", not "N matches IN M groups": buckets group
                        by immediate parent, so a root-level match belongs to no group and
                        the bucket counts need not sum to the total. The dot states two
                        facts; "in" would claim a partition that isn't one. */}
                    <p className="text-[13px] font-medium text-ink/90">
                        {totalMatches.toLocaleString()}
                        {result.truncated ? '+' : ''}
                        {totalMatches === 1 ? ' match' : ' matches'}
                        {hasAggregates && (
                            <span className="text-ink-muted font-normal">
                                {' · '}
                                {allBuckets.length.toLocaleString()}
                                {allBuckets.length === 1 ? ' group' : ' groups'}
                            </span>
                        )}
                    </p>
                    {(hitsArePartial || result.truncated) && (
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted/70">
                            Group counts are exact. The list below shows the first{' '}
                            {hits.length.toLocaleString()} — drill into a group or refine
                            the query to narrow it down.
                        </p>
                    )}
                </div>
            )}

            {hasPaths && paths && (
                <div className="p-4">
                    <PathResultPanel
                        paths={paths}
                        truncated={result.truncated}
                        onReveal={onReveal}
                    />
                </div>
            )}

            {hasAggregates && (
                <section className="space-y-2.5 p-4">
                    <SectionHeader
                        title={`${allBuckets.length} ${allBuckets.length === 1 ? 'group' : 'groups'}`}
                        subtitle="Click a group to add an “inside” filter"
                    />
                    <div className="space-y-2.5">
                        {allBuckets.map((b, i) => (
                            <AggregateBucketCard
                                key={`${b.ancestorUrn}-${i}`}
                                bucket={b}
                                grandTotal={grandTotal}
                                index={i}
                                isActiveScope={
                                    Boolean(b.ancestorUrn)
                                    && scopedUrns.has(b.ancestorUrn)
                                }
                                onScopeToGroup={b.ancestorUrn
                                    ? () => onScopeToGroup(b)
                                    : undefined}
                            />
                        ))}
                    </div>
                </section>
            )}

            {hasHits && (
                <section className="p-2 pt-1">
                    <SectionHeader
                        title={
                            filterActive
                                ? `${filteredHits.length} of ${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`
                                : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`
                        }
                        subtitle={
                            filterActive
                                ? 'Filtering rows only · canvas still highlights every backend match'
                                // The match count above is the whole set; the
                                // layers below are only the ones this PAGE
                                // reached. Say which is which — the two
                                // numbers are not measuring the same thing.
                                : session
                                    ? `Where they live · ${layerGroups.length} layer${layerGroups.length === 1 ? '' : 's'} on this page`
                                    : result.truncated
                                        ? `Showing first ${hits.length} · refine to narrow`
                                        : 'Grouped by immediate parent · click a folder to collapse'
                        }
                    />
                    {showFacets && (
                        <EntityTypeFacets
                            typeCounts={sortedTypeCounts}
                            activeTypes={activeTypes}
                            onToggle={toggleType}
                            onReset={resetTypes}
                        />
                    )}
                    <HitsFilter
                        value={filter}
                        onChange={setFilter}
                        disabled={hits.length === 0}
                    />
                    <div className="mt-1">
                        {filteredHits.length === 0 ? (
                            <div className="px-3 py-6 text-[12px] text-ink-muted italic text-center">
                                No rows match the current filter.
                                {' '}
                                <button
                                    type="button"
                                    onClick={() => {
                                        setFilter('')
                                        resetTypes()
                                    }}
                                    className="text-accent-lineage hover:underline not-italic"
                                >
                                    Reset filters
                                </button>
                            </div>
                        ) : session ? (
                            <HitsByLayer
                                groups={layerGroups}
                                onReveal={onReveal}
                                onOpen={onOpen}
                                scrollElementRef={scrollElementRef}
                            />
                        ) : (
                            <HitsByParent
                                hits={filteredHits}
                                onReveal={onReveal}
                                onOpen={onOpen}
                                scrollElementRef={scrollElementRef}
                            />
                        )}
                        {/* W2.2 — cursor pagination. The backend echoes
                            ``result.cursor`` when more hits exist beyond the
                            current page (hits.length === pageSize AND the
                            candidate set wasn't exhausted). Clicking
                            "Load more" re-issues the SAME query with the
                            cursor set and appends the new hits onto this
                            list — same query, longer result. */}
                        {result.cursor && onLoadMore && (
                            <div className="mt-2 px-3 pb-2">
                                {isLoadingAll ? (
                                    /* One page at a time, so the count moves
                                       and the user can stop it. What is
                                       already loaded stays either way. */
                                    <div className="flex items-center gap-2">
                                        <span className="flex-1 min-w-0 text-[11.5px] text-ink-muted tabular-nums">
                                            Loading everything — {hits.length.toLocaleString()}
                                            {' of '}{totalMatches.toLocaleString()}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={onCancelLoadAll}
                                            className={cn(
                                                'rounded-lg px-3 py-1.5 shrink-0',
                                                'border border-glass-border',
                                                'text-[12px] font-medium text-ink',
                                                'hover:bg-glass/40 transition-colors',
                                            )}
                                        >
                                            Stop
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => onLoadMore()}
                                            disabled={isLoadingMore}
                                            className={cn(
                                                'flex-1 rounded-lg px-3 py-2',
                                                'border border-glass-border',
                                                'bg-canvas-base/40 hover:bg-canvas-base/60',
                                                'text-[12px] font-medium text-ink',
                                                'transition-colors',
                                                'disabled:opacity-60 disabled:cursor-progress',
                                                'flex items-center justify-center gap-2',
                                            )}
                                        >
                                            {isLoadingMore
                                                ? 'Loading…'
                                                : `Load more (${hits.length} so far)`}
                                        </button>
                                        {onLoadAll && (
                                            <button
                                                type="button"
                                                onClick={onLoadAll}
                                                disabled={isLoadingMore}
                                                title={`Keep paging until all ${totalMatches.toLocaleString()} are loaded`}
                                                className={cn(
                                                    'rounded-lg px-3 py-2 shrink-0',
                                                    'border border-glass-border',
                                                    'text-[12px] font-medium text-ink-secondary',
                                                    'hover:text-ink hover:bg-glass/40 transition-colors',
                                                    'disabled:opacity-60',
                                                )}
                                            >
                                                Load all
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </section>
            )}
        </div>
    )
}


/**
 * Entity-type facet pills shown above the hits list. Each pill
 * represents one entity type appearing in the current hits[] with its
 * count, the schema's icon, and the schema's color. Click toggles
 * inclusion in the active set; empty set = "all types shown".
 *
 * Pure list-narrowing — does not touch matchUrnSet (the canvas keeps
 * highlighting every backend match while the user narrows the rows).
 */
function EntityTypeFacets({
    typeCounts, activeTypes, onToggle, onReset,
}: {
    typeCounts: ReadonlyArray<readonly [string, number]>
    activeTypes: ReadonlySet<string>
    onToggle: (typeId: string) => void
    onReset: () => void
}) {
    const schema = useSchemaStore((s) => s.schema)
    const noneActive = activeTypes.size === 0
    return (
        <div className="mt-1.5 mx-1 flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.14em] text-ink-muted/70 mr-0.5">
                Type
            </span>
            {typeCounts.map(([typeId, count]) => {
                const meta = schema?.entityTypes.find((t) => t.id === typeId)
                const color = meta?.visual?.color ?? '#94a3b8'
                const iconName = meta?.visual?.icon ?? 'Box'
                const label = meta?.name ?? typeId
                const active = activeTypes.has(typeId)
                const dim = !noneActive && !active
                return (
                    <button
                        key={typeId}
                        type="button"
                        onClick={() => onToggle(typeId)}
                        title={`${active ? 'Hide' : 'Show'} ${label} (${count.toLocaleString()})`}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-1.5 h-6 rounded-full',
                            'text-[11px] font-medium transition-all duration-150',
                            'border',
                            active
                                ? 'shadow-[0_1px_8px_-2px_rgba(0,0,0,0.4)]'
                                : 'hover:scale-[1.03]',
                            dim && 'opacity-50 hover:opacity-90',
                        )}
                        style={active
                            ? {
                                background: `linear-gradient(135deg, ${color}30 0%, ${color}18 100%)`,
                                borderColor: `${color}80`,
                                color,
                            }
                            : {
                                background: `${color}10`,
                                borderColor: `${color}30`,
                                color: dim ? undefined : color,
                            }
                        }
                    >
                        <span
                            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded shrink-0"
                            style={{ background: `${color}25` }}
                        >
                            <DynamicIcon
                                name={iconName}
                                className="w-2.5 h-2.5"
                                style={{ color }}
                            />
                        </span>
                        <span className="truncate max-w-[120px]">{label}</span>
                        <span className="tabular-nums text-[10px] opacity-80">
                            {count.toLocaleString()}
                        </span>
                    </button>
                )
            })}
            {!noneActive && (
                <button
                    type="button"
                    onClick={onReset}
                    className={cn(
                        'inline-flex items-center gap-1 px-2 h-6 rounded-full',
                        'text-[10.5px] text-ink-muted hover:text-ink',
                        'border border-glass-border/60 hover:border-glass-border',
                        'transition-colors',
                    )}
                >
                    <X className="w-2.5 h-2.5" />
                    All types
                </button>
            )}
        </div>
    )
}


function HitsFilter({
    value, onChange, disabled,
}: {
    value: string
    onChange: (next: string) => void
    disabled: boolean
}) {
    const showClear = value.length > 0
    return (
        <div className="mt-1.5 mx-1">
            <div className={cn(
                'flex items-center gap-1.5 px-2 h-7 rounded-md',
                'bg-canvas-base/50 border border-glass-border/60',
                'focus-within:border-accent-lineage/60 transition-colors',
                disabled && 'opacity-50',
            )}>
                <Filter className="w-3 h-3 text-ink-muted shrink-0" />
                <input
                    type="text"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    disabled={disabled}
                    placeholder="Filter rows by name or qualified name…"
                    className={cn(
                        'flex-1 min-w-0 bg-transparent border-0 outline-none',
                        'text-[11.5px] text-ink placeholder:text-ink-muted/60',
                    )}
                />
                {showClear && (
                    <button
                        type="button"
                        onClick={() => onChange('')}
                        title="Clear filter"
                        className={cn(
                            'inline-flex items-center justify-center w-4 h-4 rounded',
                            'text-ink-muted hover:text-ink hover:bg-glass/40 transition-colors',
                        )}
                    >
                        <X className="w-2.5 h-2.5" />
                    </button>
                )}
            </div>
        </div>
    )
}


function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
        <div className="px-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                {title}
            </div>
            {subtitle && (
                <div className="text-[10.5px] text-ink-muted/70 mt-0.5">{subtitle}</div>
            )}
        </div>
    )
}
