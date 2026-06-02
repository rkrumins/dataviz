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
import { BookOpen, SlidersHorizontal, X } from 'lucide-react'
import {
    type FC,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'

import { cn } from '@/lib/utils'
import { useAdvancedSearch } from '@/hooks/useAdvancedSearch'
import {
    DEFAULT_DRAFT_OPTIONS,
    readPersistedCanvasFilterMode,
    useAncestorMatchCounts,
    useDraftOptions,
    useDraftPredicate,
    useRecentQueries,
    useSearchStore,
    type RecentQueryEntry,
} from '@/store/searchStore'
import type { AncestorRef } from '@/types/search'

import { AdvancedDrawer, type DrawerTab } from './panel/AdvancedDrawer'
import { LibraryPopover } from './panel/LibraryPopover'
import { MatchBar } from './panel/MatchBar'
import { NoViewState } from './panel/NoViewState'
import { QueryCard } from './panel/QueryCard'
import { ResizeHandle, readPersistedWidth } from './panel/ResizeHandle'
import { ResultsPane } from './panel/ResultsPane'
import { SaveQueryDialog } from './panel/SaveQueryDialog'
import { BulkGroupActionBar } from './panel/builder-atoms/BulkGroupActionBar'
import { ScopeModePicker } from './panel/ScopeModePicker'
import { ScopeStrip } from './panel/ScopeStrip'
import {
    defaultInputs,
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
                    {/* Multi-select "Group as AND / OR" floating bar.
                        Self-hides when fewer than 2 rows selected. */}
                    {viewId && <BulkGroupActionBar />}
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
        resetTemplate, loadMore, isLoadingMore,
    } = useAdvancedSearch(viewId)

    const draftPredicate = useDraftPredicate()
    const draftOptions = useDraftOptions()
    const matchUrnSet = useSearchStore((s) => s.matchUrnSet)
    const ancestorMatchCounts = useAncestorMatchCounts()
    const commitDraft = useSearchStore((s) => s.commitDraft)
    const clearStore = useSearchStore((s) => s.clear)
    const recentQueries = useRecentQueries(viewId)
    const togglePinRecent = useSearchStore((s) => s.togglePinRecent)
    const removeRecent = useSearchStore((s) => s.removeRecent)
    const promoteToMine = useSearchStore((s) => s.promoteToMine)
    const stepFocus = useSearchStore((s) => s.stepFocus)
    const setCanvasFilterMode = useSearchStore((s) => s.setCanvasFilterMode)

    const [advancedOpen, setAdvancedOpen] = useState(false)
    const [advancedTab, setAdvancedTab] = useState<DrawerTab>('options')
    const [libraryOpen, setLibraryOpen] = useState(false)
    // Save-as dialog state owned at the panel level (not inside
    // LibraryPopover) so the dialog survives when the popover closes —
    // see SaveQueryDialog for the framer-motion portal rationale and
    // LibraryPopover for the lifecycle handoff.
    const [saveTarget, setSaveTarget] = useState<RecentQueryEntry | null>(null)

    const openAdvanced = useCallback((tab: DrawerTab = 'options') => {
        setAdvancedTab(tab)
        setAdvancedOpen(true)
    }, [])

    // Hydrate per-view canvas-filter-mode preference on mount /
    // viewId change. The store keeps a single ``canvasFilterMode``
    // slot; we sync it from the persisted per-view map so
    // ContextViewCanvas / GraphCanvas / HierarchyCanvas pick up the
    // user's saved preference for THIS view.
    useEffect(() => {
        const persisted = readPersistedCanvasFilterMode(viewId)
        setCanvasFilterMode(persisted, viewId)
    }, [viewId, setCanvasFilterMode])

    // "Open in Advanced Search + run" bridge: an external surface (the
    // Property Manager value clicks / quick actions) seeds the draft and
    // sets ``pendingRunPredicate``; the panel consumes it on mount/change
    // and runs it through the real engine — regardless of run mode — so
    // the constructed query executes once and spotlights the matches.
    const pendingRunPredicate = useSearchStore((s) => s.pendingRunPredicate)
    useEffect(() => {
        if (!pendingRunPredicate) return
        const p = useSearchStore.getState().consumePendingRun()
        if (p) void runPredicate(p, { results: 'hits', pageSize: 5000, includeAncestorPath: true })
    }, [pendingRunPredicate, runPredicate])

    // Count of options that differ from defaults — drives the badge
    // on the Options toolbar chip. Power-user-tuned queries get a
    // visible "someone has set non-default options here" signal
    // instead of silently behaving differently than fresh queries.
    const optionsDeltaCount = useMemo(() => {
        if (!draftOptions) return 0
        let delta = 0
        if (draftOptions.candidateCap !== DEFAULT_DRAFT_OPTIONS.candidateCap) delta += 1
        if (draftOptions.pageSize !== DEFAULT_DRAFT_OPTIONS.pageSize) delta += 1
        if (draftOptions.includeAncestorPath !== DEFAULT_DRAFT_OPTIONS.includeAncestorPath) delta += 1
        if (draftOptions.aggregations.length > 0) delta += 1
        return delta
    }, [draftOptions])

    const handleClear = useCallback(() => {
        // Three resets — each owns a different slice of state and skipping
        // any leaves stale UI behind:
        //   1. cancel()       aborts an in-flight request and clears
        //                     the searchStore's published result set
        //                     (matchUrnSet etc.) so the canvas drops
        //                     its highlight ring.
        //   2. resetTemplate() moves the panel's local ``view`` state
        //                     back to ``'idle'`` — without this the
        //                     MatchBar + ResultsPane stay mounted (the
        //                     ``showResultsSection`` gate keeps them
        //                     visible for any non-idle kind) so the X
        //                     button looked like it did nothing.
        //   3. clearStore()   wipes the draft predicate / undo stack
        //                     too so the QueryCard returns to its
        //                     empty hero rather than redisplaying the
        //                     same filter rows the cleared run came
        //                     from.
        cancel()
        resetTemplate()
        clearStore()
    }, [cancel, resetTemplate, clearStore])

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
        setLibraryOpen(false)
    }, [commitDraft])

    const handleLoadRecent = useCallback((entry: RecentQueryEntry) => {
        commitDraft(entry.predicate)
        setLibraryOpen(false)
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

    // Resolve the focused match's ancestor path from the current
    // result page. Stepping (J/K) only updates ``focusedMatchIndex``;
    // canvas reveal is reserved for this explicit handler so the user
    // controls when the canvas pans/expands. No-op when there's no
    // focused match or no matching hit in the current page.
    const revealFocusedOnCanvas = useCallback(() => {
        if (!onRevealNode) return
        const { orderedMatchUrns, focusedMatchIndex } = useSearchStore.getState()
        if (focusedMatchIndex === null) return
        const urn = orderedMatchUrns[focusedMatchIndex]
        if (!urn) return
        const hits = view.kind === 'results' ? (view.result.hits ?? []) : []
        const hit = hits.find((h) => h.node.urn === urn)
        onRevealNode(urn, hit?.ancestorPath ?? [])
    }, [onRevealNode, view])

    // Panel-level keyboard handler. J/↓ → next match, K/↑ → prev,
    // Enter → reveal the focused match on the canvas (the deliberate
    // canvas-motion action that stepping deliberately avoids). Only
    // fires when focus is inside the panel AND not currently in a
    // text input so the user can still type in the query card / row
    // filter without triggering these shortcuts.
    const panelRef = useRef<HTMLDivElement>(null)
    const handlePanelKeyDown = useCallback((e: React.KeyboardEvent) => {
        const target = e.target as HTMLElement | null
        if (target && (
            target.tagName === 'INPUT'
            || target.tagName === 'TEXTAREA'
            || target.isContentEditable
        )) return
        switch (e.key) {
            case 'j':
            case 'J':
            case 'ArrowDown':
                e.preventDefault()
                stepFocus('next')
                return
            case 'k':
            case 'K':
            case 'ArrowUp':
                e.preventDefault()
                stepFocus('prev')
                return
            case 'Enter': {
                e.preventDefault()
                revealFocusedOnCanvas()
                return
            }
            default:
                return
        }
    }, [stepFocus, revealFocusedOnCanvas])

    return (
        <div
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={handlePanelKeyDown}
            className="h-full flex flex-col overflow-hidden outline-none"
        >
            <LibraryPopover
                open={libraryOpen}
                onOpenChange={setLibraryOpen}
                recentQueries={recentQueries}
                onSeedTemplate={handleSeedTemplate}
                onLoadRecent={handleLoadRecent}
                onTogglePinRecent={togglePinRecent}
                onRemoveRecent={removeRecent}
                onSaveAs={setSaveTarget}
                viewId={viewId}
                activeDraft={Boolean(draftPredicate)}
            >
                <div>
                    <CompactHeader
                        onClose={onClose}
                        onOpenLibrary={() => setLibraryOpen((v) => !v)}
                        libraryOpen={libraryOpen}
                        onOpenOptions={() => openAdvanced('options')}
                        optionsDeltaCount={optionsDeltaCount}
                    />
                </div>
            </LibraryPopover>

            {saveTarget && (
                <SaveQueryDialog
                    entry={saveTarget}
                    onCancel={() => setSaveTarget(null)}
                    onSave={(name, description) => {
                        promoteToMine(saveTarget.timestamp, name, description)
                        setSaveTarget(null)
                    }}
                />
            )}

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

                        {showResultsSection && (
                            <div className="flex flex-col gap-2">
                                <MatchBar
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
                                    onShowFocusedOnCanvas={onRevealNode
                                        ? revealFocusedOnCanvas
                                        : undefined}
                                    onClear={view.kind === 'results' || view.kind === 'error'
                                        ? handleClear
                                        : undefined}
                                    viewId={viewId}
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
        </div>
    )
}


// =============================================================================
// Header — labeled toolbar (Library | Mode | Options | ×)
// =============================================================================

/**
 * Header toolbar. Replaces the previous opaque-icon row. Each control
 * is a labeled chip so the user can identify it without hovering for
 * a tooltip:
 *
 *   - Library: opens the unified LibraryPopover (Mine / Shared /
 *     Templates tabs). Active state when open.
 *   - Options: opens the Advanced drawer on its Options tab. Shows a
 *     numeric badge when any option differs from default so a query
 *     that's been power-user-tuned is visually distinct.
 *   - ×:       closes the panel.
 */
function CompactHeader({
    onClose, onOpenLibrary, libraryOpen, onOpenOptions, optionsDeltaCount,
}: {
    onClose: () => void
    onOpenLibrary: () => void
    libraryOpen: boolean
    onOpenOptions: () => void
    optionsDeltaCount: number
}) {
    return (
        <div className={cn(
            'flex items-center gap-2 px-4 py-3',
            'border-b border-glass-border/60 bg-canvas-elevated/60',
        )}>
            <div className="flex items-center gap-2 min-w-0 shrink-0">
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
            <div className="ml-auto flex items-center gap-1">
                <ToolbarChip
                    label="Library"
                    title="Saved queries, recent runs, and templates"
                    Icon={BookOpen}
                    active={libraryOpen}
                    onClick={onOpenLibrary}
                />
                <ToolbarChip
                    label="Options"
                    title={optionsDeltaCount > 0
                        ? `${optionsDeltaCount} option${optionsDeltaCount === 1 ? '' : 's'} differ from default`
                        : 'Advanced options'}
                    Icon={SlidersHorizontal}
                    active={false}
                    onClick={onOpenOptions}
                    badge={optionsDeltaCount > 0 ? optionsDeltaCount : undefined}
                />
                <button
                    type="button"
                    onClick={onClose}
                    title="Close"
                    className={cn(
                        'inline-flex items-center justify-center w-7 h-7 rounded-md ml-1',
                        'text-ink-muted hover:text-ink hover:bg-glass/40 transition-colors',
                    )}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}


/**
 * One labeled chip in the header toolbar. Icon + 1-word label sits
 * inline on a single line; active state is a filled accent background
 * (not just a color shift) so it reads as a clear "this is open right
 * now" toggle. The badge slot is for the Options chip's
 * non-default-count indicator.
 */
function ToolbarChip({
    label, title, Icon, active, onClick, badge,
}: {
    label: string
    title: string
    Icon: typeof BookOpen
    active: boolean
    onClick: () => void
    badge?: number
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            aria-pressed={active}
            className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2 rounded-md',
                'text-[11.5px] font-medium transition-colors relative',
                active
                    ? 'bg-accent-lineage/20 text-accent-lineage'
                    : 'text-ink-secondary hover:text-ink hover:bg-glass/40',
            )}
        >
            <Icon className="w-3.5 h-3.5" />
            <span>{label}</span>
            {badge !== undefined && (
                <span className={cn(
                    'inline-flex items-center justify-center min-w-[14px] h-[14px] px-1',
                    'text-[9.5px] font-semibold tabular-nums rounded-full',
                    'bg-amber-500/30 text-amber-700 dark:text-amber-200',
                    'border border-amber-500/50',
                )}>
                    {badge}
                </span>
            )}
        </button>
    )
}


// The QueryCard now owns its empty-state hero (with discovery-driven
// example queries), so SearchMapPanel doesn't need a redundant hint.
// The previous TemplatesStrip / StripTabBtn / RecentStripList helpers
// were removed when LibraryPopover replaced them — see
// ./panel/LibraryPopover.tsx for the unified library surface.
