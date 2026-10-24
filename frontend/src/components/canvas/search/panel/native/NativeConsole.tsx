/**
 * NativeConsole — Edit and run: a person's own read-only Cypher, on the
 * data source behind the view, from the Cypher tab.
 *
 *   ┌─ Your own query · read-only · FalkorDB ────────────────────────┐
 *   │ MATCH (d:Dataset)-[:TRANSFORMS]->(t) RETURN d, t               │
 *   │ Rows [200]  Time [10 s]                      [Cancel] [▷ Run]  │
 *   │ table of results · Highlight on canvas · Clear                 │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * It starts from the search's own Cypher with its values written in, so
 * "change one thing and run it" is the first thing it offers. The server
 * decides everything that matters — who may, what may run, how much —
 * and says so in plain words, pointing at the place in the query it
 * means. A run is never retried, and Cancel (or leaving) stops it.
 */
import { AlertCircle, Highlighter, Loader2, Play, RotateCcw, Square, X } from 'lucide-react'
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { NativeQueryResponse } from '@/types/search'

import { CypherEditor } from '../../editor/CypherEditor'
import { errorOffset } from '../../editor/cypherLanguage'
import { requestFailure, type RequestFailure } from '../errorPaths'

import { isNativeResult, NATIVE_RESULT_PREFIX, urnsOf } from './nativeCells'
import { NativeQueryResults } from './NativeQueryResults'


export interface NativeConsoleProps {
    viewId: string
    /** The engine the server says this view's source runs on. */
    engine: 'falkordb' | 'neo4j'
    /** The search's Cypher with its values written in — where Edit and run
     *  starts. Null when there is none to start from. */
    seed: string | null
    /** Why it can't run here right now (a draft), if it can't. */
    unavailable?: string | null
}

/** Where Edit and run starts without a search to start from. */
export const STARTER_QUERY = 'MATCH (n) RETURN n LIMIT 25'
const ROW_CHOICES = [50, 200, 1000] as const
const TIME_CHOICES = [5_000, 10_000, 30_000] as const

type RunState =
    | { status: 'idle'; note?: string }
    | { status: 'running' }
    | { status: 'ok'; answer: NativeQueryResponse }
    | { status: 'error'; failure: RequestFailure; query: string }


export const NativeConsole: FC<NativeConsoleProps> = ({ viewId, engine, seed, unavailable }) => {
    const provider = useGraphProviderIfAvailable()
    const remote = provider instanceof RemoteGraphProvider ? provider : null
    const [open, setOpen] = useState(false)
    const [text, setText] = useState('')
    const [limit, setLimit] = useState<number>(200)
    const [timeoutMs, setTimeoutMs] = useState<number>(10_000)
    const [state, setState] = useState<RunState>({ status: 'idle' })
    const inFlight = useRef<AbortController | null>(null)
    const setResult = useSearchStore((s) => s.setResult)
    const clearSearchResults = useSearchStore((s) => s.clearSearchResults)
    const highlighted = useSearchStore((s) => isNativeResult(s.queryHash))

    // Leaving stops a run in flight; the server cancels it on the engine.
    useEffect(() => () => inFlight.current?.abort(), [])

    const start = useCallback(() => {
        setText(seed ?? STARTER_QUERY)
        setOpen(true)
    }, [seed])

    const run = useCallback(async () => {
        if (!remote || !text.trim()) return
        inFlight.current?.abort()
        const controller = new AbortController()
        inFlight.current = controller
        const query = text
        setState({ status: 'running' })
        try {
            const answer = await remote.runNativeQuery({ query, limit, timeoutMs }, { signal: controller.signal })
            if (!controller.signal.aborted) setState({ status: 'ok', answer })
        } catch (e) {
            if (controller.signal.aborted) return
            setState({ status: 'error', failure: requestFailure(e instanceof Error ? e.message : String(e)), query })
        }
    }, [remote, text, limit, timeoutMs])

    const cancel = useCallback(() => {
        inFlight.current?.abort()
        setState({ status: 'idle', note: 'Cancelled.' })
    }, [])

    const answer = state.status === 'ok' ? state.answer : null
    const urns = useMemo(() => (answer ? urnsOf(answer.columns, answer.rows) : []), [answer])
    const highlight = useCallback(() => {
        if (!answer || urns.length === 0) return
        setResult({ viewId, matchUrns: urns, queryHash: NATIVE_RESULT_PREFIX + answer.queryHash })
    }, [answer, urns, setResult, viewId])

    // The error points into the text it was about — not into one edited since.
    const underline = useMemo(() => {
        if (state.status !== 'error' || state.query !== text) return null
        const at = state.failure.position ?? errorOffset(state.failure.message, text)
        return at === null ? null : { from: at, to: at + 1, message: state.failure.message }
    }, [state, text])

    if (!open) {
        return (
            <div className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl',
                'border border-glass-border/60 bg-canvas-base/30',
            )}>
                <div className="flex-1 min-w-0 text-[11.5px] text-ink-muted leading-snug">
                    <span className="font-semibold text-ink">Your own query.</span>{' '}
                    Change this Cypher, or write your own, and run it read-only on the whole data source.
                </div>
                <button
                    type="button"
                    onClick={start}
                    disabled={Boolean(unavailable)}
                    title={unavailable ?? 'Edit this query and run it'}
                    className={cn(
                        'shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg',
                        'text-[11.5px] font-semibold transition-colors',
                        'bg-accent-lineage/15 text-accent-lineage hover:bg-accent-lineage/25',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                >
                    <Play className="w-3.5 h-3.5" /> Edit and run
                </button>
            </div>
        )
    }

    const running = state.status === 'running'
    return (
        <section aria-label="Your own query" className="rounded-xl border border-glass-border/60 bg-canvas-base/40 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-glass-border/40">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    Your own query
                </span>
                <span className="text-[10.5px] text-ink-muted/80">
                    · read-only · {engine === 'neo4j' ? 'Neo4j' : 'FalkorDB'}
                </span>
                <div className="ml-auto flex items-center gap-1">
                    {seed && seed !== text && (
                        <button
                            type="button"
                            onClick={() => setText(seed)}
                            title="Start again from the search's Cypher"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] text-ink-muted hover:text-ink hover:bg-glass/50"
                        >
                            <RotateCcw className="w-3 h-3" /> From the search
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => { cancel(); setOpen(false) }}
                        aria-label="Close your own query"
                        className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-glass/50"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            <div className="px-3 py-2.5 flex flex-col gap-2.5">
                <CypherEditor
                    value={text}
                    onChange={setText}
                    onRun={() => void run()}
                    error={underline}
                    ariaLabel="Your Cypher"
                    placeholder={STARTER_QUERY}
                    className="max-h-56 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border/50"
                />
                <div className="flex flex-wrap items-center gap-2">
                    <Choice label="Rows" value={limit} onChange={setLimit}
                            options={ROW_CHOICES.map((n) => [n, n.toLocaleString()])} disabled={running} />
                    <Choice label="Time" value={timeoutMs} onChange={setTimeoutMs}
                            options={TIME_CHOICES.map((ms) => [ms, `${ms / 1000} s`])} disabled={running} />
                    <div className="ml-auto flex items-center gap-1.5">
                        {running && (
                            <button
                                type="button"
                                onClick={cancel}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium text-ink-muted hover:text-ink hover:bg-glass/50"
                            >
                                <Square className="w-3 h-3" /> Cancel
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => void run()}
                            disabled={running || !text.trim() || !remote}
                            title="Run (⌘↵)"
                            className={cn(
                                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-semibold',
                                'bg-accent-lineage text-white hover:bg-accent-lineage/90 transition-colors',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                            Run
                        </button>
                    </div>
                </div>
                <p className="text-[10.5px] text-ink-muted leading-snug">
                    Reads the whole data source, not only this view. Writes are refused, and every run
                    is recorded in the activity log.
                </p>

                <div aria-live="polite" className="flex flex-col gap-2">
                    {state.status === 'idle' && state.note && (
                        <p className="text-[11.5px] text-ink-muted">{state.note}</p>
                    )}
                    {state.status === 'error' && <Failure failure={state.failure} />}
                    {answer && (
                        <>
                            {answer.notes.length > 0 && (
                                <ul className="flex flex-col gap-0.5 text-[10.5px] text-ink-muted">
                                    {answer.notes.map((note, i) => <li key={i}>{note}</li>)}
                                </ul>
                            )}
                            <NativeQueryResults answer={answer} />
                            <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={highlight}
                                    disabled={urns.length === 0}
                                    title={urns.length === 0 ? 'The answer names no entities' : undefined}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium',
                                        'bg-glass/40 text-ink hover:bg-glass/60 disabled:opacity-50 disabled:cursor-not-allowed',
                                    )}
                                >
                                    <Highlighter className="w-3 h-3" />
                                    Highlight on canvas{urns.length > 0 ? ` (${urns.length.toLocaleString()})` : ''}
                                </button>
                                {highlighted && (
                                    <button
                                        type="button"
                                        onClick={clearSearchResults}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] text-ink-muted hover:text-ink hover:bg-glass/50"
                                    >
                                        <X className="w-3 h-3" /> Clear highlight
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </section>
    )
}


function Failure({ failure }: { failure: RequestFailure }) {
    return (
        <div role="alert" className={cn(
            'flex items-start gap-2 px-3 py-2 rounded-lg',
            'border border-rose-500/40 bg-rose-500/10 text-[11.5px] text-rose-700 dark:text-rose-300',
        )}>
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5 min-w-0">
                <span className="break-words">{failure.message}</span>
                {failure.requestId && (failure.status === null || failure.status >= 500) && (
                    <span className="text-[10.5px] opacity-80 font-mono">Request {failure.requestId}</span>
                )}
            </div>
        </div>
    )
}


function Choice({ label, value, onChange, options, disabled }: {
    label: string
    value: number
    onChange: (next: number) => void
    options: [number, string][]
    disabled?: boolean
}) {
    return (
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
            {label}
            <select
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(Number(e.target.value))}
                className="px-1.5 py-1 rounded-md bg-glass/40 border border-glass-border/60 text-ink text-[11px]"
            >
                {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
            </select>
        </label>
    )
}
