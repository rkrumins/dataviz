/**
 * BudgetMeter — how much of the write budget a run actually consumed.
 *
 * The budget was previously invisible until it was exceeded, at which point
 * the job failed terminally and was never retried. This makes the headroom
 * legible on every run, so the wall is something you watch approaching rather
 * than something you hit.
 *
 * The fill carries severity and the track is a lighter step of the SAME ramp,
 * so the state of the bar reads across its whole width rather than only where
 * it happens to end. Percentage and counts are stated in text beside it — the
 * bar is the at-a-glance layer, never the only one.
 */
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import {
    compactCount,
    formatBytes,
    budgetPressure,
    BYTES_PER_AGG_EDGE,
} from '../shared/aggregationScale'

const RAMP = {
    ok: { fill: 'bg-emerald-500', track: 'bg-emerald-500/15', ink: 'text-emerald-600 dark:text-emerald-400' },
    warning: { fill: 'bg-amber-500', track: 'bg-amber-500/15', ink: 'text-amber-600 dark:text-amber-400' },
    critical: { fill: 'bg-red-500', track: 'bg-red-500/15', ink: 'text-red-600 dark:text-red-400' },
} as const

export interface BudgetMeterProps {
    /** Rollup edges this run stored (or, on a failure, would have stored). */
    used: number
    /** The configured write budget. */
    budget: number
    /** True when the run FAILED because `used` exceeded `budget`. */
    exceeded?: boolean
    className?: string
}

export function BudgetMeter({ used, budget, exceeded = false, className }: BudgetMeterProps): JSX.Element | null {
    if (!budget || !Number.isFinite(budget) || !Number.isFinite(used)) return null

    const ratio = used / budget
    const tone = exceeded ? 'critical' : budgetPressure(used, budget)
    const ramp = RAMP[tone]
    const pct = Math.round(ratio * 100)
    // An over-budget run would run off the end of the track; pin the fill and
    // let the number carry the overshoot.
    const fillPct = Math.max(2, Math.min(100, pct))

    return (
        <div className={cn('space-y-1.5', className)}>
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">
                    Write budget
                </span>
                <span className={cn('text-[11px] font-semibold', ramp.ink)}>
                    {pct}%{exceeded && ' — over'}
                </span>
            </div>

            <div
                className={cn('h-1.5 w-full rounded-full overflow-hidden', ramp.track)}
                role="meter"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Write budget used: ${used.toLocaleString()} of ${budget.toLocaleString()} rollup edges`}
            >
                <div
                    className={cn('h-full rounded-full transition-[width] duration-500', ramp.fill)}
                    style={{ width: `${fillPct}%` }}
                />
            </div>

            <p className="text-[10px] text-ink-muted">
                {compactCount(used)} of {compactCount(budget)} rollup edges
                {' · '}
                ≈{formatBytes(used * BYTES_PER_AGG_EDGE)} of graph memory
            </p>
        </div>
    )
}

export default BudgetMeter
