/**
 * Open findings, above the chart until someone acknowledges them.
 *
 * Each one states what it was measured against, not merely that it was
 * unusual: "12,400 against a usual movement of 40" is an argument a reader can
 * check, where "unusual" is a claim they have to take on trust.
 *
 * The three findings read differently on purpose, because they ARE different
 * questions — a movement is a magnitude, a vanished type is categorical, and a
 * silence is the absence of any reading at all.
 */
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, EyeOff, Radio } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { profilingService } from '@/services/profilingService'
import { PROFILING_KEY, useProfilingFindings } from '@/hooks/useProfiling'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import type { Finding } from '@/types/profiling'
import { formatInstant, metricNoun, significanceMeta } from './shared'

const ICON = { movement: AlertTriangle, type_gone: EyeOff, silent: Radio }

function describe(finding: Finding): React.ReactNode {
    const noun = metricNoun(finding.metric, finding.delta)
    if (finding.finding === 'silent') {
        return (
            <>
                This source has stopped reporting. Its credentials, its graph, or the
                provider behind it may have gone away — nothing on the chart can show
                this, because there is nothing to draw.
            </>
        )
    }
    if (finding.finding === 'type_gone') {
        return (
            <>
                Every one of the{' '}
                <strong className="font-semibold tabular-nums">
                    {exact(Math.abs(finding.delta))}
                </strong>{' '}
                {noun} of type{' '}
                <strong className="font-semibold">{finding.subject_type}</strong> has
                gone. Nothing about the total size says so.
            </>
        )
    }
    return (
        <>
            <strong className="font-semibold tabular-nums">
                {finding.delta < 0 ? '−' : '+'}{exact(Math.abs(finding.delta))}
            </strong>{' '}
            {noun}, against a usual movement of{' '}
            <strong className="font-semibold tabular-nums">{exact(finding.baseline)}</strong>
            {' '}for this source.
            {finding.severity === 'critical' && (
                <> Almost nothing is left — {exact(finding.count)} {noun} remain.</>
            )}
        </>
    )
}

function FindingRow({ finding, onDone }: { finding: Finding; onDone: () => void }) {
    const [busy, setBusy] = useState(false)
    const meta = significanceMeta(finding.severity)
    const Icon = ICON[finding.finding] ?? AlertTriangle

    return (
        <li className="flex items-start gap-3 px-4 py-3 border-b border-glass-border last:border-b-0">
            <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', meta.tone)} aria-hidden />
            <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className={cn('text-[11px] font-bold uppercase tracking-wide', meta.tone)}>
                        {meta.label}
                    </span>
                    <span className="text-sm font-semibold text-ink truncate">
                        {finding.data_source_label || finding.graph_name || finding.data_source_id}
                    </span>
                    {finding.provider_name && (
                        <span className="text-xs text-ink-muted">on {finding.provider_name}</span>
                    )}
                </p>
                <p className="text-xs text-ink-secondary mt-1 leading-relaxed">
                    {describe(finding)}
                </p>
                {finding.observed_at && (
                    <p className="text-[11px] text-ink-muted mt-1 tabular-nums">
                        {/* UTC, like every other instant here. These were going
                            through toLocaleString(), so the same event read
                            22:32 in this band and 21:32 in the ledger one card
                            below. */}
                        Happened {formatInstant(finding.observed_at)} · noticed{' '}
                        {formatInstant(finding.detected_at, false)}
                    </p>
                )}
            </div>
            {finding.acknowledged_at ? (
                <p className="shrink-0 text-right text-[11px] text-ink-muted">
                    <span className="block font-semibold text-ink-secondary">Seen</span>
                    {finding.acknowledged_by && (
                        <span className="block">by {finding.acknowledged_by}</span>
                    )}
                    <span className="block tabular-nums">
                        {formatInstant(finding.acknowledged_at, false)}
                    </span>
                </p>
            ) : (
            <button
                type="button"
                disabled={busy}
                onClick={async () => {
                    setBusy(true)
                    try {
                        await profilingService.acknowledge(finding.id)
                        onDone()
                    } finally {
                        setBusy(false)
                    }
                }}
                className={cn(
                    'shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5',
                    'text-xs font-semibold border border-glass-border',
                    'text-ink-secondary hover:text-ink hover:bg-canvas transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                    busy && 'opacity-50',
                )}
            >
                <Check className="w-3.5 h-3.5" aria-hidden />
                {busy ? 'Marking…' : 'Mark seen'}
            </button>
            )}
        </li>
    )
}

export function FindingsBand({ dataSourceId }: { dataSourceId?: string | null }) {
    const canRead = useCanReadProfiling()
    const queryClient = useQueryClient()
    /**
     * Open by default, with the whole record one click away.
     *
     * Showing only unacknowledged findings meant the record vanished the
     * moment someone cleared it — and "has this source done this before?" is
     * the second question after every incident. The API already serves the
     * history with its frozen evidence and who acknowledged what; this is the
     * only place that was missing.
     */
    const [showAll, setShowAll] = useState(false)
    const { data, isLoading } = useProfilingFindings(
        { id: dataSourceId ?? undefined, openOnly: !showAll, limit: 50 },
        { enabled: canRead },
    )

    const findings = data?.alerts ?? []
    const openCount = data?.openCount ?? 0

    if (!canRead) return null
    // Nothing is known yet. Rendering the section here would head it "0
    // findings need a look" — an assertion about a fleet the component has
    // not heard back about, and the one claim a findings surface must never
    // make wrongly.
    if (isLoading && !data) return null
    // Nothing open and nobody asking for history: stay out of the way.
    if (!showAll && !findings.length && !isLoading) {
        return openCount === 0 && (data?.total ?? 0) > 0
            ? (
                <p className="text-xs text-ink-muted">
                    Nothing outstanding.{' '}
                    <button
                        type="button"
                        onClick={() => setShowAll(true)}
                        className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        See what has been found before
                    </button>
                </p>
            )
            : null
    }

    const invalidate = () => queryClient.invalidateQueries({ queryKey: [PROFILING_KEY, 'findings'] })
    const tone = showAll
        ? 'border-glass-border bg-canvas-elevated'
        : 'border-amber-500/30 bg-amber-500/[0.05]'

    return (
        <section
            aria-label={showAll ? 'Findings history' : 'Open findings'}
            className={cn('rounded-2xl border overflow-hidden', tone)}
        >
            <header className={cn(
                'flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b',
                showAll ? 'border-glass-border' : 'border-amber-500/25',
            )}>
                <h3 className="text-sm font-bold text-ink">
                    {showAll
                        ? 'Findings history'
                        : findings.length === 1
                            ? 'One finding needs a look'
                            : `${findings.length} findings need a look`}
                </h3>
                <div className="flex items-center gap-1 rounded-xl bg-canvas p-0.5 border border-glass-border">
                    {[
                        { key: false, label: openCount ? `Open ${openCount}` : 'Open' },
                        { key: true, label: 'All' },
                    ].map((option) => (
                        <button
                            key={String(option.key)}
                            type="button"
                            aria-pressed={showAll === option.key}
                            onClick={() => setShowAll(option.key)}
                            className={cn(
                                'px-2.5 py-1 text-[11px] font-semibold rounded-[10px] transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                                showAll === option.key
                                    ? 'bg-canvas-elevated text-ink shadow-sm ring-1 ring-glass-border'
                                    : 'text-ink-muted hover:text-ink',
                            )}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </header>
            {findings.length ? (
                <ul>
                    {findings.map((f) => (
                        <FindingRow key={f.id} finding={f} onDone={invalidate} />
                    ))}
                </ul>
            ) : (
                <p className="px-4 py-6 text-sm text-ink-muted">
                    {showAll
                        ? 'Nothing has been found for this scope yet.'
                        : 'Nothing outstanding.'}
                </p>
            )}
        </section>
    )
}
