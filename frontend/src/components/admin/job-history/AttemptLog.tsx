/**
 * The attempts of this run that did not succeed.
 *
 * A job row is a run, and a run has many attempts. Every per-attempt field
 * used to be overwritten in place, so resuming a failed job erased the
 * record of why you were resuming it — with the single click taken BECAUSE
 * it failed. `run_stats.attempts` keeps them; this renders them.
 */
import { memo } from 'react'
import { History } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RunAttempt } from '@/services/aggregationService'
import { FAILURE_CATEGORY_LABEL, asFailureCategory } from '../Freshness/failureGuidance'
import { STEP_LABELS } from './runSteps'
import { formatDuration, timeAgo } from './shared'

export const AttemptLog = memo(function AttemptLog({ attempts }: {
    attempts: RunAttempt[] | undefined | null
}) {
    if (!Array.isArray(attempts) || attempts.length === 0) return null
    return (
        <section
            aria-label="Earlier attempts"
            data-testid="attempt-log"
            className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-4 py-3 space-y-2"
        >
            <div className="flex items-center gap-2">
                <History className="w-3.5 h-3.5 text-ink-muted" aria-hidden="true" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                    {attempts.length === 1 ? '1 earlier attempt' : `${attempts.length} earlier attempts`}
                </span>
            </div>
            <ol className="space-y-1.5">
                {attempts.map(attempt => {
                    const cat = asFailureCategory(attempt.category)
                    const stage = attempt.stage ? STEP_LABELS[attempt.stage] ?? attempt.stage : null
                    return (
                        <li key={attempt.n} className="text-[11px] leading-relaxed">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="font-semibold text-ink-secondary tabular-nums">
                                    {`#${attempt.n}`}
                                </span>
                                <span className="text-red-400 font-semibold">
                                    {stage
                                        ? `stopped in ${stage}`
                                        // A worker that vanished mid-stage never
                                        // said where; the next attempt captured it.
                                        : 'stopped without saying where'}
                                    {typeof attempt.progress === 'number' && ` at ${attempt.progress}%`}
                                </span>
                                {cat && (
                                    <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-[9px] font-bold text-red-400 uppercase tracking-wider">
                                        {FAILURE_CATEGORY_LABEL[cat]}
                                    </span>
                                )}
                                <span className="text-ink-muted tabular-nums">
                                    {[
                                        attempt.secs ? formatDuration(attempt.secs) : null,
                                        attempt.writes ? `${attempt.writes.toLocaleString()} written` : null,
                                        attempt.ended_at ? timeAgo(attempt.ended_at) : null,
                                    ].filter(Boolean).join(' · ')}
                                </span>
                            </div>
                            {attempt.error && (
                                <p className={cn(
                                    'mt-0.5 text-[10px] text-red-400/75 font-mono break-words',
                                    'line-clamp-2',
                                )} title={attempt.error}>{attempt.error}</p>
                            )}
                        </li>
                    )
                })}
            </ol>
        </section>
    )
})
