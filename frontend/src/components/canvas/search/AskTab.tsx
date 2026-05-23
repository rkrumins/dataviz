/**
 * AskTab — natural-language query surface inside SearchMapPanel.
 *
 * The user types a plain-English question; the backend translates it
 * into a `SearchQuery` (server-side LLM call so the API key never
 * touches the browser), validates it, runs it through the same
 * pipeline as every other search, and returns both the interpreted
 * query and the result page.
 *
 * Multi-turn refinement is supported via the `conversationId` the
 * backend returns — pass it back on subsequent calls and the model
 * gets the prior turn's interpretation as context ("now filter that
 * to logicalType STRING" works).
 *
 * Results render via the same `AggregateBucketCard` / `SearchHitRow`
 * components every other surface uses — one UI for one data shape.
 */
import { ChevronDown, ChevronRight, Loader2, MessageSquareText, Send, Sparkles } from 'lucide-react'
import { type FC, useCallback, useState } from 'react'

import { cn } from '@/lib/utils'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type {
    AncestorRef,
    NLSearchResponse,
    SearchAggregateBucket,
    SearchHit,
} from '@/types/search'

import { AggregateBucketCard } from './AggregateBucketCard'
import { SearchHitRow } from './SearchHitRow'


export interface AskTabProps {
    viewId: string
    onRevealNode?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpenNode?: (urn: string) => void
}


interface ChatTurn {
    id: string
    question: string
    response?: NLSearchResponse
    error?: string
}


export const AskTab: FC<AskTabProps> = ({ viewId, onRevealNode, onOpenNode }) => {
    const [draft, setDraft] = useState('')
    const [busy, setBusy] = useState(false)
    const [turns, setTurns] = useState<ChatTurn[]>([])
    const [conversationId, setConversationId] = useState<string | undefined>(undefined)

    const provider = useGraphProvider() as RemoteGraphProvider

    const ask = useCallback(async () => {
        const q = draft.trim()
        if (!q || busy) return
        const id = `t-${Date.now()}`
        setTurns((prev) => [...prev, { id, question: q }])
        setDraft('')
        setBusy(true)
        try {
            const res = await provider.searchNL({
                question: q,
                viewId,
                conversationId,
            })
            setConversationId(res.conversationId)
            setTurns((prev) => prev.map(
                (t) => (t.id === id ? { ...t, response: res } : t),
            ))
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            setTurns((prev) => prev.map(
                (t) => (t.id === id ? { ...t, error: msg } : t),
            ))
        } finally {
            setBusy(false)
        }
    }, [draft, busy, viewId, conversationId, provider])

    return (
        <div className="flex flex-col h-full gap-3">
            {/* Onboarding card shown until the first question lands */}
            {turns.length === 0 && (
                <div className="rounded-md border border-glass-border/60 bg-canvas-base/60 p-3 text-2xs leading-relaxed">
                    <div className="flex items-center gap-2 mb-1.5">
                        <Sparkles size={13} className="text-accent" />
                        <span className="font-medium text-ink">Ask in plain English</span>
                    </div>
                    <p className="text-ink-muted">
                        Try: <em>&quot;Show PII columns in this view&quot;</em>,{' '}
                        <em>&quot;Which datasets have no upstream lineage?&quot;</em>, or{' '}
                        <em>&quot;Paths from dataset:orders to dataset:reporting with confidence above 0.9&quot;</em>.
                    </p>
                    <p className="text-ink-muted mt-1.5">
                        Every answer is scoped to <span className="font-medium">this view</span>.
                        You&apos;ll see the interpreted query before the results.
                    </p>
                </div>
            )}

            {/* Transcript */}
            <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-3">
                {turns.map((turn) => (
                    <ChatTurnView
                        key={turn.id}
                        turn={turn}
                        onRevealNode={onRevealNode}
                        onOpenNode={onOpenNode}
                    />
                ))}
                {busy && (
                    <div className="flex items-center gap-2 text-2xs text-ink-muted">
                        <Loader2 size={13} className="animate-spin" />
                        Interpreting your question…
                    </div>
                )}
            </div>

            {/* Composer */}
            <div className="flex items-end gap-2">
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault()
                            void ask()
                        }
                    }}
                    placeholder="Ask a question about this view… (⌘↵ to send)"
                    rows={2}
                    className={cn(
                        'flex-1 px-3 py-2 rounded-md resize-none',
                        'bg-canvas-base/80 border border-glass-border',
                        'text-2xs text-ink placeholder:text-ink-muted',
                        'focus:outline-none focus:border-accent',
                    )}
                />
                <button
                    type="button"
                    onClick={ask}
                    disabled={busy || !draft.trim()}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-3 h-9 rounded-md',
                        'bg-accent text-accent-foreground text-2xs font-medium',
                        'hover:bg-accent-strong transition-colors',
                        (busy || !draft.trim()) && 'opacity-50 cursor-not-allowed',
                    )}
                >
                    <Send size={12} />
                    Ask
                </button>
            </div>
        </div>
    )
}


function ChatTurnView({
    turn, onRevealNode, onOpenNode,
}: {
    turn: ChatTurn
    onRevealNode?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpenNode?: (urn: string) => void
}) {
    const [showQuery, setShowQuery] = useState(false)
    return (
        <div className="flex flex-col gap-2">
            {/* User question */}
            <div className="flex items-start gap-2">
                <div className="mt-0.5 w-5 h-5 shrink-0 rounded-full bg-glass/60 flex items-center justify-center">
                    <MessageSquareText size={11} className="text-ink-secondary" />
                </div>
                <div className="text-2xs text-ink leading-relaxed">{turn.question}</div>
            </div>

            {/* Assistant answer */}
            <div className="ml-7">
                {turn.error && (
                    <div className="text-2xs text-rose-300 px-2 py-1.5 rounded-md bg-rose-500/10 border border-rose-500/30">
                        {turn.error}
                    </div>
                )}
                {turn.response && (
                    <div className="flex flex-col gap-2">
                        {/* Interpretation note */}
                        {turn.response.interpretationNotes && (
                            <div className="text-2xs text-ink-muted italic">
                                {turn.response.interpretationNotes}
                            </div>
                        )}

                        {/* Show interpreted query (collapsed by default) */}
                        <button
                            type="button"
                            onClick={() => setShowQuery((v) => !v)}
                            className="self-start inline-flex items-center gap-1 text-2xs text-ink-muted hover:text-ink"
                        >
                            {showQuery ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            {showQuery
                                ? 'Hide interpreted query'
                                : `Interpreted as ${describeShape(turn.response)}`}
                        </button>
                        {showQuery && (
                            <pre className="text-2xs font-mono leading-relaxed bg-canvas-base/80 p-2 rounded max-h-48 overflow-y-auto whitespace-pre-wrap">
                                {JSON.stringify(turn.response.interpretedQuery, null, 2)}
                            </pre>
                        )}

                        {/* Results — buckets first (Map), then hits */}
                        <ResultsBlock
                            response={turn.response}
                            onRevealNode={onRevealNode}
                            onOpenNode={onOpenNode}
                        />
                    </div>
                )}
            </div>
        </div>
    )
}


function describeShape(res: NLSearchResponse): string {
    const r = res.results
    const buckets = r.aggregates?.[0]?.length ?? 0
    const hits = r.hits?.length ?? 0
    const paths = r.paths?.length ?? 0
    if (paths > 0) return `${paths} path${paths === 1 ? '' : 's'}`
    if (buckets > 0 && hits > 0) return `${buckets} buckets · ${hits} hits`
    if (buckets > 0) return `${buckets} buckets`
    if (hits > 0) return `${hits} hit${hits === 1 ? '' : 's'}`
    return 'no results'
}


function ResultsBlock({
    response, onRevealNode, onOpenNode,
}: {
    response: NLSearchResponse
    onRevealNode?: (urn: string, ancestorPath: AncestorRef[]) => void
    onOpenNode?: (urn: string) => void
}) {
    const buckets: SearchAggregateBucket[] = response.results.aggregates?.[0] ?? []
    const hits: SearchHit[] = response.results.hits ?? []
    const totalHits = hits.length

    if (buckets.length === 0 && hits.length === 0) {
        return (
            <div className="text-2xs text-ink-muted px-2 py-1.5 rounded-md bg-glass/30">
                No matches in this view.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2">
            {buckets.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    {buckets.slice(0, 8).map((b, i) => (
                        <AggregateBucketCard
                            key={b.ancestorUrn || `${b.ancestorEntityType}:${b.ancestorDisplayName}`}
                            bucket={b}
                            grandTotal={response.results.candidateCount || totalHits || 1}
                            index={i}
                            onDrill={() => { /* Drill inside Ask transcript: TODO — for now buckets are read-only here. */ }}
                        />
                    ))}
                </div>
            )}
            {hits.length > 0 && (
                <div className="flex flex-col gap-1">
                    {hits.slice(0, 8).map((h, i) => (
                        <SearchHitRow
                            key={h.node.urn ?? `hit-${i}`}
                            hit={h}
                            index={i}
                            onReveal={onRevealNode}
                            onOpen={onOpenNode}
                        />
                    ))}
                    {hits.length > 8 && (
                        <div className="text-2xs text-ink-muted">
                            +{hits.length - 8} more
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
