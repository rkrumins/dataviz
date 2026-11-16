/**
 * UpdateProgress — how far a graph's next version is written into the graph store, and the time it
 * has left: the server's `progress` (on the watermark, sync status and a graph's health), said in
 * words (`updateProgressWords`) and drawn as a bar.
 *
 *   "Version 42: 63% written, about 4 min left"
 *   "Version 42 is being built beside: ready in about 3 min"
 *   "Updating to version 42"                      (a phase that counts no rows: no percentage)
 *
 * Every figure is the server's. There is no percentage without rows counted, no time without a
 * rate the server trusts, never 100% before the update is done (rows all written, it is "finishing
 * up") and never "0 min left" (under a minute is "less than a minute"). The bar is an accessible
 * `progressbar`: `aria-valuenow` while rows are counted, `aria-valuetext` the whole sentence, and
 * still (no sweep, no easing) when the person asked for less motion.
 *
 * `block` (the default) is for cards and panels: the phase, the sentence, the bar, then the rows,
 * their rate and when it started. `chip` is a mini bar and a few words that sit inside a host's own
 * pill; with `withVersion={false}` it adds only what its host doesn't already say (the percentage
 * and the time left), and nothing when there is neither.
 */
import { useReducedMotionConfig } from 'framer-motion'
import { cn } from '@/lib/utils'
import { formatCount, formatNumber, pluralize } from '@/lib/units'
import { DateTime } from '@/components/ui/DateTime'
import type { GraphUpdateProgress } from '@/services/versioningApiService'
import { describeProgress } from './updateProgressWords'

/** The bar: determinate while rows are counted, else a sweep (still under reduced motion). */
function Bar({ percent, label, valueText, still, mini, className }: {
    percent: number | null; label: string; valueText: string; still: boolean; mini?: boolean; className?: string
}) {
    return (
        <span
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={valueText}
            className={cn('relative block overflow-hidden rounded-full bg-indigo-500/15 dark:bg-indigo-400/20',
                mini ? 'h-1 w-8 shrink-0' : 'h-1.5 w-full', className)}
        >
            {percent != null ? (
                <span
                    data-part="fill"
                    className={cn('absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 dark:from-indigo-400 dark:to-violet-400',
                        still ? 'transition-none' : 'transition-[width] duration-700 ease-out motion-reduce:transition-none')}
                    style={{ width: `${Math.max(mini ? 10 : 2, percent)}%` }}
                />
            ) : still ? (
                // The length of the work isn't known, and nothing moves: a still third of the track.
                <span data-part="still" className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-indigo-500/60 dark:bg-indigo-400/60" />
            ) : (
                <span data-part="sweep" className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-indigo-500 to-transparent dark:via-indigo-400 animate-indeterminate motion-reduce:animate-none" />
            )}
        </span>
    )
}

export function UpdateProgress({ progress, variant = 'block', withVersion = true, className }: {
    progress: GraphUpdateProgress | null | undefined
    variant?: 'block' | 'chip'
    /** `chip` only: false when the host already names the version — then only the percentage and
     *  the time left are added, and nothing when there is neither. */
    withVersion?: boolean
    className?: string
}) {
    const still = useReducedMotionConfig() ?? false
    if (!progress) return null
    const w = describeProgress(progress)
    const name = `${w.label} progress`

    if (variant === 'chip') {
        const text = withVersion ? w.short : w.bare
        if (!text) return null
        // Its words wrap where its host lets them (a narrow bar), and stay on one line in a host that
        // keeps to one (`whitespace-nowrap`).
        return (
            <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
                <Bar percent={w.percent} label={name} valueText={w.sentence} still={still} mini />
                <span className="min-w-0 tabular-nums" aria-hidden>{text}</span>
            </span>
        )
    }

    const unit = progress.unit || 'rows'
    const counted = progress.total != null && progress.total > 0 && progress.done != null
    const rate = progress.ratePerSec
    const facts = [
        counted && `${formatCount(progress.done!)} of ${formatCount(progress.total!, unit)}`,
        rate != null && `${formatNumber(rate, { maxFractionDigits: rate < 10 ? 1 : 0 })} ${pluralize(rate, unit)} a second`,
    ].filter(Boolean) as string[]
    return (
        <div className={cn('min-w-0', className)}>
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">
                <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400', !still && 'animate-pulse-soft motion-reduce:animate-none')} />
                {w.label}
            </p>
            {/* Said once to assistive tech, by the bar's value. */}
            <p aria-hidden className="mt-1 text-[13px] font-medium leading-snug text-ink">{w.sentence}</p>
            <Bar percent={w.percent} label={name} valueText={w.sentence} still={still} className="mt-2" />
            {(facts.length > 0 || progress.startedAt) && (
                <p className="mt-1.5 text-[11.5px] leading-snug text-ink-secondary tabular-nums">
                    {facts.join(' · ')}
                    {progress.startedAt && <>{facts.length > 0 && ' · '}<DateTime at={progress.startedAt} prefix="started " /></>}
                </p>
            )}
        </div>
    )
}
