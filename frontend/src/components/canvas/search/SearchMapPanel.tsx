/**
 * The production search surface — premium, business-and-technical-grade.
 *
 * A right-side glass-panel drawer that opens on demand. Three states
 * the user moves through:
 *
 *   1. **Pick** — verb-driven template gallery ("Layout by layer",
 *      "Find by tag", etc.). Tactile cards; click to advance.
 *   2. **Configure** — inline parameter form for the chosen template,
 *      one field per input. Big primary "Run search" button.
 *   3. **Results** — aggregate bucket cards (the "orient before drill"
 *      shape: huge display-font count + share-of-total bar + sample
 *      chips) and/or hit rows (clean, breadcrumb, hover-revealed
 *      actions). Each bucket drills the scope; the breadcrumb pops
 *      back.
 *
 * The "advanced JSON" experience lives in a separate dev panel
 * (AdvancedSearchDevPanel) gated by ?devSearch=1. This component
 * is the everyday surface — no JSON, no Cypher, no predicate jargon.
 */
import { motion, AnimatePresence } from 'framer-motion'
import {
    ChevronRight,
    Loader2,
    SearchX,
    Sparkles,
    X,
} from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import type { SearchAggregateBucket, SearchHit } from '@/types/search'

import { useAdvancedSearch, type ScopeFrame } from '@/hooks/useAdvancedSearch'

import { AggregateBucketCard } from './AggregateBucketCard'
import { SearchHitRow } from './SearchHitRow'
import { TemplateForm } from './TemplateForm'
import { TemplatePicker } from './TemplatePicker'


export interface SearchMapPanelProps {
    open: boolean
    onClose: () => void
    /** Optional: reveal a node in the host canvas (select + scroll). */
    onRevealNode?: (urn: string) => void
    /** Optional: open the node's details panel. */
    onOpenNode?: (urn: string) => void
}

export const SearchMapPanel: FC<SearchMapPanelProps> = ({
    open, onClose, onRevealNode, onOpenNode,
}) => {
    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 24 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className={cn(
                        // z-50 sits above the editor toolbar (z-30) and the
                        // node palette (z-20) so the search drawer is the
                        // top-most canvas overlay. Below the dev-panel
                        // (z-9999) by design — the dev panel is explicitly
                        // an instrumentation surface that overlays everything.
                        "absolute top-4 right-4 bottom-4 z-50",
                        "w-[28rem] max-w-[calc(100vw-2rem)]",
                        "glass-panel rounded-2xl",
                        "flex flex-col overflow-hidden",
                    )}
                    data-testid="search-map-panel"
                >
                    <PanelInner onClose={onClose}
                                onRevealNode={onRevealNode}
                                onOpenNode={onOpenNode} />
                </motion.div>
            )}
        </AnimatePresence>
    )
}


function PanelInner({
    onClose, onRevealNode, onOpenNode,
}: {
    onClose: () => void
    onRevealNode?: (urn: string) => void
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
            {/* Header */}
            <div className={cn(
                "shrink-0 px-4 py-3 flex items-center gap-2",
                "border-b border-glass-border bg-glass/30",
            )}>
                <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center",
                    "bg-accent-lineage/15 text-accent-lineage",
                )}>
                    <Sparkles className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink">
                        Advanced search
                    </div>
                    <div className="text-2xs text-ink-muted">
                        {headerSubtitle(view)}
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className={cn(
                        "p-1.5 rounded-md text-ink-muted",
                        "hover:bg-glass/40 hover:text-ink",
                        "transition-colors",
                    )}
                    aria-label="Close advanced search"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Scope breadcrumb — shown when drilled */}
            {scope.length > 1 && (
                <ScopeBreadcrumb scope={scope} onPop={popScope} />
            )}

            {/* Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
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
// Sub-renderers
// ---------------------------------------------------------------------------

function ScopeBreadcrumb({
    scope, onPop,
}: { scope: ScopeFrame[]; onPop: (toIndex: number) => void }) {
    return (
        <div className={cn(
            "shrink-0 px-4 py-2 flex items-center gap-1 flex-wrap",
            "border-b border-glass-border/60 bg-glass/15",
        )}>
            <span className="text-2xs uppercase tracking-wider text-ink-muted mr-1">
                Scope:
            </span>
            {scope.map((frame, i) => (
                <span key={`${frame.urn}-${i}`} className="inline-flex items-center gap-1">
                    {i > 0 && (
                        <ChevronRight className="w-3 h-3 text-ink-muted/60" />
                    )}
                    <button
                        onClick={() => onPop(i)}
                        disabled={i === scope.length - 1}
                        className={cn(
                            "px-1.5 py-0.5 rounded text-2xs font-medium",
                            i === scope.length - 1
                                ? "bg-accent-lineage/15 text-accent-lineage cursor-default"
                                : "text-ink-secondary hover:bg-glass/40 hover:text-ink transition-colors",
                        )}
                    >
                        {frame.label}
                    </button>
                </span>
            ))}
        </div>
    )
}


function RunningSkeleton({ template }: { template: string }) {
    return (
        <div className="flex flex-col items-center justify-center pt-8 pb-4">
            <Loader2 className="w-6 h-6 text-accent-lineage animate-spin" />
            <div className="mt-3 text-sm text-ink-secondary">
                Running &ldquo;{template}&rdquo;…
            </div>
            <div className="mt-1 text-2xs text-ink-muted">
                searching your graph
            </div>
            {/* Subtle skeleton placeholders to convey "results are loading" */}
            <div className="w-full mt-6 space-y-3">
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className={cn(
                            "h-20 rounded-xl",
                            "bg-glass/30 border border-glass-border/40",
                            "animate-pulse-soft",
                        )}
                        style={{ animationDelay: `${i * 100}ms` }}
                    />
                ))}
            </div>
        </div>
    )
}


function ResultsView({
    view, onBack, onDrill, onReveal, onOpen,
}: {
    view: Extract<ReturnType<typeof useAdvancedSearch>['view'], { kind: 'results' }>
    onBack: () => void
    onDrill: (b: { ancestorUrn: string; ancestorDisplayName: string; ancestorEntityType: string }) => void
    onReveal?: (urn: string) => void
    onOpen?: (urn: string) => void
}) {
    const { template, result, elapsedMs } = view

    // Flatten aggregate buckets across all AggregationSpecs (we render
    // them sequentially in one column — multi-spec is rare in v1 and
    // doesn't deserve its own tabbed layout yet).
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
        <div className="flex flex-col gap-4">
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
                <section className="space-y-2.5">
                    <SectionHeader
                        title={`${allBuckets.length} ${allBuckets.length === 1 ? 'group' : 'groups'}`}
                        subtitle="Click any group to drill in"
                    />
                    {allBuckets.map((b, i) => (
                        <AggregateBucketCard
                            key={`${b.ancestorUrn}-${i}`}
                            bucket={b}
                            grandTotal={grandTotal}
                            index={i}
                            onDrill={() => onDrill(b)}
                        />
                    ))}
                </section>
            )}

            {hasHits && (
                <section>
                    <SectionHeader
                        title={`${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}
                        subtitle={
                            result.truncated
                                ? `Showing first ${hits.length}; refine to narrow.`
                                : 'Hover a row for actions'
                        }
                    />
                    <div className="space-y-0.5">
                        {hits.map((hit, i) => (
                            <SearchHitRow
                                key={hit.node.urn}
                                hit={hit}
                                index={i}
                                onReveal={onReveal ? () => onReveal(hit.node.urn) : undefined}
                                onOpen={onOpen ? () => onOpen(hit.node.urn) : undefined}
                            />
                        ))}
                    </div>
                </section>
            )}
        </div>
    )
}


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
    const totalMatches = bucketCount > 0
        ? candidateCount
        : hitCount
    return (
        <div>
            <button
                onClick={onBack}
                className={cn(
                    "inline-flex items-center gap-1.5 text-xs",
                    "text-ink-muted hover:text-ink transition-colors",
                )}
            >
                ← Change query
            </button>
            <div className="mt-2 flex items-baseline justify-between gap-3">
                <h3 className="text-base font-display font-medium text-ink leading-tight">
                    {templateLabel}
                </h3>
                <div className="text-2xs text-ink-muted tabular-nums shrink-0">
                    {elapsedMs}ms
                </div>
            </div>
            <div className="mt-1 text-xs text-ink-muted">
                {totalMatches.toLocaleString()} matches
                {truncated && (
                    <span className="text-accent-warning"> · truncated</span>
                )}
            </div>
        </div>
    )
}


function SectionHeader({
    title, subtitle,
}: { title: string; subtitle?: string }) {
    return (
        <div className="px-1 mb-2">
            <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">
                {title}
            </div>
            {subtitle && (
                <div className="text-2xs text-ink-muted/70 mt-0.5">
                    {subtitle}
                </div>
            )}
        </div>
    )
}


function EmptyResults({ onBack }: { onBack: () => void }) {
    return (
        <div className={cn(
            "flex flex-col items-center text-center",
            "py-12 px-4",
        )}>
            <div className={cn(
                "w-12 h-12 rounded-full flex items-center justify-center",
                "bg-glass/40 text-ink-muted",
            )}>
                <SearchX className="w-5 h-5" />
            </div>
            <div className="mt-4 text-sm font-medium text-ink">
                No matches in this scope
            </div>
            <p className="mt-1 text-xs text-ink-muted max-w-[20rem] leading-snug">
                Try widening the scope, adjusting the parameters, or picking
                a different question.
            </p>
            <button
                onClick={onBack}
                className={cn(
                    "mt-4 px-3 py-1.5 rounded-md text-xs",
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
            "rounded-xl p-4",
            "bg-accent-warning/10 border border-accent-warning/30",
        )}>
            <div className="text-xs font-medium uppercase tracking-wider text-accent-warning">
                Search failed
            </div>
            <div className="mt-2 text-sm text-ink leading-snug whitespace-pre-wrap">
                {message}
            </div>
            <button
                onClick={onBack}
                className={cn(
                    "mt-3 px-3 py-1.5 rounded-md text-xs",
                    "bg-glass/40 hover:bg-glass/60 text-ink",
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
            return 'Configure parameters · then Run'
        case 'running':
            return 'Searching…'
        case 'results':
            return view.template.label
        case 'error':
            return 'Error'
    }
}


/** Reads the active view's entity-type names from the schema store. */
function useEntityTypeNames(): string[] {
    const schema = useSchemaStore((s) => s.schema)
    return useMemo(
        () => (schema?.entityTypes ?? []).map((t) => t.id),
        [schema],
    )
}
