/**
 * What the panel says when a search comes back empty.
 *
 * It LEADS with the search itself, in the user's own words — "Nothing in
 * this view contains 'custmer'" — and offers the other three ways to
 * match that word as one click each. That is the answer for almost every
 * empty result: a typo, or a word that is the start of a name rather
 * than the whole of it.
 *
 * The engine-level reading of the same response — edge-type flags the
 * ontology never set, a scope clamp, the resolved scope, what actually
 * exists in the data — is all still here, under "Technical details".
 * True, occasionally decisive, and not what to open on.
 *
 * Causes we detect:
 *   - lineageEdgeTypes is empty AND the query references a lineage-aware
 *     predicate (IsOrphan / IsLeaf / IsRoot / HasIncoming / HasOutgoing /
 *     Degree(edgeClass=lineage) / WithinHops(edgeClass=lineage))
 *   - containmentEdgeTypes is empty AND the query/aggregation uses
 *     ancestor / containment paths
 *   - effectiveRootUrns is empty (search ran unclamped — usually a
 *     non-issue, just informational)
 *   - droppedRootUrns is non-empty (client URNs were filtered out)
 *   - the query carries a `descendantOf` scope row, so it is only
 *     looking inside one container (the most common cause by far —
 *     one click on a result group adds it, and it then applies to
 *     every query composed afterwards until it is removed)
 *   - candidateCount === 0 (the predicate matched nothing in the
 *     data source — usually a content issue or a NOT/AND that's too
 *     restrictive)
 *
 * The first non-informational cause is highlighted. The rest are
 * listed below as additional considerations.
 */
import {
    AlertTriangle,
    ArrowRight,
    ChevronDown,
    ChevronRight,
    Database,
    Info,
    Loader2,
} from 'lucide-react'
import { type FC, type ReactNode, useMemo, useState } from 'react'

import { formatUrnLabel } from '@/lib/urnLabels'
import { cn } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type {
    Predicate,
    SearchDiscoverResult,
    SearchQuery,
    SearchResultPage,
    ScopeDiagnostics,
    TextPredicate,
} from '@/types/search'

import { findScopeCondition } from './panel/predicateComposition'
import type { QuickMatch } from './session/quickPredicate'


export interface ZeroResultsDiagnosticProps {
    /** The result page returned by the backend. */
    result: SearchResultPage
    /** The query that was executed (so we can inspect predicates). */
    query: SearchQuery
    /** Re-run the same word a different way. Absent on the surfaces with
     *  no quick query to switch — the lead then states the miss without
     *  offering the one-click fixes. */
    onSwitchMatch?: (match: QuickMatch) => void
}


interface Cause {
    severity: 'error' | 'warn' | 'info'
    title: string
    body: string
    action?: string
}


export const ZeroResultsDiagnostic: FC<ZeroResultsDiagnosticProps> = ({
    result, query, onSwitchMatch,
}) => {
    const causes = useMemo(() => diagnose(result, query), [result, query])
    const text = useMemo(() => firstTextLeaf(query.predicate), [query.predicate])

    return (
        <div className="flex flex-col gap-2">
            <MissLead text={text} onSwitchMatch={onSwitchMatch} />

            <TechnicalDetails>
                {causes.map((c, i) => (
                    <CauseCard key={i} cause={c} highlighted={i === 0} />
                ))}

                {/* Resolved scope summary. Lets the user verify what the
                    engine ACTUALLY used to match against. */}
                {result.scopeDiagnostics && (
                    <ResolvedScopeCard
                        diag={result.scopeDiagnostics}
                        candidateCount={result.candidateCount}
                    />
                )}

                {/* Inline graph-contents probe — for "did the entity type
                    I queried even exist?" investigations. */}
                <DiscoverProbe query={query} />
            </TechnicalDetails>
        </div>
    )
}


// ---------------------------------------------------------------------------
// The lead — the search, in the user's words, with the way out
// ---------------------------------------------------------------------------

/** The four ways to match a word, in the builder's own labels so the
 *  chip here and the row in Refine name the same thing. */
const MATCH_MODES: ReadonlyArray<{ value: QuickMatch; label: string; verb: string }> = [
    { value: 'substring', label: 'Contains', verb: 'contains' },
    { value: 'prefix', label: 'Starts with', verb: 'starts with' },
    { value: 'suffix', label: 'Ends with', verb: 'ends with' },
    { value: 'exact', label: 'Is exactly', verb: 'is exactly' },
]


function MissLead({
    text, onSwitchMatch,
}: {
    text: TextPredicate | null
    onSwitchMatch?: (match: QuickMatch) => void
}) {
    const mode = MATCH_MODES.find((m) => m.value === text?.match)
    // A query with no text leaf — a builder query about tags, types or
    // lineage — has no word to re-match, so it gets the statement
    // without the chips.
    const others = mode && onSwitchMatch
        ? MATCH_MODES.filter((m) => m.value !== mode.value)
        : []

    return (
        <div className={cn(
            "rounded-xl px-3.5 py-3",
            "border-l-4 border-l-cyan-400 border border-cyan-400/45",
            "bg-cyan-500/[0.14] dark:bg-cyan-500/[0.10]",
        )}>
            <p className="text-[13px] font-display font-semibold leading-snug text-cyan-900 dark:text-cyan-100">
                {text && mode
                    ? <>Nothing in this view {mode.verb} “<span className="font-mono font-medium">{text.value}</span>”.</>
                    : <>Nothing in this view matched what you asked for.</>}
            </p>
            {others.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11.5px] text-cyan-900/85 dark:text-cyan-100/90">
                        Try
                    </span>
                    {others.map((m) => (
                        <button
                            key={m.value}
                            type="button"
                            onClick={() => onSwitchMatch?.(m.value)}
                            className={cn(
                                "inline-flex items-center px-2 h-6 rounded-full",
                                "text-[11px] font-medium",
                                "bg-canvas-base/40 text-ink",
                                "border border-glass-border hover:bg-canvas-base/70",
                                "transition-colors",
                            )}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}


/** First text leaf, depth-first — the word the user is looking for. */
function firstTextLeaf(p: Predicate): TextPredicate | null {
    if (p.kind === 'text') return p
    if (p.kind === 'group') {
        for (const child of p.children) {
            const found = firstTextLeaf(child)
            if (found) return found
        }
    }
    return null
}


/** Everything the engine can say about the miss, folded away. */
function TechnicalDetails({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="rounded-xl border border-glass-border/60 bg-glass/20 overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className={cn(
                    "w-full flex items-center gap-2 px-3.5 py-2.5",
                    "text-left text-[11.5px] font-medium",
                    "text-ink-muted hover:text-ink hover:bg-glass/30 transition-colors",
                )}
            >
                {open
                    ? <ChevronDown className="w-3 h-3 shrink-0" strokeWidth={2.5} />
                    : <ChevronRight className="w-3 h-3 shrink-0" strokeWidth={2.5} />
                }
                <span className="flex-1 text-ink">Technical details</span>
            </button>
            {open && (
                <div className="border-t border-glass-border/40 p-3 flex flex-col gap-2 bg-canvas-elevated/30">
                    {children}
                </div>
            )}
        </div>
    )
}


function CauseCard({ cause, highlighted }: { cause: Cause; highlighted: boolean }) {
    const Icon =
        cause.severity === 'error' ? AlertTriangle :
        cause.severity === 'warn' ? AlertTriangle :
        Info

    // High-contrast tones so warnings actually read on a translucent
    // background. The previous ``/[0.06]`` tints were near-invisible
    // in dark mode and users missed them entirely.
    const tone = highlighted
        ? cause.severity === 'error'
            ? 'border-l-4 border-l-red-400 border border-red-400/50 bg-red-500/[0.18] dark:bg-red-500/[0.14]'
            : cause.severity === 'warn'
            ? 'border-l-4 border-l-amber-400 border border-amber-400/50 bg-amber-500/[0.18] dark:bg-amber-500/[0.14]'
            : 'border-l-4 border-l-cyan-400 border border-cyan-400/45 bg-cyan-500/[0.14] dark:bg-cyan-500/[0.10]'
        : 'border-glass-border/60 bg-glass/20'

    const iconTone =
        cause.severity === 'error' ? 'text-red-600 dark:text-red-300' :
        cause.severity === 'warn' ? 'text-amber-700 dark:text-amber-200' :
        'text-cyan-700 dark:text-cyan-300'

    return (
        <div className={cn(
            "rounded-xl border px-3.5 py-3 transition-colors",
            tone,
        )}>
            <div className="flex items-start gap-2.5">
                <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", iconTone)} strokeWidth={2.4} />
                <div className="min-w-0 flex-1">
                    <div className={cn(
                        "text-[12.5px] font-display font-semibold leading-tight",
                        highlighted && cause.severity === 'error'
                            ? 'text-red-900 dark:text-red-100'
                            : highlighted && cause.severity === 'warn'
                            ? 'text-amber-900 dark:text-amber-100'
                            : highlighted && cause.severity === 'info'
                            ? 'text-cyan-900 dark:text-cyan-100'
                            : 'text-ink',
                    )}>
                        {cause.title}
                    </div>
                    <p className={cn(
                        "mt-1 text-[11.5px] leading-snug",
                        highlighted && cause.severity === 'error'
                            ? 'text-red-900/85 dark:text-red-100/90'
                            : highlighted && cause.severity === 'warn'
                            ? 'text-amber-900/85 dark:text-amber-100/90'
                            : highlighted && cause.severity === 'info'
                            ? 'text-cyan-900/85 dark:text-cyan-100/90'
                            : 'text-ink-muted',
                    )}>
                        {cause.body}
                    </p>
                    {cause.action && (
                        <div className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-medium text-accent-lineage">
                            <ArrowRight className="w-2.5 h-2.5" strokeWidth={2.5} />
                            {cause.action}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

function diagnose(result: SearchResultPage, query: SearchQuery): Cause[] {
    const diag: ScopeDiagnostics | null | undefined = result.scopeDiagnostics
    const causes: Cause[] = []

    const usesLineage = predicateUsesLineage(query.predicate)
    const usesContainment = predicateUsesContainment(query.predicate)

    // Cause 1 (highest priority): lineage predicate but no lineage edges
    // configured. This is the "always returns 0" silent killer.
    if (diag && diag.lineageEdgeTypes.length === 0 && usesLineage) {
        causes.push({
            severity: 'error',
            title: 'Your query uses a lineage predicate, but no edge types are flagged as lineage.',
            body: 'The active ontology for this data source has zero edge types marked '
                + 'is_lineage. Predicates like "disconnected nodes", "source nodes", '
                + '"has incoming edges", and "near a node" with edgeClass=lineage will '
                + 'match nothing.',
            action: 'Open the data source\'s ontology settings and mark at least one edge type as is_lineage.',
        })
    }

    // Cause 2: containment predicate but no containment edges configured.
    if (diag && diag.containmentEdgeTypes.length === 0 && usesContainment) {
        causes.push({
            severity: 'error',
            title: 'Your query references containment hierarchy, but no edge types are flagged as containment.',
            body: 'Without containment classification, ancestor aggregation and '
                + '"inside a subtree" predicates can\'t resolve. The graph is flat from '
                + 'the engine\'s perspective.',
            action: 'In the ontology, mark the containment edge type(s) — typically CONTAINS.',
        })
    }

    // Cause 3: client supplied URNs that were all dropped.
    if (diag && diag.droppedRootUrns.length > 0 && diag.effectiveRootUrns.length === 0) {
        causes.push({
            severity: 'warn',
            title: `All ${diag.droppedRootUrns.length} requested root URN(s) were out of view.`,
            body: 'The view\'s scope did not allow any of the URNs you supplied. The '
                + 'search short-circuited to keep the view boundary tight.',
            action: 'Open a parent view, supply different URNs, or extend this view\'s rootUrns.',
        })
    }

    // Cause 4: the query is scoped to a container. This is far and away
    // the most common reason a query that "should" match returns
    // nothing, because the scope arrives from a single click on a
    // result group and then applies to every query composed afterwards
    // — so it must be named before the vaguer content-level causes.
    const scope = findScopeCondition(query.predicate)
    if (scope && scope.urns.length > 0 && causes.length === 0) {
        const where = scope.urns.length === 1
            ? formatUrnLabel(scope.urns[0])
            : `${scope.urns.length} containers`
        causes.push({
            severity: 'warn',
            title: `Your query only looks inside ${where}.`,
            body: 'Matches elsewhere in the view are excluded. This filter is '
                + 'added when you search inside a result group, and it stays '
                + 'until you remove it.',
            action: `Delete the "inside ${where}" row from the query to search the whole view.`,
        })
    }

    // Cause 5: predicate matched zero candidates (content-level mismatch).
    if (result.candidateCount === 0 && causes.length === 0) {
        causes.push({
            severity: 'warn',
            title: 'No node matched your conditions before the scope check.',
            body: 'The predicate didn\'t find any candidates in the data source. Either '
                + 'the value is misspelled, the property isn\'t set on the entity type '
                + 'you expected, or your AND/NOT composition is too restrictive.',
            action: 'Expand "Technical details" to see the compiled Cypher.',
        })
    }

    // Cause 6 (informational): unclamped view scope.
    if (diag && diag.effectiveRootUrns.length === 0 && diag.droppedRootUrns.length === 0) {
        causes.push({
            severity: 'info',
            title: 'The search covered this whole view.',
            body: 'Nothing narrowed it to one part of the hierarchy, so an '
                + 'empty result is not a scope problem — the word really '
                + 'isn\'t here. To look inside one container instead, use '
                + 'the search box on its row, or search inside a result group.',
        })
    }

    // Server-provided notes always come along as info entries.
    if (diag && diag.notes.length > 0) {
        for (const note of diag.notes) {
            causes.push({
                severity: 'info',
                title: 'Server note',
                body: note,
            })
        }
    }

    return causes
}


// ---------------------------------------------------------------------------
// Resolved-scope summary — always-on under the cause cards
// ---------------------------------------------------------------------------

function ResolvedScopeCard({
    diag, candidateCount,
}: {
    diag: ScopeDiagnostics
    candidateCount: number
}) {
    const [open, setOpen] = useState(false)
    return (
        <div className="rounded-xl border border-glass-border/60 bg-glass/20 overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "w-full flex items-center gap-2 px-3.5 py-2.5",
                    "text-left text-[11.5px] font-medium",
                    "text-ink-muted hover:text-ink hover:bg-glass/30 transition-colors",
                )}
                aria-expanded={open}
            >
                {open
                    ? <ChevronDown className="w-3 h-3 shrink-0" strokeWidth={2.5} />
                    : <ChevronRight className="w-3 h-3 shrink-0" strokeWidth={2.5} />
                }
                <span className="flex-1 text-ink">
                    What the engine actually matched against
                </span>
            </button>

            {open && (
                <div className="border-t border-glass-border/40 px-3.5 py-3 flex flex-col gap-2 bg-canvas-elevated/30">
                    <ScopeRow label="Candidate count" value={String(candidateCount)} />
                    <ScopeRow
                        label="Scope root URNs"
                        value={
                            diag.effectiveRootUrns.length === 0
                                ? '(unclamped — whole data source)'
                                : diag.effectiveRootUrns.join(', ')
                        }
                        mono={diag.effectiveRootUrns.length > 0}
                    />
                    <ScopeRow
                        label="Max depth"
                        value={String(diag.effectiveMaxDepth)}
                    />
                    <ScopeRow
                        label="Entity-type allow-list"
                        value={
                            diag.effectiveEntityTypes && diag.effectiveEntityTypes.length > 0
                                ? diag.effectiveEntityTypes.join(', ')
                                : '(no view constraint)'
                        }
                        mono={!!diag.effectiveEntityTypes && diag.effectiveEntityTypes.length > 0}
                    />
                    <ScopeRow
                        label="Lineage edge types"
                        value={
                            diag.lineageEdgeTypes.length === 0
                                ? '(none configured)'
                                : diag.lineageEdgeTypes.join(', ')
                        }
                        mono={diag.lineageEdgeTypes.length > 0}
                        emphasize={diag.lineageEdgeTypes.length === 0}
                    />
                    <ScopeRow
                        label="Containment edge types"
                        value={
                            diag.containmentEdgeTypes.length === 0
                                ? '(none configured)'
                                : diag.containmentEdgeTypes.join(', ')
                        }
                        mono={diag.containmentEdgeTypes.length > 0}
                    />
                    {diag.droppedRootUrns.length > 0 && (
                        <ScopeRow
                            label="Dropped (out-of-view) URNs"
                            value={diag.droppedRootUrns.join(', ')}
                            mono
                            emphasize
                        />
                    )}
                </div>
            )}
        </div>
    )
}


function ScopeRow({
    label, value, mono, emphasize,
}: {
    label: string
    value: string
    mono?: boolean
    emphasize?: boolean
}) {
    return (
        <div className="grid grid-cols-[10rem_1fr] gap-3 items-baseline text-[11px]">
            <span className="text-ink-muted">{label}</span>
            <span
                className={cn(
                    "min-w-0 break-all",
                    mono && "font-mono",
                    emphasize ? "text-amber-300" : "text-ink",
                )}
            >
                {value}
            </span>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Inline discover probe — calls /search/discover on demand
// ---------------------------------------------------------------------------

function DiscoverProbe({ query: _query }: { query: SearchQuery }) {
    const provider = useGraphProvider()
    const [open, setOpen] = useState(false)
    const [state, setState] = useState<
        | { status: 'idle' }
        | { status: 'loading' }
        | { status: 'ok'; result: SearchDiscoverResult }
        | { status: 'error'; message: string }
    >({ status: 'idle' })

    const run = async () => {
        if (!(provider instanceof RemoteGraphProvider)) {
            setState({ status: 'error', message: 'Discover requires the remote backend.' })
            return
        }
        setState({ status: 'loading' })
        try {
            const result = await provider.discoverSearchableProperties()
            setState({ status: 'ok', result })
        } catch (e: unknown) {
            setState({
                status: 'error',
                message: e instanceof Error ? e.message : String(e),
            })
        }
    }

    return (
        <div className="rounded-xl border border-glass-border/60 bg-glass/20 overflow-hidden">
            <button
                type="button"
                onClick={() => {
                    setOpen((v) => !v)
                    if (!open && state.status === 'idle') void run()
                }}
                className={cn(
                    "w-full flex items-center gap-2 px-3.5 py-2.5",
                    "text-left text-[11.5px] font-medium",
                    "text-ink-muted hover:text-ink hover:bg-glass/30 transition-colors",
                )}
                aria-expanded={open}
            >
                {open
                    ? <ChevronDown className="w-3 h-3 shrink-0" strokeWidth={2.5} />
                    : <ChevronRight className="w-3 h-3 shrink-0" strokeWidth={2.5} />
                }
                <Database className="w-3 h-3 shrink-0" strokeWidth={2} />
                <span className="flex-1 text-ink">
                    Show what entity types & properties exist in the data
                </span>
                {state.status === 'loading' && (
                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                )}
            </button>

            {open && (
                <div className="border-t border-glass-border/40 px-3.5 py-3 bg-canvas-elevated/30">
                    {state.status === 'idle' && (
                        <div className="text-[11px] text-ink-muted">
                            Probing the data source…
                        </div>
                    )}
                    {state.status === 'loading' && (
                        <div className="text-[11px] text-ink-muted flex items-center gap-2">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Sampling each entity type for property keys…
                        </div>
                    )}
                    {state.status === 'error' && (
                        <div className="text-[11px] text-red-400 leading-snug">
                            {state.message}
                        </div>
                    )}
                    {state.status === 'ok' && (
                        <DiscoverTable result={state.result} />
                    )}
                </div>
            )}
        </div>
    )
}


function DiscoverTable({ result }: { result: SearchDiscoverResult }) {
    const entries = Object.entries(result.labels).sort(
        ([a], [b]) => a.localeCompare(b),
    )

    if (entries.length === 0) {
        return (
            <div className="text-[11px] text-amber-300 leading-snug">
                <strong>No entity types sampled.</strong> Either the data
                source is empty, or the provider isn't configured. Confirm
                via a direct query against the graph.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[10rem_4rem_1fr] gap-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted pb-1 border-b border-glass-border/40">
                <span>Entity type</span>
                <span className="text-right">Sampled</span>
                <span>Native property keys</span>
            </div>
            {entries.map(([label, info]) => (
                <div
                    key={label}
                    className="grid grid-cols-[10rem_4rem_1fr] gap-3 text-[11px] items-baseline"
                >
                    <span className="font-mono text-ink truncate">{label}</span>
                    <span className="text-right font-mono text-ink tabular-nums">
                        {info.sampled}
                    </span>
                    <span className="font-mono text-ink-muted text-[10.5px] break-all">
                        {info.keys.length > 0
                            ? info.keys.join(', ')
                            : '(no native keys yet)'
                        }
                    </span>
                </div>
            ))}
            {result.blobOnlyLabels.length > 0 && (
                <div className="mt-2 text-[10.5px] text-amber-300 leading-snug">
                    <strong>Blob-only labels:</strong>{' '}
                    {result.blobOnlyLabels.join(', ')} — these nodes still
                    have properties stored as a single JSON blob. Run{' '}
                    <code className="font-mono">
                        python -m backend.scripts.migrate_native_properties
                    </code>{' '}
                    to flatten them.
                </div>
            )}
            {result.missingContainment && (
                <div className="mt-1 text-[10.5px] text-amber-300 leading-snug">
                    <strong>No containment edges configured</strong> for this
                    data source.
                </div>
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Predicate inspection
// ---------------------------------------------------------------------------

function predicateUsesLineage(p: Predicate): boolean {
    if (p.kind === 'isOrphan' || p.kind === 'isLeaf' || p.kind === 'isRoot'
        || p.kind === 'hasIncoming' || p.kind === 'hasOutgoing') {
        return p.edgeClass === 'lineage' || p.edgeClass === 'any'
    }
    if (p.kind === 'degree') {
        return p.edgeClass === 'lineage' || p.edgeClass === 'any'
    }
    if (p.kind === 'withinHops') {
        // withinHops doesn't have explicit edgeClass; it uses edgeTypes
        // when specified, else implicitly any edge. Be conservative —
        // surface as "might use lineage" only when edgeTypes is unset.
        return !p.edgeTypes || p.edgeTypes.length === 0
    }
    if (p.kind === 'group') {
        return p.children.some(predicateUsesLineage)
    }
    return false
}


function predicateUsesContainment(p: Predicate): boolean {
    if (p.kind === 'descendantOf') return true
    if (p.kind === 'isOrphan' || p.kind === 'isLeaf' || p.kind === 'isRoot'
        || p.kind === 'hasIncoming' || p.kind === 'hasOutgoing'
        || p.kind === 'degree') {
        return p.edgeClass === 'containment' || p.edgeClass === 'any'
    }
    if (p.kind === 'group') {
        return p.children.some(predicateUsesContainment)
    }
    return false
}


