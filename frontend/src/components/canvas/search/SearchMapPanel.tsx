/**
 * The production search surface — premium, business-and-technical-grade.
 *
 * Right-side glass drawer with a backdrop-dim layer that turns the
 * search into a focused workspace mode rather than a floating tool.
 * The header bar matches the canvas's existing gradient-toolbar language
 * (icon container in colored gradient, display-font title, contextual
 * subtitle). The body walks through three states:
 *
 *   Pick      → grouped, accent-colored template cards
 *   Configure → inline parameter form
 *   Results   → aggregate bucket cards (with count-up + share bar) and
 *               hit rows (with chip-style ancestor breadcrumb + reveal)
 *
 * Drill semantics: clicking a bucket pushes a scope frame and re-runs
 * the same template; the breadcrumb at the top pops back. Clicking an
 * ancestor chip on a hit row drills to that ancestor.
 */
import { motion, AnimatePresence } from 'framer-motion'
import {
    AlertTriangle,
    ChevronRight,
    Loader2,
    SearchX,
    Sparkles,
    X,
} from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import type {
    AncestorRef,
    SearchAggregateBucket,
    SearchHit,
} from '@/types/search'

import { useAdvancedSearch, type ScopeFrame } from '@/hooks/useAdvancedSearch'

import { AggregateBucketCard } from './AggregateBucketCard'
import { SearchHitRow } from './SearchHitRow'
import { TemplateForm } from './TemplateForm'
import { TemplatePicker } from './TemplatePicker'


export interface SearchMapPanelProps {
    open: boolean
    onClose: () => void
    /** Reveal a node in the host canvas: walks the ancestor chain,
     * expands each ancestor in turn (lazy-loading children as needed),
     * then selects + scrolls to the hit. The ancestor path comes from
     * the search response when `includeAncestorPath: true`. */
    onRevealNode?: (urn: string, ancestorPath: AncestorRef[]) => void
    /** Optional: open the node's details panel. */
    onOpenNode?: (urn: string) => void
}

export const SearchMapPanel: FC<SearchMapPanelProps> = ({
    open, onClose, onRevealNode, onOpenNode,
}) => (
    <AnimatePresence>
        {open && (
            <>
                {/* Backdrop — solid dim, no backdrop-filter blur (the
                    blur was the single most expensive thing in the
                    drawer because it composites the entire canvas
                    behind it on every frame). Click to dismiss. */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    onClick={onClose}
                    className="absolute inset-0 z-40 bg-black/15 dark:bg-black/35"
                />

                {/* Drawer */}
                <motion.div
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 24 }}
                    transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                    className={cn(
                        // z-50 sits above the editor toolbar (z-30), the
                        // node palette (z-20), and our backdrop (z-40).
                        // Below the dev-panel (z-9999) by design.
                        "absolute top-3 right-3 bottom-3 z-50",
                        "w-[34rem] max-w-[calc(100vw-1.5rem)]",
                        "flex flex-col overflow-hidden",
                        "rounded-2xl",
                        // glass-panel utility = adaptive light/dark glass
                        // with backdrop-blur + border + shadow. Matches
                        // NodePalette / TraceBottomDock so the panel
                        // reads as part of the canvas chrome instead of
                        // a sheet of paper pasted over it.
                        "glass-panel shadow-2xl",
                    )}
                    data-testid="search-map-panel"
                >
                    <PanelInner
                        onClose={onClose}
                        onRevealNode={onRevealNode}
                        onOpenNode={onOpenNode}
                    />
                </motion.div>
            </>
        )}
    </AnimatePresence>
)


function PanelInner({
    onClose, onRevealNode, onOpenNode,
}: {
    onClose: () => void
    onRevealNode?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpenNode?: (urn: string) => void
}) {
    const {
        view, scope,
        selectTemplate, setInput, resetTemplate,
        run, drillInto, popScope,
    } = useAdvancedSearch()

    const knownEntityTypes = useEntityTypeNames()

    return (
        <>
            <PanelHeader view={view} onClose={onClose} />

            {/* Scope breadcrumb (visible when drilled) */}
            {scope.length > 1 && (
                <ScopeBreadcrumb scope={scope} onPop={popScope} />
            )}

            {/* Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
                {view.kind === 'idle' && (
                    <TemplatePicker onPick={(t) => selectTemplate(t.id)} />
                )}

                {view.kind === 'templateSelected' && (
                    <TemplateForm
                        template={view.template}
                        inputs={view.inputs}
                        knownEntityTypes={knownEntityTypes}
                        isRunning={false}
                        onChange={setInput}
                        onRun={run}
                        onBack={resetTemplate}
                    />
                )}

                {view.kind === 'running' && (
                    <RunningSkeleton template={view.template.label} />
                )}

                {view.kind === 'results' && (
                    <ResultsView
                        view={view}
                        onBack={resetTemplate}
                        onDrill={drillInto}
                        onReveal={onRevealNode}
                        onOpen={onOpenNode}
                    />
                )}

                {view.kind === 'error' && (
                    <ErrorView message={view.message} onBack={resetTemplate} />
                )}
            </div>
        </>
    )
}


// ---------------------------------------------------------------------------
// Header — rich gradient bar matching ContextViewHeader's pattern
// ---------------------------------------------------------------------------

function PanelHeader({
    view, onClose,
}: {
    view: ReturnType<typeof useAdvancedSearch>['view']
    onClose: () => void
}) {
    return (
        <div className={cn(
            "shrink-0 relative overflow-hidden",
            "px-5 py-4",
            "border-b border-glass-border",
            "bg-gradient-to-r from-canvas-elevated/60 via-canvas-elevated/40 to-canvas-elevated/60",
        )}>
            {/* Dark-mode-only subtle gradient overlay for character */}
            <div className={cn(
                "absolute inset-0 hidden dark:block pointer-events-none",
                "bg-gradient-to-r from-accent-lineage/[0.04] via-transparent to-purple-500/[0.04]",
            )} />

            <div className="relative flex items-center gap-3">
                <div className={cn(
                    "shrink-0 w-10 h-10 rounded-xl flex items-center justify-center",
                    "bg-gradient-to-br from-accent-lineage/25 to-purple-500/20",
                    "shadow-lg shadow-accent-lineage/15",
                )}>
                    <Sparkles
                        className="w-5 h-5 text-accent-lineage"
                        strokeWidth={2.2}
                    />
                </div>
                <div className="flex-1 min-w-0">
                    <h2 className="text-base font-display font-semibold text-ink tracking-tight">
                        Advanced Search
                    </h2>
                    <p className="text-[11px] text-ink-muted/80 mt-0.5 flex items-center gap-1.5">
                        <ChevronRight className="w-3 h-3" strokeWidth={2.5} />
                        {headerSubtitle(view)}
                    </p>
                </div>
                <button
                    onClick={onClose}
                    className={cn(
                        "shrink-0 p-2 rounded-lg",
                        "text-ink-muted hover:text-ink",
                        "hover:bg-glass/40",
                        "transition-colors",
                    )}
                    aria-label="Close advanced search"
                >
                    <X className="w-4 h-4" strokeWidth={2} />
                </button>
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Scope breadcrumb
// ---------------------------------------------------------------------------

function ScopeBreadcrumb({
    scope, onPop,
}: { scope: ScopeFrame[]; onPop: (toIndex: number) => void }) {
    return (
        <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={{ duration: 0.2 }}
            className={cn(
                "shrink-0 px-5 py-2.5",
                "border-b border-glass-border/60",
                "bg-gradient-to-r from-accent-lineage/[0.04] via-transparent to-accent-lineage/[0.04]",
            )}
        >
            <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] uppercase tracking-[0.12em] font-semibold text-ink-muted/70 mr-1">
                    Scoped to
                </span>
                {scope.map((frame, i) => {
                    const isLast = i === scope.length - 1
                    return (
                        <span
                            key={`${frame.urn}-${i}`}
                            className="inline-flex items-center gap-1.5"
                        >
                            {i > 0 && (
                                <ChevronRight
                                    className="w-3 h-3 text-ink-muted/50"
                                    strokeWidth={2.5}
                                />
                            )}
                            <button
                                onClick={() => onPop(i)}
                                disabled={isLast}
                                className={cn(
                                    "px-2 py-1 rounded-lg text-[11px] font-medium",
                                    "transition-all duration-150",
                                    isLast
                                        ? "bg-accent-lineage/20 text-accent-lineage cursor-default"
                                        : "bg-glass/40 text-ink-secondary hover:bg-glass/70 hover:text-ink",
                                )}
                            >
                                {frame.label}
                            </button>
                        </span>
                    )
                })}
            </div>
        </motion.div>
    )
}


// ---------------------------------------------------------------------------
// Running skeleton
// ---------------------------------------------------------------------------

function RunningSkeleton({ template }: { template: string }) {
    return (
        <div className="flex flex-col">
            <div className="flex items-center gap-3 mb-6">
                <div className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center",
                    "bg-gradient-to-br from-accent-lineage/20 to-purple-500/15",
                    "shadow-sm",
                )}>
                    <Loader2 className="w-5 h-5 text-accent-lineage animate-spin" />
                </div>
                <div>
                    <div className="text-sm font-display font-semibold text-ink">
                        Running &ldquo;{template}&rdquo;
                    </div>
                    <div className="text-xs text-ink-muted mt-0.5">
                        searching your graph…
                    </div>
                </div>
            </div>

            {/* Skeleton placeholder bucket cards */}
            <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className={cn(
                            "rounded-2xl border border-glass-border/40",
                            "bg-gradient-to-br from-canvas-elevated/40 to-canvas-elevated/20",
                            "p-5 h-[180px]",
                            "animate-pulse-soft",
                        )}
                        style={{
                            animationDelay: `${i * 120}ms`,
                            opacity: 1 - i * 0.2,
                        }}
                    >
                        <div className="flex items-center gap-3">
                            <div className="w-11 h-11 rounded-xl bg-glass/40" />
                            <div className="flex-1 space-y-1.5">
                                <div className="h-3 w-32 rounded bg-glass/40" />
                                <div className="h-2 w-16 rounded bg-glass/30" />
                            </div>
                        </div>
                        <div className="mt-4 h-8 w-20 rounded bg-glass/40" />
                        <div className="mt-3 h-2 w-full rounded-full bg-glass/30" />
                    </div>
                ))}
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Results view — header + summary + bucket grid + hit list
// ---------------------------------------------------------------------------

function ResultsView({
    view, onBack, onDrill, onReveal, onOpen,
}: {
    view: Extract<ReturnType<typeof useAdvancedSearch>['view'], { kind: 'results' }>
    onBack: () => void
    onDrill: (b: { ancestorUrn: string; ancestorDisplayName: string; ancestorEntityType: string }) => void
    onReveal?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpen?: (urn: string) => void
}) {
    const { template, result, elapsedMs } = view

    const allBuckets: SearchAggregateBucket[] = useMemo(() => {
        if (!result.aggregates) return []
        return result.aggregates.flat()
    }, [result.aggregates])
    const grandTotal = useMemo(
        () => allBuckets.reduce((sum, b) => sum + b.matchCount, 0),
        [allBuckets],
    )
    const hits: SearchHit[] = result.hits ?? []

    const hasAggregates = allBuckets.length > 0
    const hasHits = hits.length > 0
    const isEmpty = !hasAggregates && !hasHits

    return (
        <div className="flex flex-col gap-5">
            <ResultsHeader
                templateLabel={template.label}
                elapsedMs={elapsedMs}
                candidateCount={result.candidateCount}
                bucketCount={allBuckets.length}
                hitCount={hits.length}
                truncated={result.truncated}
                onBack={onBack}
            />

            {isEmpty && <EmptyResults onBack={onBack} />}

            {hasAggregates && (
                <section className="space-y-3">
                    <SectionHeader
                        title={`${allBuckets.length} ${allBuckets.length === 1 ? 'group' : 'groups'}`}
                        subtitle="Click any group to drill into it"
                    />
                    <div className="space-y-3">
                        {allBuckets.map((b, i) => (
                            <AggregateBucketCard
                                key={`${b.ancestorUrn}-${i}`}
                                bucket={b}
                                grandTotal={grandTotal}
                                index={i}
                                onDrill={() => onDrill(b)}
                            />
                        ))}
                    </div>
                </section>
            )}

            {hasHits && (
                <section>
                    <SectionHeader
                        title={`${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}
                        subtitle={
                            result.truncated
                                ? `Showing first ${hits.length} · refine to narrow`
                                : 'Hover a row for actions'
                        }
                    />
                    <div className="space-y-0.5 mt-2">
                        {hits.map((hit, i) => (
                            <SearchHitRow
                                key={hit.node.urn}
                                hit={hit}
                                index={i}
                                onReveal={onReveal}
                                onOpen={onOpen}
                            />
                        ))}
                    </div>
                </section>
            )}
        </div>
    )
}


/** Results header — back link + template name + key metric */
function ResultsHeader({
    templateLabel, elapsedMs, candidateCount, bucketCount, hitCount, truncated, onBack,
}: {
    templateLabel: string
    elapsedMs: number
    candidateCount: number
    bucketCount: number
    hitCount: number
    truncated: boolean
    onBack: () => void
}) {
    const totalMatches = bucketCount > 0 ? candidateCount : hitCount
    return (
        <div className={cn(
            "rounded-2xl p-4",
            "bg-gradient-to-br from-accent-lineage/[0.06] via-canvas-elevated/40 to-accent-lineage/[0.04]",
            "border border-accent-lineage/20",
        )}>
            <button
                onClick={onBack}
                className={cn(
                    "inline-flex items-center gap-1.5 text-[11px] font-medium",
                    "text-ink-muted hover:text-ink transition-colors",
                )}
            >
                ← Change question
            </button>
            <div className="mt-2 flex items-baseline justify-between gap-3">
                <h3 className="text-base font-display font-semibold text-ink leading-tight">
                    {templateLabel}
                </h3>
                <div className="text-[10px] uppercase tracking-[0.1em] text-ink-muted tabular-nums shrink-0">
                    {elapsedMs}ms
                </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-display font-semibold text-ink tabular-nums leading-none">
                    {totalMatches.toLocaleString()}
                </span>
                <span className="text-xs text-ink-muted">matches</span>
                {truncated && (
                    <span className={cn(
                        "ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
                        "text-[10px] font-medium",
                        "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                        "border border-amber-500/30",
                    )}>
                        <AlertTriangle className="w-3 h-3" />
                        truncated
                    </span>
                )}
            </div>
        </div>
    )
}


function SectionHeader({
    title, subtitle,
}: { title: string; subtitle?: string }) {
    return (
        <div className="px-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                {title}
            </div>
            {subtitle && (
                <div className="text-[11px] text-ink-muted/70 mt-0.5">
                    {subtitle}
                </div>
            )}
        </div>
    )
}


function EmptyResults({ onBack }: { onBack: () => void }) {
    return (
        <div className="flex flex-col items-center text-center py-10 px-4">
            <div className={cn(
                "w-14 h-14 rounded-2xl flex items-center justify-center",
                "bg-gradient-to-br from-glass/50 to-glass/20 border border-glass-border",
                "text-ink-muted",
            )}>
                <SearchX className="w-6 h-6" strokeWidth={1.75} />
            </div>
            <div className="mt-4 text-sm font-display font-semibold text-ink">
                No matches in this scope
            </div>
            <p className="mt-1.5 text-xs text-ink-muted max-w-[20rem] leading-relaxed">
                Try widening the scope, adjusting the parameters, or picking
                a different question. The Discover tab in the dev panel can
                show what&apos;s actually present in your data.
            </p>
            <button
                onClick={onBack}
                className={cn(
                    "mt-5 px-3.5 py-2 rounded-lg text-xs font-medium",
                    "bg-glass/40 hover:bg-glass/60 text-ink",
                    "border border-glass-border",
                    "transition-colors",
                )}
            >
                Pick another question
            </button>
        </div>
    )
}


function ErrorView({
    message, onBack,
}: { message: string; onBack: () => void }) {
    return (
        <div className={cn(
            "rounded-2xl p-5",
            "bg-gradient-to-br from-rose-500/10 to-amber-500/5",
            "border border-rose-500/30",
        )}>
            <div className="flex items-start gap-3">
                <div className={cn(
                    "shrink-0 w-9 h-9 rounded-xl flex items-center justify-center",
                    "bg-rose-500/15 text-rose-600 dark:text-rose-400",
                    "border border-rose-500/30",
                )}>
                    <AlertTriangle className="w-4 h-4" strokeWidth={2.2} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-rose-700 dark:text-rose-300">
                        Search failed
                    </div>
                    <div className="mt-2 text-sm text-ink leading-relaxed whitespace-pre-wrap break-words">
                        {message}
                    </div>
                </div>
            </div>
            <button
                onClick={onBack}
                className={cn(
                    "mt-4 px-3.5 py-2 rounded-lg text-xs font-medium",
                    "bg-glass/50 hover:bg-glass/70 text-ink",
                    "border border-glass-border",
                    "transition-colors",
                )}
            >
                Back to questions
            </button>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headerSubtitle(
    view: ReturnType<typeof useAdvancedSearch>['view'],
): string {
    switch (view.kind) {
        case 'idle':
            return 'Pick a question to explore your graph'
        case 'templateSelected':
            return `${view.template.label} · configure parameters`
        case 'running':
            return `Searching · ${view.template.label}`
        case 'results':
            return view.template.label
        case 'error':
            return 'Error · click Back to retry'
    }
}


function useEntityTypeNames(): string[] {
    const schema = useSchemaStore((s) => s.schema)
    return useMemo(
        () => (schema?.entityTypes ?? []).map((t) => t.id),
        [schema],
    )
}
