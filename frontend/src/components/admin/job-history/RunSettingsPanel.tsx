/**
 * What one run ran with and what it adapted to.
 *
 * Every rebuild leaves a record in its `runStats`: `effective_tuning` (each
 * knob's value and where it came from — the job's own override, what the
 * last run of the source learned, or the environment) written at the first
 * checkpoint so a failed or cancelled run has it too, and `adapted` (what
 * the pressure ladder changed — narrower scans, serial reads, the keys-only
 * reconcile, smaller write batches, timeout retries). This panel renders
 * both for any status; while a job runs it reads the live overlay first.
 *
 * Legacy rows (before the record existed) fall back to the frozen tuning
 * the job carried, labelled as such.
 */
import { useMemo } from 'react'
import { Activity, Sparkles, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AdaptedRunState, AggregationJobResponse, AggregationTuning } from '@/services/aggregationService'
import {
    SOURCE_LABEL, SOURCE_TONE, adaptationSentences, frozenTuningRows, paceSentence, presetForRun, runSettingsRows,
} from './runSettings'

export function RunSettingsPanel({ job, storedGlobal, live }: {
    job: AggregationJobResponse
    storedGlobal?: AggregationTuning | null
    /** The live overlay's adapted scalars while the job runs; wins over the polled record. */
    live?: Partial<AdaptedRunState> | null
}) {
    const eff = job.runStats?.effective_tuning ?? null
    const rows = useMemo(
        () => (eff ? runSettingsRows(eff, storedGlobal) : frozenTuningRows(job.tuning ?? null)),
        [eff, storedGlobal, job.tuning],
    )
    const preset = useMemo(() => presetForRun(eff), [eff])
    const adapted = useMemo<AdaptedRunState | null>(() => {
        const base = job.runStats?.adapted ?? null
        if (!live || Object.keys(live).length === 0) return base
        return { ...(base ?? {}), ...live }
    }, [job.runStats?.adapted, live])
    const sentences = useMemo(
        () => adaptationSentences(adapted, { bytesPerEdgeObserved: job.runStats?.bytes_per_edge_observed }),
        [adapted, job.runStats?.bytes_per_edge_observed],
    )
    const pace = useMemo(
        () => paceSentence(job.runStats?.pace, adapted?.eases),
        [job.runStats?.pace, adapted?.eases],
    )
    const running = job.status === 'running'

    return (
        <section
            aria-label="Run settings"
            data-testid="run-settings-panel"
            className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-4 py-3 space-y-3"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Wrench className="w-3.5 h-3.5 text-ink-muted" aria-hidden="true" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Run settings</span>
                </div>
                <span className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold',
                    preset ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
                )}>
                    {preset ? `${preset} profile` : eff ? 'Custom settings' : 'Legacy record'}
                </span>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-1.5">Ran with</p>
                    {rows.length === 0 ? (
                        <p className="text-[11px] text-ink-muted">No record — this run predates run settings.</p>
                    ) : (
                        <dl className="divide-y divide-glass-border">
                            {rows.map(row => (
                                <div key={row.key} className="flex items-center justify-between gap-3 py-1">
                                    <dt className="text-[11px] text-ink-secondary">{row.label}</dt>
                                    <dd className="flex items-center gap-2">
                                        <span className="text-[11px] font-semibold text-ink tabular-nums">{row.value}</span>
                                        <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-semibold', SOURCE_TONE[row.source])}>
                                            {SOURCE_LABEL[row.source]}
                                        </span>
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    )}
                    {pace && (
                        <p data-testid="run-pace" className="mt-2 text-[11px] text-ink-secondary leading-snug">{pace}</p>
                    )}
                </div>
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
                        {running ? 'Adapting during the run' : 'Adapted during the run'}
                    </p>
                    {sentences.length === 0 ? (
                        <p className="text-[11px] text-ink-muted flex items-center gap-1.5">
                            <Sparkles className="w-3 h-3 text-emerald-500" aria-hidden="true" />
                            {running ? 'Nothing yet — running at its settings' : 'Nothing — ran at its settings'}
                        </p>
                    ) : (
                        <ul className="space-y-1">
                            {sentences.map(s => (
                                <li key={s} className="flex items-start gap-1.5 text-[11px] text-ink">
                                    <Activity className="w-3 h-3 mt-0.5 text-amber-500 flex-shrink-0" aria-hidden="true" />
                                    <span>{s}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </section>
    )
}
