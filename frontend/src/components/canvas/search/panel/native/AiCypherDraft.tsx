/**
 * AiCypherDraft — Draft with AI, in the Cypher tab: describe a query in plain words and the AI
 * service writes the Cypher (`POST /ai/query/draft`, mode `cypher`). The draft goes into the
 * console below, with what it means, what it assumed and whether it would be allowed — and
 * waits there. The person reads it and presses Run; it is never run for them.
 *
 * Offered only while the assistant is switched on and set up.
 */
import { AlertTriangle, Bot, CheckCircle2, Loader2, X } from 'lucide-react'
import { type FC, useEffect, useState } from 'react'

import { cn } from '@/lib/utils'
import { useSearchStore } from '@/store/searchStore'

import { useAiQueryDraft } from '../ask/useAiQueryDraft'


export const AiCypherDraft: FC<{ viewId: string }> = ({ viewId }) => {
    const ai = useAiQueryDraft(viewId, 'cypher')
    const [open, setOpen] = useState(false)
    const [question, setQuestion] = useState('')
    const state = ai.state
    const result = state?.status === 'done' ? state.result : null
    const clarification = result?.clarification ?? null

    // A finished draft goes into the console — to read, not to run.
    const cypher = result && !clarification ? result.cypher : null
    useEffect(() => {
        if (cypher) useSearchStore.getState().requestNativeQuery(cypher)
    }, [cypher, result])

    if (!ai.available) return null

    const draft = (choices?: Record<string, string>) => { void ai.draft(question, { choices }) }
    const drafting = state?.status === 'drafting'

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-xl text-left',
                    'border border-violet-500/25 bg-violet-500/[0.04] hover:bg-violet-500/10 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                )}
            >
                <Bot className="w-4 h-4 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden />
                <span className="text-xs text-ink-muted">
                    <span className="font-semibold text-ink">Draft with AI.</span>{' '}
                    Describe the query in plain words; you read the Cypher and run it yourself.
                </span>
            </button>
        )
    }

    return (
        <section aria-label="Draft Cypher with AI" className="rounded-xl border border-violet-500/25 bg-canvas-base/40 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-glass-border/40">
                <Bot className="w-3.5 h-3.5 text-violet-600 dark:text-violet-300" aria-hidden />
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Draft with AI</span>
                <button type="button" onClick={() => { ai.reset(); setOpen(false) }} aria-label="Close Draft with AI"
                        className="ml-auto p-1 rounded-md text-ink-muted hover:text-ink hover:bg-glass/50">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
            <div className="px-3 py-2.5 flex flex-col gap-2">
                <div className="flex items-center gap-1.5">
                    <input
                        autoFocus
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); draft() } }}
                        aria-label="The query you want, in plain words"
                        placeholder="e.g. datasets tagged PII that feed a dashboard"
                        className="input h-8 min-w-0 flex-1 text-sm"
                    />
                    <button
                        type="button"
                        onClick={() => draft()}
                        disabled={drafting || !question.trim()}
                        className={cn(
                            'shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold',
                            'bg-violet-600 text-white hover:bg-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                    >
                        {drafting ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Bot className="w-3.5 h-3.5" aria-hidden />}
                        Draft
                    </button>
                </div>

                <div aria-live="polite" className="flex flex-col gap-1.5">
                    {state?.status === 'error' && (
                        <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{state.message}</p>
                    )}
                    {clarification && (
                        <>
                            <p className="text-xs text-ink">{clarification.question}</p>
                            <div className="flex flex-wrap gap-1.5">
                                {clarification.options.map((o) => (
                                    <button key={o.id} type="button"
                                            onClick={() => draft({ ...(state?.status === 'done' ? state.choices : {}), [clarification.id]: o.id })}
                                            className="rounded-full border border-glass-border px-2 py-0.5 text-xs text-ink hover:border-violet-500/40">
                                        {o.label}
                                        {typeof o.count === 'number' && <span className="ml-1 tabular-nums text-ink-muted">{o.count.toLocaleString()}</span>}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                    {cypher && result && (
                        <>
                            <p className="text-xs text-ink">
                                <span className="font-semibold">In the console below.</span> {result.explanation}
                            </p>
                            {result.assumptions.length > 0 && (
                                <ul className="flex flex-col gap-0.5 text-xs text-ink-muted">
                                    {result.assumptions.map((a) => <li key={a}>Assumed {a}</li>)}
                                </ul>
                            )}
                            {result.guard && (result.guard.ok ? (
                                <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300">
                                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> Read-only — it would be allowed to run.
                                </p>
                            ) : (
                                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden /> {result.guard.message}
                                </p>
                            ))}
                        </>
                    )}
                    {result && !clarification && !cypher && (
                        <p className="text-xs text-ink-muted">It couldn’t write that as Cypher{result.explanation ? ` — ${result.explanation}` : '.'}</p>
                    )}
                </div>
            </div>
        </section>
    )
}
