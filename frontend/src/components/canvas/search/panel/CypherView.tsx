/**
 * CypherView — flat, always-visible compiled-Cypher inspector for the
 * Advanced drawer's Cypher tab.
 *
 * Replaces the nested ``CypherDisclosure → QueryStatusBar → Technical
 * details`` toggle chain. The user clicked the `Cypher` button on the
 * results header to see the query that ran against FalkorDB — show
 * them the query immediately, not three more clicks deep.
 *
 *   ┌─ Compiled Cypher · 482 chars ────────────  [ Copy ] ─┐
 *   │ MATCH (n) WHERE                                       │
 *   │   labels(n)[0] IN $_scopeEntityTypes                  │
 *   │   AND (toLower(toString(n.displayName)) CONTAINS $p0) │
 *   │ WITH n LIMIT 5000 RETURN n                            │
 *   └───────────────────────────────────────────────────────┘
 *
 *   ┌─ Bound parameters · 3 ───────────────────────────────┐
 *   │ $p0                  "product"                        │
 *   │ $_scopeEntityTypes   ["dataset", "schemaField"]       │
 *   │ $_rootUrns           []                               │
 *   └───────────────────────────────────────────────────────┘
 *
 *   ┌─ Diagnostic notes · 1 ───────────────────────────────┐
 *   │ ⚠ view scope.entity_types had zero overlap with…      │
 *   └───────────────────────────────────────────────────────┘
 *
 * No toggles, no disclosure. Refetches /search/explain when the draft
 * predicate changes (debounced 400 ms) so the user sees the live
 * compiled query as they edit conditions.
 */
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, Info, Loader2 } from 'lucide-react'
import { type FC, useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useDraftPredicate } from '@/store/searchStore'
import type { SearchExplainResult, SearchQuery } from '@/types/search'


const DEBOUNCE_MS = 400


export interface CypherViewProps {
    viewId: string
}


type ExplainState =
    | { status: 'idle' }
    | { status: 'empty' }   // no draft predicate
    | { status: 'running' }
    | { status: 'ok'; result: SearchExplainResult }
    | { status: 'error'; error: string }


export const CypherView: FC<CypherViewProps> = ({ viewId }) => {
    const predicate = useDraftPredicate()
    const provider = useGraphProvider()
    const [state, setState] = useState<ExplainState>({ status: 'idle' })
    const abortRef = useRef<AbortController | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        if (!predicate) { setState({ status: 'empty' }); return }
        if (!(provider instanceof RemoteGraphProvider) || !viewId) {
            setState({ status: 'idle' }); return
        }
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
            abortRef.current?.abort()
            const controller = new AbortController()
            abortRef.current = controller
            setState({ status: 'running' })
            // Pass options matching what the runtime search uses
            // (results='hits'). Without this, the explain endpoint
            // defaults to results='aggregates' and emits a spurious
            // "results='aggregates' but no aggregations supplied" note
            // even though the actual search is fetching hits.
            const query: SearchQuery = {
                predicate,
                scope: { viewId },
                options: {
                    results: 'hits',
                    pageSize: 100,
                    includeAncestorPath: true,
                },
            }
            provider.searchExplain(query)
                .then((result) => {
                    if (controller.signal.aborted) return
                    setState({ status: 'ok', result })
                })
                .catch((e: unknown) => {
                    if (controller.signal.aborted) return
                    setState({
                        status: 'error',
                        error: e instanceof Error ? e.message : String(e),
                    })
                })
        }, DEBOUNCE_MS)
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current)
        }
    }, [predicate, provider, viewId])

    if (state.status === 'empty') {
        return (
            <EmptyState message="Add at least one condition in the Query card to see the compiled Cypher." />
        )
    }
    if (state.status === 'idle' || state.status === 'running') {
        return (
            <div className={cn(
                'flex items-center gap-2 px-3 py-3 rounded-xl',
                'border border-glass-border/50 bg-canvas-base/30',
                'text-[12px] text-ink-muted',
            )}>
                <Loader2 className="w-4 h-4 animate-spin text-accent-lineage" />
                Compiling query against FalkorDB…
            </div>
        )
    }
    if (state.status === 'error') {
        return (
            <div className={cn(
                'flex items-start gap-2 px-3 py-3 rounded-xl',
                'border border-rose-500/40 bg-rose-500/10',
                'text-[12px] text-rose-300',
            )}>
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <div className="flex flex-col gap-0.5">
                    <span className="font-semibold">Compilation failed</span>
                    <span className="opacity-90">{state.error}</span>
                </div>
            </div>
        )
    }

    const { result } = state
    const cypher = result.hits_cypher || result.cypher
    const params = result.params ?? {}
    const notes = result.notes ?? []
    const paramCount = Object.keys(params).length
    const candidateCap = result.candidate_cap

    return (
        <div className="flex flex-col gap-3">
            <SuccessRibbon noteCount={notes.length} />
            <CypherBlock cypher={cypher} />
            {typeof candidateCap === 'number' && (
                <CandidateCapHint cap={candidateCap} />
            )}
            {paramCount > 0 && <ParamsBlock params={params} />}
            {notes.length > 0 && <NotesBlock notes={notes} />}
        </div>
    )
}


function CandidateCapHint({ cap }: { cap: number }) {
    return (
        <div className={cn(
            'flex items-start gap-2 px-3 py-2 rounded-lg',
            'border border-glass-border/50 bg-canvas-base/30',
            'text-[10.5px] text-ink-muted leading-snug',
        )}>
            <Info className="w-3 h-3 mt-0.5 shrink-0 text-accent-lineage/70" />
            <span>
                The trailing{' '}
                <span className="font-mono text-ink">
                    WITH n LIMIT {cap.toLocaleString()}
                </span>
                {' '}is the <span className="text-ink">candidate cap</span> —
                a hard ceiling on how many nodes FalkorDB evaluates before
                materialising results. If a search hits the cap, the panel
                shows a "Truncated" banner; refine your filters to narrow
                the candidate set so every match is returned and highlighted
                on the canvas.
            </span>
        </div>
    )
}


// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SuccessRibbon({ noteCount }: { noteCount: number }) {
    return (
        <div className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg',
            'border border-emerald-500/30 bg-emerald-500/[0.06]',
            'text-[11.5px] text-emerald-300 font-medium',
        )}>
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            Compiled successfully — this is the exact query FalkorDB will run.
            {noteCount > 0 && (
                <span className="ml-auto text-[10.5px] text-amber-300/90 inline-flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {noteCount} note{noteCount === 1 ? '' : 's'} below
                </span>
            )}
        </div>
    )
}


function CypherBlock({ cypher }: { cypher: string }) {
    return (
        <Block
            title="Compiled Cypher"
            subtitle={`${cypher.length.toLocaleString()} chars`}
            copy={cypher}
        >
            <pre className={cn(
                'text-[11.5px] font-mono text-ink leading-relaxed',
                'whitespace-pre-wrap break-words',
                'max-h-72 overflow-y-auto custom-scrollbar',
            )}>
                {prettyPrintCypher(cypher)}
            </pre>
        </Block>
    )
}


function ParamsBlock({ params }: { params: Record<string, unknown> }) {
    return (
        <Block
            title="Bound parameters"
            subtitle={`${Object.keys(params).length}`}
            copy={JSON.stringify(params, null, 2)}
        >
            <div className="flex flex-col gap-1">
                {Object.entries(params).map(([k, v]) => (
                    <div
                        key={k}
                        className={cn(
                            'flex items-start gap-3 py-1 text-[11.5px] font-mono leading-tight',
                            'border-b border-glass-border/20 last:border-b-0',
                        )}
                    >
                        <span className="text-accent-lineage shrink-0">${k}</span>
                        <span className="flex-1 min-w-0 text-ink/90 break-all">
                            {formatValue(v)}
                        </span>
                    </div>
                ))}
            </div>
        </Block>
    )
}


function NotesBlock({ notes }: { notes: string[] }) {
    return (
        <Block
            title="Diagnostic notes"
            subtitle={`${notes.length}`}
            copy={notes.join('\n\n')}
            tone="amber"
        >
            <ul className="flex flex-col gap-2">
                {notes.map((n, i) => (
                    <li
                        key={i}
                        className={cn(
                            'flex items-start gap-2 text-[11.5px] leading-snug',
                            'text-amber-200/95',
                        )}
                    >
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-400" />
                        <span>{n}</span>
                    </li>
                ))}
            </ul>
        </Block>
    )
}


// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function Block({
    title, subtitle, copy, tone = 'default', children,
}: {
    title: string
    subtitle?: string
    copy: string
    tone?: 'default' | 'amber'
    children: React.ReactNode
}) {
    const [copied, setCopied] = useState(false)
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(copy)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
        } catch {
            // Clipboard API may be unavailable; silently no-op.
        }
    }, [copy])

    return (
        <div className={cn(
            'rounded-xl border overflow-hidden',
            tone === 'amber'
                ? 'border-amber-500/30 bg-amber-500/[0.04]'
                : 'border-glass-border/60 bg-canvas-base/40',
        )}>
            <div className={cn(
                'flex items-center justify-between gap-2 px-3 py-2',
                'border-b border-glass-border/40',
            )}>
                <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                        {title}
                    </span>
                    {subtitle && (
                        <span className="text-[10.5px] text-ink-muted/70 tabular-nums">
                            · {subtitle}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={handleCopy}
                    title={copied ? 'Copied' : `Copy ${title.toLowerCase()}`}
                    className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md shrink-0',
                        'text-[10.5px] font-medium',
                        copied
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-glass/40 text-ink-muted hover:text-ink hover:bg-glass/60',
                        'transition-colors',
                    )}
                >
                    <Copy className="w-3 h-3" />
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>
            <div className="px-3 py-2.5">
                {children}
            </div>
        </div>
    )
}


function EmptyState({ message }: { message: string }) {
    return (
        <div className={cn(
            'flex items-start gap-2 px-3 py-4 rounded-xl',
            'border border-dashed border-glass-border/60 bg-canvas-base/20',
            'text-[12px] text-ink-muted leading-relaxed',
        )}>
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-accent-lineage/70" />
            {message}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Light-touch Cypher prettifier: keep the original string but insert
 * newlines after the major keywords so the user can read the
 * statement at a glance. Doesn't reformat semantics.
 */
function prettyPrintCypher(cypher: string): string {
    return cypher
        .replace(/\s+(WHERE|WITH|RETURN|MATCH|ORDER BY|LIMIT|UNWIND|OPTIONAL MATCH|UNION)\b/g, '\n$1')
        .replace(/\s+(AND|OR)\s+/g, '\n  $1 ')
        .trim()
}


function formatValue(v: unknown): string {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') return JSON.stringify(v)
    if (Array.isArray(v)) {
        const s = JSON.stringify(v)
        return s.length > 60 ? s.slice(0, 60) + '… (' + v.length + ')' : s
    }
    return JSON.stringify(v)
}
