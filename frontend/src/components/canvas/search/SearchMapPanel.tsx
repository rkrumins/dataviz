/**
 * Advanced Search panel — the Query Lens UX.
 *
 *     ┌─ Search · this view ──────────────── 📋 ⚙ × ─┐
 *     ├──────────────────────────────────────────────┤
 *     │   ╭─ Query · 3 filters ── Visual | Code ──╮   │
 *     │   │ ⌕  name contains [customer        ]  │   │
 *     │   │ #  tag is        [#PII] [+ ]         │   │
 *     │   │ ↑  no upstream lineage               │   │
 *     │   │ + Add filter   12 tags · 37 keys     │   │
 *     │   ╰──────────────────────────────────────╯   │
 *     │                                              │
 *     │   ── 47 matches · 432 ms ───── ⊞ Frame ──── │
 *     │   GOLD ▸ REPORTING (8 matches)               │
 *     │     customer_orders     DATASET              │
 *     │     customer_profile    DATASET              │
 *     │   INTERMEDIATE_T2 (6 matches)                │
 *     │     int_clean_tickets_t2  DATASET            │
 *     └──────────────────────────────────────────────┘
 *
 * One Query card holds the entire active query. Rows compose with AND;
 * the Visual ↔ Code toggle switches between row-builder and DSL text.
 * Templates SEED the rows (no opaque "replace + run"). Advanced drawer
 * holds Options / JSON / Cypher only — composing happens in the card.
 *
 * Canvas integration unchanged: every successful run publishes
 * matchUrnSet + ancestorMatchCounts + ancestorMatchTypeBreakdowns so
 * the lineage canvas spotlights matches and shows enriched badges.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Code2, LayoutTemplate, Settings2, X, Maximize2 } from 'lucide-react'
import {
    type FC,
    type ReactNode,
    useCallback,
    useMemo,
    useState,
} from 'react'

import { cn } from '@/lib/utils'
import { useAdvancedSearch } from '@/hooks/useAdvancedSearch'
import {
    useAncestorMatchCounts,
    useDraftPredicate,
    useRecentQueries,
    useSearchStore,
    type RecentQueryEntry,
} from '@/store/searchStore'
import type { AncestorRef } from '@/types/search'

import { DynamicIcon } from '@/components/ui/DynamicIcon'

import { AdvancedDrawer, type DrawerTab } from './panel/AdvancedDrawer'
import { NoViewState } from './panel/NoViewState'
import { QueryCard } from './panel/QueryCard'
import { ResizeHandle, readPersistedWidth } from './panel/ResizeHandle'
import { ResultsPane } from './panel/ResultsPane'
import { ScopeModePicker } from './panel/ScopeModePicker'
import { ScopeStrip } from './panel/ScopeStrip'
import { TemplatePicker } from './TemplatePicker'
import {
    defaultInputs,
    featuredTemplates,
    type SearchTemplate,
} from './searchTemplates'


export interface SearchMapPanelProps {
    open: boolean
    onClose: () => void
    /** REQUIRED. The view this panel is bound to. */
    viewId: string
    onRevealNode?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpenNode?: (urn: string) => void
    onFrameMatches?: (urns: string[]) => void
}


export const SearchMapPanel: FC<SearchMapPanelProps> = ({
    open, onClose, viewId, onRevealNode, onOpenNode, onFrameMatches,
}) => {
    const [width, setWidth] = useState<number>(() => readPersistedWidth())

    return (
        <AnimatePresence>
            {open && (
                <motion.aside
                    data-panel="search-map-panel"
                    data-testid="search-map-panel"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                    className={cn(
                        'relative h-full flex-shrink-0 overflow-hidden',
                        'bg-canvas-elevated/98 backdrop-blur-2xl',
                        'border-r border-glass-border shadow-2xl shadow-black/25',
                    )}
                >
                    <div
                        className="h-full flex flex-col overflow-hidden"
                        style={{ width }}
                    >
                        {viewId ? (
                            <PanelInner
                                onClose={onClose}
                                viewId={viewId}
                                onRevealNode={onRevealNode}
                                onOpenNode={onOpenNode}
                                onFrameMatches={onFrameMatches}
                            />
                        ) : (
                            <NoViewState onClose={onClose} />
                        )}
                    </div>
                    <ResizeHandle width={width} onResize={setWidth} />
                </motion.aside>
            )}
        </AnimatePresence>
    )
}


// =============================================================================
// Inner orchestrator
// =============================================================================

interface PanelInnerProps {
    onClose: () => void
    viewId: string
    onRevealNode?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpenNode?: (urn: string) => void
    onFrameMatches?: (urns: string[]) => void
}


function PanelInner({
    onClose, viewId, onRevealNode, onOpenNode, onFrameMatches,
}: PanelInnerProps) {
    const {
        view, scope, runPredicate, drillInto, popScope, cancel,
        loadMore, isLoadingMore,
    } = useAdvancedSearch(viewId)

    const draftPredicate = useDraftPredicate()
    const matchUrnSet = useSearchStore((s) => s.matchUrnSet)
    const ancestorMatchCounts = useAncestorMatchCounts()
    const commitDraft = useSearchStore((s) => s.commitDraft)
    const clearStore = useSearchStore((s) => s.clear)
    const recentQueries = useRecentQueries(viewId)
    const togglePinRecent = useSearchStore((s) => s.togglePinRecent)
    const removeRecent = useSearchStore((s) => s.removeRecent)

    const [advancedOpen, setAdvancedOpen] = useState(false)
    const [advancedTab, setAdvancedTab] = useState<DrawerTab>('options')
    const [templatesOpen, setTemplatesOpen] = useState(false)

    const openAdvanced = useCallback((tab: DrawerTab = 'options') => {
        setAdvancedTab(tab)
        setAdvancedOpen(true)
    }, [])

    const handleClear = useCallback(() => {
        cancel()
        clearStore()
    }, [cancel, clearStore])

    /**
     * Seed-from-template: rather than calling runTemplate (which would
     * REPLACE the canonical state with the template's full SearchQuery
     * including its aggregations), we just compile the template's
     * predicate and seed the draft. The QueryCard's debounced auto-run
     * then fires with the user's hits-only options — so the result is
     * an editable set of filter rows the user can refine.
     */
    const handleSeedTemplate = useCallback((template: SearchTemplate) => {
        const built = template.build(defaultInputs(template))
        if (built.predicate) {
            commitDraft(built.predicate)
        }
        setTemplatesOpen(false)
    }, [commitDraft])

    const handleLoadRecent = useCallback((entry: RecentQueryEntry) => {
        commitDraft(entry.predicate)
        setTemplatesOpen(false)
    }, [commitDraft])

    const frameTargetUrns = useMemo<string[]>(() => {
        const set = new Set<string>(matchUrnSet)
        for (const [urn, count] of ancestorMatchCounts) {
            if (count > 0) set.add(urn)
        }
        return Array.from(set)
    }, [matchUrnSet, ancestorMatchCounts])

    const canFrame = view.kind === 'results'
        && frameTargetUrns.length > 0
        && Boolean(onFrameMatches)

    const resultsCount = view.kind === 'results'
        ? (view.result.candidateCount || view.result.hits?.length || 0)
        : null
    const elapsedMs = view.kind === 'results' ? view.elapsedMs : null
    const truncated = view.kind === 'results' && view.result.truncated === true
    const deadlineExceeded = view.kind === 'results'
        && view.result.deadlineExceeded === true
    const candidateCount = view.kind === 'results'
        ? (view.result.candidateCount ?? null)
        : null
    const showResultsSection = view.kind === 'running'
        || view.kind === 'results'
        || view.kind === 'error'

    return (
        <>
            <CompactHeader
                onClose={onClose}
                onToggleAdvanced={() => openAdvanced('options')}
                onToggleTemplates={() => setTemplatesOpen((v) => !v)}
                templatesOpen={templatesOpen}
            />

            {advancedOpen ? (
                <AdvancedDrawer
                    viewId={viewId}
                    initialTab={advancedTab}
                    onClose={() => setAdvancedOpen(false)}
                />
            ) : (
                <>
                    <ScopeStrip scope={scope} onPop={popScope} />

                    <div className={cn(
                        'flex-1 min-h-0 overflow-y-auto custom-scrollbar',
                        'px-3 py-3 flex flex-col gap-3',
                    )}>
                        <QueryCard
                            viewId={viewId}
                            isRunning={view.kind === 'running'}
                            onRun={(p, options) => void runPredicate(p, options)}
                            onOpenAdvanced={() => openAdvanced('options')}
                        />

                        <AnimatePresence>
                            {templatesOpen && (
                                <TemplatesStrip
                                    onSeed={handleSeedTemplate}
                                    onDismiss={() => setTemplatesOpen(false)}
                                    activeDraft={Boolean(draftPredicate)}
                                    recentQueries={recentQueries}
                                    onLoadRecent={handleLoadRecent}
                                    onTogglePinRecent={togglePinRecent}
                                    onRemoveRecent={removeRecent}
                                />
                            )}
                        </AnimatePresence>

                        {showResultsSection && (
                            <div className="flex flex-col gap-2">
                                <ResultsHeader
                                    count={resultsCount}
                                    elapsedMs={elapsedMs}
                                    isRunning={view.kind === 'running'}
                                    errorMessage={view.kind === 'error' ? view.message : null}
                                    truncated={truncated}
                                    deadlineExceeded={deadlineExceeded}
                                    candidateCount={candidateCount}
                                    onFrame={canFrame
                                        ? () => onFrameMatches?.(frameTargetUrns)
                                        : undefined}
                                    onViewCypher={draftPredicate
                                        ? () => openAdvanced('cypher')
                                        : undefined}
                                    onClear={view.kind === 'results' || view.kind === 'error'
                                        ? handleClear
                                        : undefined}
                                />
                                <ResultsPane
                                    view={view}
                                    onDrill={drillInto}
                                    onReveal={onRevealNode}
                                    onOpen={onOpenNode}
                                    onLoadMore={loadMore}
                                    isLoadingMore={isLoadingMore}
                                />
                            </div>
                        )}
                    </div>
                </>
            )}
        </>
    )
}


// =============================================================================
// Header (title + ⚙ Advanced + 📋 Templates + ×)
// =============================================================================

function CompactHeader({
    onClose, onToggleAdvanced, onToggleTemplates, templatesOpen,
}: {
    onClose: () => void
    onToggleAdvanced: () => void
    onToggleTemplates: () => void
    templatesOpen: boolean
}) {
    return (
        <div className={cn(
            'flex items-center gap-2 px-4 py-3',
            'border-b border-glass-border/60 bg-canvas-elevated/60',
        )}>
            <div className="flex items-center gap-2 min-w-0">
                <div className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                    'bg-gradient-to-br from-accent-lineage/30 to-cyan-500/20',
                    'shadow-inner shadow-accent-lineage/20',
                )}>
                    <svg className="w-3.5 h-3.5 text-accent-lineage" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="7" />
                        <path d="m21 21-4.3-4.3" />
                    </svg>
                </div>
                <div className="flex flex-col min-w-0 gap-1">
                    <span className="text-[13px] font-display font-semibold text-ink leading-tight">
                        Search
                    </span>
                    <ScopeModePicker />
                </div>
            </div>
            <div className="ml-auto flex items-center gap-0.5">
                <button
                    type="button"
                    onClick={onToggleTemplates}
                    title="Seed the Query card from a template"
                    aria-pressed={templatesOpen}
                    className={cn(
                        'inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors',
                        templatesOpen
                            ? 'text-accent-lineage bg-accent-lineage/10'
                            : 'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10',
                    )}
                >
                    <LayoutTemplate className="w-4 h-4" />
                </button>
                <button
                    type="button"
                    onClick={onToggleAdvanced}
                    title="Options · JSON · Cypher"
                    className={cn(
                        'inline-flex items-center justify-center w-8 h-8 rounded-lg',
                        'text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10 transition-colors',
                    )}
                >
                    <Settings2 className="w-4 h-4" />
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    title="Close"
                    className={cn(
                        'inline-flex items-center justify-center w-8 h-8 rounded-lg',
                        'text-ink-muted hover:text-ink hover:bg-glass/40 transition-colors',
                    )}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}


// =============================================================================
// Results header (count + Frame + Clear) — sits above the ResultsPane
// =============================================================================

function ResultsHeader({
    count, elapsedMs, isRunning, errorMessage, truncated,
    deadlineExceeded, candidateCount,
    onFrame, onViewCypher, onClear,
}: {
    count: number | null
    elapsedMs: number | null
    isRunning: boolean
    errorMessage?: string | null
    /** True when the candidate cap (5000) was hit — the count is a
     *  ceiling, not the true total. Surface this prominently so the
     *  user understands some matches may be missing from the canvas. */
    truncated?: boolean
    deadlineExceeded?: boolean
    candidateCount?: number | null
    onFrame?: () => void
    /** Open the Advanced drawer on the Cypher tab so a power user can
     *  see the exact compiled query that ran against FalkorDB (with
     *  bound parameters + resolved scope). */
    onViewCypher?: () => void
    onClear?: () => void
}) {
    const isError = Boolean(errorMessage)
    const showTruncation = Boolean(truncated && !isRunning && !isError)
    const showDeadlineExceeded = Boolean(
        deadlineExceeded && !isRunning && !isError,
    )
    return (
        <div className="flex flex-col gap-1.5">
        <div className={cn(
            'flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg',
            isError ? 'bg-rose-500/10 border border-rose-500/30' : '',
        )}>
            <div className="flex items-baseline gap-2 min-w-0 flex-1">
                {isRunning ? (
                    <span className="text-[11.5px] text-ink-muted">Searching…</span>
                ) : isError ? (
                    <span className="text-[11.5px] text-rose-300 truncate" title={errorMessage ?? ''}>
                        Error · {errorMessage}
                    </span>
                ) : count !== null ? (
                    <>
                        <span className="text-[14px] font-display font-semibold text-ink tabular-nums">
                            {count.toLocaleString()}{showTruncation && '+'}
                        </span>
                        <span className="text-[12px] text-ink-muted">
                            {count === 1 ? 'match' : 'matches'}
                        </span>
                        {elapsedMs !== null && (
                            <span className="text-[10.5px] text-ink-muted/70 tabular-nums">
                                · {elapsedMs} ms
                            </span>
                        )}
                    </>
                ) : null}
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
                {onFrame && !isRunning && !isError && (
                    <button
                        type="button"
                        onClick={onFrame}
                        title="Frame matches on the canvas"
                        className={cn(
                            'inline-flex items-center gap-1 px-2 h-6 rounded-md',
                            'text-[11px] font-medium',
                            'bg-accent-lineage/15 text-accent-lineage',
                            'hover:bg-accent-lineage/25 transition-colors',
                        )}
                    >
                        <Maximize2 className="w-3 h-3" />
                        Frame
                    </button>
                )}
                {onViewCypher && !isRunning && (
                    <button
                        type="button"
                        onClick={onViewCypher}
                        title="Show the exact compiled Cypher + bound parameters this search ran against FalkorDB"
                        className={cn(
                            'inline-flex items-center gap-1 px-2 h-6 rounded-md',
                            'text-[11px] font-medium',
                            'bg-glass/40 text-ink-secondary',
                            'hover:bg-glass/60 hover:text-ink transition-colors',
                            'border border-glass-border/60',
                        )}
                    >
                        <Code2 className="w-3 h-3" />
                        Cypher
                    </button>
                )}
                {onClear && (
                    <button
                        type="button"
                        onClick={onClear}
                        title="Clear results"
                        className={cn(
                            'inline-flex items-center justify-center w-6 h-6 rounded-md',
                            'text-ink-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors',
                        )}
                    >
                        <X className="w-3 h-3" />
                    </button>
                )}
            </div>
        </div>
        {(showTruncation || showDeadlineExceeded) && (
            <WarningBanner
                truncated={showTruncation}
                deadlineExceeded={showDeadlineExceeded}
                candidateCount={candidateCount ?? null}
            />
        )}
        </div>
    )
}


/**
 * High-contrast warning banner for ``truncated`` / ``deadlineExceeded``
 * result states. The previous ``text-amber-200/95`` on
 * ``bg-amber-500/10`` was barely legible on the panel's translucent
 * background — users missed that their result set was incomplete.
 *
 * This version uses a saturated amber border + brighter text +
 * ``font-semibold`` body copy + an emoji icon backed by a tinted
 * pill so the warning reads as a deliberate callout, not subtle
 * styling. Truncation and deadline-exceeded share the layout but
 * each gets its own headline + remediation.
 */
function WarningBanner({
    truncated, deadlineExceeded, candidateCount,
}: {
    truncated: boolean
    deadlineExceeded: boolean
    candidateCount: number | null
}) {
    return (
        <div className={cn(
            'flex flex-col gap-2',
        )}>
            {truncated && (
                <div className={cn(
                    'flex items-start gap-2.5 px-3 py-2.5 rounded-lg',
                    'border-l-4 border-l-amber-400 border border-amber-400/50',
                    'bg-amber-500/[0.18] dark:bg-amber-500/[0.14]',
                    'shadow-[0_0_18px_-4px_rgba(245,158,11,0.35)]',
                )}>
                    <div className={cn(
                        'shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
                        'bg-amber-400/30 border border-amber-400/60',
                    )}>
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-700 dark:text-amber-200" strokeWidth={2.6} />
                    </div>
                    <div className="flex-1 min-w-0 text-[12px] leading-snug">
                        <div className="font-display font-semibold text-amber-900 dark:text-amber-100">
                            Results truncated — candidate cap reached
                        </div>
                        <div className="mt-0.5 text-amber-900/85 dark:text-amber-100/90">
                            {candidateCount !== null
                                ? `${candidateCount.toLocaleString()} candidates scanned before the cap fired. `
                                : 'The candidate-scan cap fired before the full result set was returned. '}
                            Some matches aren't shown. Narrow your filters,
                            tighten the scope, or raise the candidate cap in
                            Advanced options.
                        </div>
                    </div>
                </div>
            )}
            {deadlineExceeded && (
                <div className={cn(
                    'flex items-start gap-2.5 px-3 py-2.5 rounded-lg',
                    'border-l-4 border-l-rose-400 border border-rose-400/50',
                    'bg-rose-500/[0.18] dark:bg-rose-500/[0.14]',
                    'shadow-[0_0_18px_-4px_rgba(244,63,94,0.35)]',
                )}>
                    <div className={cn(
                        'shrink-0 w-6 h-6 rounded-md flex items-center justify-center',
                        'bg-rose-400/30 border border-rose-400/60',
                    )}>
                        <AlertTriangle className="w-3.5 h-3.5 text-rose-700 dark:text-rose-200" strokeWidth={2.6} />
                    </div>
                    <div className="flex-1 min-w-0 text-[12px] leading-snug">
                        <div className="font-display font-semibold text-rose-900 dark:text-rose-100">
                            Soft deadline exceeded — partial results
                        </div>
                        <div className="mt-0.5 text-rose-900/85 dark:text-rose-100/90">
                            The provider returned what it had when the
                            timeout fired. Some matches are missing.
                            Tighten the predicate, lower the candidate cap,
                            or raise the deadline in Advanced options.
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}


// =============================================================================
// Templates strip (shown when 📋 toggled OR on the empty state)
// =============================================================================

type StripTab = 'starts' | 'all' | 'recent'

function TemplatesStrip({
    onSeed, onDismiss, activeDraft,
    recentQueries, onLoadRecent, onTogglePinRecent, onRemoveRecent,
}: {
    onSeed: (template: SearchTemplate) => void
    onDismiss: () => void
    activeDraft: boolean
    recentQueries: ReadonlyArray<RecentQueryEntry>
    onLoadRecent: (entry: RecentQueryEntry) => void
    onTogglePinRecent: (timestamp: number) => void
    onRemoveRecent: (timestamp: number) => void
}) {
    const featured = featuredTemplates()
    // Default to Recent when there are any — power users opening this
    // strip mid-session usually want their history. Falls back to
    // Quick starts when Recent is empty (first session on this view).
    const [tab, setTab] = useState<StripTab>(
        recentQueries.length > 0 ? 'recent' : 'starts',
    )
    return (
        <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className={cn(
                'rounded-xl border border-glass-border bg-canvas-base/30',
                'flex flex-col gap-2 px-3 py-2.5',
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <div className="inline-flex rounded-md bg-canvas-base/40 border border-glass-border/60 p-0.5">
                    <StripTabBtn
                        active={tab === 'starts'}
                        onClick={() => setTab('starts')}
                    >
                        Quick starts
                    </StripTabBtn>
                    <StripTabBtn
                        active={tab === 'all'}
                        onClick={() => setTab('all')}
                    >
                        Browse all
                    </StripTabBtn>
                    <StripTabBtn
                        active={tab === 'recent'}
                        onClick={() => setTab('recent')}
                    >
                        Recent
                        {recentQueries.length > 0 && (
                            <span className="ml-1 tabular-nums opacity-70">
                                {recentQueries.length}
                            </span>
                        )}
                    </StripTabBtn>
                </div>
                <button
                    type="button"
                    onClick={onDismiss}
                    className="text-[10.5px] text-ink-muted hover:text-ink"
                >
                    Hide
                </button>
            </div>
            {tab === 'starts' && (
                <>
                    <div className="flex flex-wrap gap-1.5">
                        {featured.map((t) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => onSeed(t)}
                                title={t.description}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl',
                                    'text-[11.5px] font-medium',
                                    'bg-canvas-base/50 border border-glass-border',
                                    'text-ink-secondary hover:text-ink hover:border-accent-lineage/40',
                                    'hover:bg-accent-lineage/10 transition-all',
                                    'active:scale-95',
                                )}
                            >
                                <DynamicIcon name={t.icon} className="w-3.5 h-3.5 text-accent-lineage" />
                                {t.chipLabel ?? t.label}
                            </button>
                        ))}
                    </div>
                    <div className="text-[10.5px] text-ink-muted/70 leading-snug">
                        {activeDraft
                            ? 'Picking a template REPLACES your current filters.'
                            : 'Picking a template fills the Query card with editable rows.'}
                    </div>
                </>
            )}
            {tab === 'all' && (
                <div className="max-h-[60vh] overflow-y-auto custom-scrollbar -mx-1 px-1">
                    <TemplatePicker onPick={onSeed} />
                </div>
            )}
            {tab === 'recent' && (
                <RecentStripList
                    recentQueries={recentQueries}
                    onLoad={onLoadRecent}
                    onTogglePin={onTogglePinRecent}
                    onRemove={onRemoveRecent}
                />
            )}
        </motion.div>
    )
}


function StripTabBtn({
    active, onClick, children,
}: {
    active: boolean
    onClick: () => void
    children: ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold',
                'transition-colors',
                active
                    ? 'bg-accent-lineage/20 text-accent-lineage'
                    : 'text-ink-muted hover:text-ink',
            )}
        >
            {children}
        </button>
    )
}


function RecentStripList({
    recentQueries, onLoad, onTogglePin, onRemove,
}: {
    recentQueries: ReadonlyArray<RecentQueryEntry>
    onLoad: (entry: RecentQueryEntry) => void
    onTogglePin: (timestamp: number) => void
    onRemove: (timestamp: number) => void
}) {
    if (recentQueries.length === 0) {
        return (
            <div className="px-2 py-4 text-[11.5px] text-ink-muted italic text-center">
                No recent searches yet — they'll appear here as you run queries.
            </div>
        )
    }
    return (
        <div className="flex flex-col gap-1 max-h-72 overflow-y-auto custom-scrollbar">
            {recentQueries.map((entry) => {
                const label = entry.label || '(empty)'
                const truncated = label.length > 80 ? label.slice(0, 77) + '…' : label
                return (
                    <div
                        key={entry.timestamp}
                        className={cn(
                            'group/recent flex items-stretch gap-0 rounded-lg overflow-hidden',
                            'bg-canvas-base/40 hover:bg-canvas-base/70',
                            'border border-glass-border/60 hover:border-accent-lineage/40',
                            'transition-colors',
                        )}
                    >
                        <button
                            type="button"
                            onClick={() => onLoad(entry)}
                            title={`Load: ${label}`}
                            className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left"
                        >
                            <DynamicIcon name="Search" className="w-3 h-3 text-ink-muted/70 shrink-0" />
                            <span className="text-[11.5px] font-mono text-ink truncate">
                                {truncated}
                            </span>
                        </button>
                        <button
                            type="button"
                            onClick={() => onTogglePin(entry.timestamp)}
                            title={entry.pinned ? 'Unpin (allow auto-eviction)' : 'Pin to keep this query'}
                            aria-pressed={entry.pinned}
                            className={cn(
                                'inline-flex items-center justify-center w-7 shrink-0',
                                'transition-colors',
                                entry.pinned
                                    ? 'text-amber-400 hover:text-amber-300'
                                    : 'text-ink-muted/40 hover:text-amber-400 opacity-0 group-hover/recent:opacity-100',
                            )}
                        >
                            <DynamicIcon
                                name={entry.pinned ? 'Star' : 'Star'}
                                className="w-3 h-3"
                                style={{ fill: entry.pinned ? 'currentColor' : 'transparent' }}
                            />
                        </button>
                        <button
                            type="button"
                            onClick={() => onRemove(entry.timestamp)}
                            title="Remove from Recent"
                            className={cn(
                                'inline-flex items-center justify-center w-6 shrink-0',
                                'text-ink-muted/40 hover:text-rose-400',
                                'opacity-0 group-hover/recent:opacity-100 transition-opacity',
                            )}
                        >
                            <DynamicIcon name="X" className="w-3 h-3" />
                        </button>
                    </div>
                )
            })}
        </div>
    )
}


// The QueryCard now owns its empty-state hero (with discovery-driven
// example queries), so SearchMapPanel doesn't need a redundant hint.
