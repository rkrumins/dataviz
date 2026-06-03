/**
 * Single status bar that lives just above the Run button. Replaces
 * the previous trio (CandidateCountHint + ShowExecutedQuery + QuerySummary
 * card) so the user sees ONE place that answers "is my query ready, and
 * what will it actually run?".
 *
 * States:
 *   - notReady → "Fill in the highlighted fields" (yellow). No /explain
 *     call fires — the request would 422 against the backend's
 *     min_length validators (empty property key, empty tag values).
 *   - running  → "Compiling…" spinner
 *   - ready    → "Ready to run" green chip + "Show technical details" toggle
 *   - error    → red message inline
 *
 * The "Show technical details" toggle expands a panel showing the
 * compiled Cypher + bound parameters + diagnostic notes. Debounced
 * 400ms; aborts in-flight calls on tree change. Power-user surface,
 * collapsed by default.
 */
import {
    AlertCircle,
    ChevronDown,
    ChevronRight,
    CircleCheck,
    Copy,
    Loader2,
    Terminal,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { Predicate, SearchExplainResult, SearchQuery } from '@/types/search'


const DEBOUNCE_MS = 400


interface ExplainState {
    status: 'idle' | 'running' | 'ok' | 'error'
    result?: SearchExplainResult
    error?: string
}


export interface QueryStatusBarProps {
    predicate: Predicate
    viewId: string
    /** True when the predicate tree has no validation warnings —
     *  i.e. every leaf has its required fields filled. When false the
     *  bar shows a yellow "fill the highlighted fields" prompt and
     *  skips the /search/explain call entirely. */
    ready: boolean
}


export function QueryStatusBar({ predicate, viewId, ready }: QueryStatusBarProps) {
    const provider = useGraphProvider()
    const [open, setOpen] = useState(false)
    const [state, setState] = useState<ExplainState>({ status: 'idle' })
    const abortRef = useRef<AbortController | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        // Only call /explain when the tree is well-formed. Calling
        // with incomplete leaves causes a backend 422 (min_length
        // violations on empty keys / value lists).
        if (!ready) {
            abortRef.current?.abort()
            setState({ status: 'idle' })
            return
        }
        if (!(provider instanceof RemoteGraphProvider) || !viewId) {
            setState({ status: 'idle' })
            return
        }
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
            abortRef.current?.abort()
            const controller = new AbortController()
            abortRef.current = controller
            setState({ status: 'running' })
            const query: SearchQuery = { predicate, scope: { viewId } }
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
    }, [ready, provider, predicate, viewId])

    return (
        <div className={cn(
            "rounded-xl border overflow-hidden transition-colors",
            !ready
                ? "border-amber-500/30 bg-amber-500/[0.04]"
                : state.status === 'error'
                ? "border-red-500/30 bg-red-500/[0.04]"
                : "border-glass-border/60 bg-glass/20",
        )}>
            {/* Status row */}
            <div className="flex items-center gap-2 px-3 py-2">
                {!ready && (
                    <>
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-400" strokeWidth={2.2} />
                        <span className="text-[11.5px] text-amber-300 leading-snug">
                            Fill in the highlighted fields above to continue.
                        </span>
                    </>
                )}

                {ready && state.status === 'idle' && (
                    <>
                        <Loader2 className="w-3.5 h-3.5 shrink-0 text-ink-muted" strokeWidth={2.2} />
                        <span className="text-[11.5px] text-ink-muted">Preparing…</span>
                    </>
                )}

                {ready && state.status === 'running' && (
                    <>
                        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-ink-muted" strokeWidth={2.2} />
                        <span className="text-[11.5px] text-ink-muted">Compiling query…</span>
                    </>
                )}

                {ready && state.status === 'ok' && (
                    <>
                        <CircleCheck className="w-3.5 h-3.5 shrink-0 text-emerald-400" strokeWidth={2.2} />
                        <span className="text-[11.5px] text-emerald-300 font-medium">
                            Ready to run
                        </span>
                        {state.result?.notes && state.result.notes.length > 0 && (
                            <span className="text-[10.5px] text-ink-muted">
                                · {state.result.notes.length} note{state.result.notes.length === 1 ? '' : 's'}
                            </span>
                        )}
                    </>
                )}

                {ready && state.status === 'error' && (
                    <>
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" strokeWidth={2.2} />
                        <span className="text-[11.5px] text-red-300 leading-snug truncate flex-1 min-w-0" title={state.error}>
                            {state.error ?? 'Query compilation failed.'}
                        </span>
                    </>
                )}

                {/* Push "Show details" to the right */}
                <span className="flex-1" />

                {ready && (state.status === 'ok' || state.status === 'error') && (
                    <button
                        type="button"
                        onClick={() => setOpen((v) => !v)}
                        className={cn(
                            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded",
                            "text-[10.5px] font-medium",
                            "text-ink-muted hover:text-ink hover:bg-glass/40 transition-colors",
                        )}
                        aria-expanded={open}
                    >
                        <Terminal className="w-3 h-3" strokeWidth={2.2} />
                        Technical details
                        {open
                            ? <ChevronDown className="w-3 h-3" strokeWidth={2.2} />
                            : <ChevronRight className="w-3 h-3" strokeWidth={2.2} />
                        }
                    </button>
                )}
            </div>

            {/* Expanded technical details */}
            {open && ready && state.status === 'ok' && state.result && (
                <div className="border-t border-glass-border/40 px-3 py-3 flex flex-col gap-2.5 bg-canvas-elevated/30">
                    <CypherBlock
                        label="Compiled Cypher (what runs against the database)"
                        code={state.result.hits_cypher || state.result.cypher}
                    />

                    {Object.keys(state.result.params ?? {}).length > 0 && (
                        <ParamsTable params={state.result.params ?? {}} />
                    )}

                    {state.result.notes && state.result.notes.length > 0 && (
                        <NotesBlock notes={state.result.notes} />
                    )}
                </div>
            )}
        </div>
    )
}


// ---------------------------------------------------------------------------
// Detail sub-components
// ---------------------------------------------------------------------------

function CypherBlock({ label, code }: { label: string; code: string }) {
    const [copied, setCopied] = useState(false)
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
        } catch { /* clipboard unavailable */ }
    }
    return (
        <div className="rounded-md bg-canvas-elevated/70 border border-glass-border/60 overflow-hidden">
            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-glass-border/40">
                <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    {label}
                </span>
                <button
                    type="button"
                    onClick={copy}
                    className={cn(
                        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded",
                        "text-[10px] font-medium",
                        "text-ink-muted hover:text-ink hover:bg-glass/40 transition-colors",
                    )}
                >
                    <Copy className="w-2.5 h-2.5" strokeWidth={2.5} />
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>
            <pre className="px-2.5 py-2 text-[11px] text-ink font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">
                {code}
            </pre>
        </div>
    )
}


function ParamsTable({ params }: { params: Record<string, unknown> }) {
    return (
        <div className="rounded-md bg-glass/20 px-2.5 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-muted mb-1.5">
                Bound parameters
            </div>
            <div className="space-y-1 font-mono text-[11px]">
                {Object.entries(params).map(([k, v]) => (
                    <div key={k} className="flex gap-2 items-baseline">
                        <span className="text-accent-lineage">${k}</span>
                        <span className="text-ink-muted">=</span>
                        <span className="text-ink truncate">{formatValue(v)}</span>
                    </div>
                ))}
            </div>
        </div>
    )
}


function NotesBlock({ notes }: { notes: string[] }) {
    return (
        <div className="rounded-md bg-glass/20 px-2.5 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-muted mb-1">
                Notes
            </div>
            <ul className="text-[11px] text-ink-muted leading-snug list-disc ml-4 space-y-0.5">
                {notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
        </div>
    )
}


function formatValue(v: unknown): string {
    if (v === null) return 'null'
    if (v === undefined) return 'undefined'
    if (typeof v === 'string') return JSON.stringify(v)
    if (Array.isArray(v)) return JSON.stringify(v)
    return String(v)
}
