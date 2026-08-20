/**
 * HistoryExplainer — what this page is showing, said once.
 *
 * A counts series has three properties a reader cannot infer from the chart
 * and will otherwise guess wrong about:
 *
 *   1. **When observations happen.** The points are not evenly spaced. They
 *      land when something changed, plus a checkpoint when nothing did — so a
 *      dense stretch means activity, not a faster poll.
 *   2. **Where the series starts.** History begins at the first capture, not
 *      at the data source's creation. A short series on a mature source is
 *      normal on a recent deploy, not evidence of loss.
 *   3. **What "notable" means.** It is measured against this source's own
 *      typical movement, so the same number can be routine on one source and
 *      an incident on another.
 *
 * Dismissed per browser, not per account: it is orientation, and someone who
 * has read it once on this machine does not need it again. `localStorage`
 * access is wrapped because a private window or blocked site data throws on
 * access rather than returning null.
 */
import { useState } from 'react'
import { ChevronDown, ChevronUp, GraduationCap, X } from 'lucide-react'

import { cn } from '@/lib/utils'

const DISMISS_KEY = 'insights.history.explainer.dismissed'

function readDismissed(): boolean {
    try {
        return window.localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
        return false
    }
}

function writeDismissed() {
    try {
        window.localStorage.setItem(DISMISS_KEY, '1')
    } catch {
        // A viewer with site data blocked simply sees it again next visit.
    }
}

interface Fact { term: string; detail: string }

export function HistoryExplainer({ heartbeatHint, baseline, className }: {
    /** Rendered into the cadence line when known, so the explanation quotes
     *  the deployment's real checkpoint interval rather than a generic one. */
    heartbeatHint?: string
    /** This source's typical movement, so "notable" is defined in numbers the
     *  reader can check against the chart in front of them. */
    baseline?: number
    className?: string
}) {
    // Lazy initial state: reading storage during render would be an impure
    // call, and reading it in an effect would flash the strip before hiding it.
    const [dismissed, setDismissed] = useState(readDismissed)
    const [open, setOpen] = useState(false)

    if (dismissed) return null

    const facts: Fact[] = [
        {
            term: 'Observations are event-driven',
            detail:
                'A point is recorded when the counts actually change, plus a ' +
                `checkpoint when they do not${heartbeatHint ? ` (every ${heartbeatHint})` : ''}. ` +
                'Points are not evenly spaced — a dense stretch means activity, not a faster poll.',
        },
        {
            term: 'History starts at the first capture',
            detail:
                'Not at the data source’s creation. Nothing is backfilled, because ' +
                'the earlier observations were never recorded. The coverage line below ' +
                'the chart always says how far back this particular series goes.',
        },
        {
            term: '“Notable” is relative to this source',
            detail:
                'A change is flagged when it sits well outside this source’s own typical ' +
                `movement${baseline ? ` (about ${baseline.toLocaleString()} entities here)` : ''}. ` +
                'The same number can be routine on a graph that rebuilds nightly and an ' +
                'incident on one that never moves.',
        },
        {
            term: 'A failed collection records nothing',
            detail:
                'If a provider is unreachable the observation is retried, not written — ' +
                'so a graph outage never appears here as a drop to zero. A zero on this ' +
                'chart means the graph really was empty when we looked.',
        },
    ]

    return (
        <div className={cn(
            'rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.04]',
            className,
        )}>
            <div className="flex items-start gap-3 px-4 py-3">
                <span className="w-8 h-8 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
                    <GraduationCap className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-ink">Reading this history</p>
                    <p className="text-[11px] text-ink-secondary mt-0.5">
                        Four things the chart cannot tell you on its own.
                    </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={() => setOpen((o) => !o)}
                        aria-expanded={open}
                        className={cn(
                            'inline-flex items-center gap-1 px-2 py-1 rounded-lg',
                            'text-[11px] font-semibold text-indigo-600 dark:text-indigo-400',
                            'hover:bg-indigo-500/10 transition-colors outline-none',
                            'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                        )}
                    >
                        {open ? 'Hide' : 'Show'}
                        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    <button
                        type="button"
                        onClick={() => { writeDismissed(); setDismissed(true) }}
                        aria-label="Dismiss"
                        title="Don't show this again on this browser"
                        className="p-1 rounded-lg text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {open && (
                <dl className="px-4 pb-4 pt-0 grid gap-3 sm:grid-cols-2">
                    {facts.map((fact) => (
                        <div key={fact.term} className="min-w-0">
                            <dt className="text-[11px] font-bold text-ink">{fact.term}</dt>
                            <dd className="text-[11px] text-ink-secondary mt-0.5 leading-relaxed">
                                {fact.detail}
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    )
}
