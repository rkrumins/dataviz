/**
 * Give a pending or running job more time without cancelling it.
 *
 * An inline disclosure (no portal) in the running panel: what the job is
 * running under and what is left of it, one-click extensions of the stall
 * window, a wall-clock doubling, the two per-query budgets, and the history
 * of who raised what. Every change goes through `PATCH …/limits`; the
 * worker picks it up within about thirty seconds, per-query budgets on the
 * next query.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Clock, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AggregationJobResponse, JobLimitsPatch } from '@/services/aggregationService'
import { timeAgo } from './shared'
import {
    describeChange, doubleWallPatch, extendStallPatch, formatWindow, limitsInForce, perQueryPatch, secondsLeft,
} from './timeLimits'

const BUTTON = 'px-2 py-1 rounded-md border border-glass-border text-[11px] font-semibold text-ink hover:border-indigo-500/40 hover:text-indigo-500 transition-colors disabled:opacity-40'
const INPUT = 'w-16 px-1.5 py-1 text-[11px] text-right tabular-nums rounded-md border border-glass-border bg-transparent text-ink outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40'

export function ExtendLimits({ job, onExtend, busy }: {
    job: AggregationJobResponse
    onExtend: (job: AggregationJobResponse, patch: JobLimitsPatch) => void | Promise<void>
    busy: boolean
}) {
    const [open, setOpen] = useState(false)
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!open) return
        const id = window.setInterval(() => setNow(Date.now()), 15_000)
        return () => window.clearInterval(id)
    }, [open])

    const limits = useMemo(() => limitsInForce(job), [job])
    const left = useMemo(() => secondsLeft(job, now), [job, now])
    const [scan, setScan] = useState<string>('')
    const [write, setWrite] = useState<string>('')
    const history = (job.liveOverrides?.history ?? []).slice(-3).reverse()
    const stallLow = left.stall != null && left.stall < 1800

    const perQuery = perQueryPatch(
        job,
        scan === '' ? null : Number(scan),
        write === '' ? null : Number(write),
    )

    return (
        <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
                aria-expanded={open}
                aria-controls={`extend-limits-${job.id}`}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left"
            >
                <span className="flex items-center gap-2 text-[11px] font-semibold text-ink">
                    <Clock className={cn('w-3.5 h-3.5', stallLow ? 'text-amber-500' : 'text-ink-muted')} aria-hidden="true" />
                    Extend time limit
                    <span className="font-normal text-ink-muted tabular-nums">
                        {'·'} stall window {formatWindow(limits.stallSecs)}
                        {left.stall != null && <> ({formatWindow(left.stall)} left)</>}
                        {' · '}wall clock {formatWindow(limits.wallSecs)}
                        {left.wall != null && <> ({formatWindow(left.wall)} left)</>}
                    </span>
                </span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-ink-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
            </button>
            {open && (
                <div id={`extend-limits-${job.id}`} role="group" aria-label="Extend time limit" className="px-3 pb-3 space-y-3 border-t border-glass-border pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mr-1">Stall window</span>
                        {[1, 3, 6, 12].map(h => (
                            <button key={h} type="button" disabled={busy} className={BUTTON}
                                onClick={(e) => { e.stopPropagation(); void onExtend(job, extendStallPatch(job, h)) }}>
                                +{h} h
                            </button>
                        ))}
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted ml-2 mr-1">Wall clock</span>
                        <button type="button" disabled={busy} className={BUTTON}
                            onClick={(e) => { e.stopPropagation(); void onExtend(job, doubleWallPatch(job)) }}>
                            Double it ({formatWindow(Math.min(604_800, limits.wallSecs * 2))})
                        </button>
                        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" aria-hidden="true" />}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mr-1">Per query</span>
                        <label className="flex items-center gap-1 text-[11px] text-ink-secondary">
                            scan
                            <input type="number" min={5} max={600} className={INPUT} aria-label="Scan timeout, seconds"
                                placeholder={limits.scanTimeoutS != null ? String(limits.scanTimeoutS) : '30'}
                                value={scan} onChange={e => setScan(e.target.value)} onClick={e => e.stopPropagation()} />
                            s
                        </label>
                        <label className="flex items-center gap-1 text-[11px] text-ink-secondary">
                            write
                            <input type="number" min={5} max={600} className={INPUT} aria-label="Write timeout, seconds"
                                placeholder={limits.writeTimeoutS != null ? String(limits.writeTimeoutS) : '60'}
                                value={write} onChange={e => setWrite(e.target.value)} onClick={e => e.stopPropagation()} />
                            s
                        </label>
                        <button type="button" disabled={busy || Object.keys(perQuery).length === 0} className={BUTTON}
                            onClick={(e) => { e.stopPropagation(); void onExtend(job, perQuery); setScan(''); setWrite('') }}>
                            Apply
                        </button>
                        <span className="text-[10px] text-ink-muted">capped by the graph store’s TIMEOUT_MAX</span>
                    </div>
                    <p className="text-[10px] text-ink-muted">
                        Takes effect within about thirty seconds; per-query budgets apply to the next query. Scan shape (width, concurrency, pacing) changes on the next Resume or Re-trigger.
                    </p>
                    {history.length > 0 && (
                        <ul className="space-y-0.5" aria-label="Recent limit changes">
                            {history.map((h, i) => (
                                <li key={`${h.at}-${i}`} className="text-[10px] text-ink-muted tabular-nums">
                                    {describeChange(h)} {'·'} {timeAgo(h.at)}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}
