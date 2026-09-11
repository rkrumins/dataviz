/**
 * Adjust a pending or running job without cancelling it.
 *
 * An inline disclosure (no portal) in the running panel, in two groups.
 * MORE TIME: what the job is running under and what is left of it,
 * one-click extensions of the stall window, a wall-clock doubling, the two
 * per-query budgets. GO GENTLER: the scan shape in force — pacing, read
 * concurrency, scan width — and one-click ways to ease it: pace the writes,
 * read serially, halve the scans, or clear every live change and go back to
 * the job's settings. Plus the history of who changed what.
 *
 * Every change goes through `PATCH …/limits`; the worker picks it up within
 * about thirty seconds, and the pipeline applies it from the next query,
 * write, wave or scan. The pressure ladder may still narrow further on its
 * own — a live cap is a ceiling, not a floor.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Clock, Feather, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AggregationJobResponse, JobLimitsPatch } from '@/services/aggregationService'
import { timeAgo } from './shared'
import {
    backToSettingsPatch, describeChange, doubleWallPatch, extendStallPatch, formatWindow, halveScansPatch,
    limitsInForce, pacePatch, perQueryPatch, releaseReplicaWaitPatch, secondsLeft, serialReadsPatch,
    shapeInForce, waitForReplicasPatch, smallerBatchesPatch,
} from './timeLimits'

const BUTTON = 'px-2 py-1 rounded-md border border-glass-border text-[11px] font-semibold text-ink hover:border-indigo-500/40 hover:text-indigo-500 transition-colors disabled:opacity-40'
const INPUT = 'w-16 px-1.5 py-1 text-[11px] text-right tabular-nums rounded-md border border-glass-border bg-transparent text-ink outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40'
const GROUP = 'text-[10px] font-semibold uppercase tracking-wide text-ink-muted mr-1'

function Live() {
    return <span className="text-indigo-500"> (live)</span>
}

export function AdjustRunningJob({ job, onAdjust, busy }: {
    job: AggregationJobResponse
    onAdjust: (job: AggregationJobResponse, patch: JobLimitsPatch) => void | Promise<void>
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
    const shape = useMemo(() => shapeInForce(job), [job])
    const left = useMemo(() => secondsLeft(job, now), [job, now])
    const [scan, setScan] = useState<string>('')
    const [write, setWrite] = useState<string>('')
    const history = (job.liveOverrides?.history ?? []).slice(-4).reverse()
    const stallLow = left.stall != null && left.stall < 1800
    const anyLive = shape.live.pacing || shape.live.concurrency || shape.live.scanWidth
        || shape.live.batchMax || shape.live.batchTarget

    const perQuery = perQueryPatch(
        job,
        scan === '' ? null : Number(scan),
        write === '' ? null : Number(write),
    )
    const send = (patch: JobLimitsPatch) => (e: React.MouseEvent) => { e.stopPropagation(); void onAdjust(job, patch) }

    return (
        <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
                aria-expanded={open}
                aria-controls={`adjust-running-${job.id}`}
                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left"
            >
                <span className="flex items-center gap-2 text-[11px] font-semibold text-ink">
                    <Clock className={cn('w-3.5 h-3.5', stallLow ? 'text-amber-500' : 'text-ink-muted')} aria-hidden="true" />
                    Adjust this run
                    <span className="font-normal text-ink-muted tabular-nums">
                        {'·'} stall window {formatWindow(limits.stallSecs)}
                        {left.stall != null && <> ({formatWindow(left.stall)} left)</>}
                        {' · '}wall clock {formatWindow(limits.wallSecs)}
                        {left.wall != null && <> ({formatWindow(left.wall)} left)</>}
                        {anyLive && <> {'·'} <span className="text-indigo-500">gentler</span></>}
                    </span>
                </span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-ink-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
            </button>
            {open && (
                <div id={`adjust-running-${job.id}`} role="group" aria-label="Adjust this run" className="px-3 pb-3 space-y-3 border-t border-glass-border pt-3">
                    <section aria-label="More time" className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={GROUP}>Stall window</span>
                            {[1, 3, 6, 12].map(h => (
                                <button key={h} type="button" disabled={busy} className={BUTTON} onClick={send(extendStallPatch(job, h))}>
                                    +{h} h
                                </button>
                            ))}
                            <span className={cn(GROUP, 'ml-2')}>Wall clock</span>
                            <button type="button" disabled={busy} className={BUTTON} onClick={send(doubleWallPatch(job))}>
                                Double it ({formatWindow(Math.min(604_800, limits.wallSecs * 2))})
                            </button>
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" aria-hidden="true" />}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={GROUP}>Per query</span>
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
                                onClick={(e) => { e.stopPropagation(); void onAdjust(job, perQuery); setScan(''); setWrite('') }}>
                                Apply
                            </button>
                            <span className="text-[10px] text-ink-muted">capped by the graph store’s TIMEOUT_MAX</span>
                        </div>
                    </section>

                    <section aria-label="Go gentler" className="space-y-2 border-t border-glass-border pt-3">
                        <p className="flex items-center gap-1.5 text-[11px] text-ink-secondary tabular-nums" data-testid="shape-in-force">
                            <Feather className="w-3.5 h-3.5 text-ink-muted" aria-hidden="true" />
                            <span>
                                pacing {shape.pacingRatio === 0 ? 'off' : `${shape.pacingRatio}×`}{shape.live.pacing && <Live />}
                                {' · '}{shape.extractConcurrency === 1 ? 'serial reads' : `${shape.extractConcurrency} reads at a time`}{shape.live.concurrency && <Live />}
                                {' · '}scans {shape.scanWidth.toLocaleString()} rows{shape.live.scanWidth && <Live />}
                                {shape.scanWidthNow != null && shape.scanWidthNow < shape.scanWidth && ` (narrowed to ${shape.scanWidthNow.toLocaleString()} by the ladder)`}
                                {' · '}{shape.replicaAckMin === 0 ? 'no replica wait' : `waits for ${shape.replicaAckMin} replica${shape.replicaAckMin === 1 ? '' : 's'}`}{shape.live.replicaAck && <Live />}
                                {' · '}batches of at most {shape.batchMax.toLocaleString()} rows{shape.live.batchMax && <Live />}
                                {' in ~'}{shape.batchTargetS}s{shape.live.batchTarget && <Live />}
                            </span>
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={GROUP}>Go gentler</span>
                            <button type="button" disabled={busy} className={BUTTON} onClick={send(pacePatch(job, 2))} title="Sleep twice as long after every write">Pace ×2</button>
                            <button type="button" disabled={busy} className={BUTTON} onClick={send(pacePatch(job, 4))} title="Sleep four times as long after every write">Pace ×4</button>
                            <button type="button" disabled={busy || shape.extractConcurrency === 1} className={BUTTON} onClick={send(serialReadsPatch())} title="One read scan at a time from the next wave">Serial reads</button>
                            <button type="button" disabled={busy} className={BUTTON} onClick={send(halveScansPatch(job))} title="Cap the scan width at half of what it scans with now">Halve scans</button>
                            <button type="button" disabled={busy || shape.batchMax <= 10} className={BUTTON} onClick={send(smallerBatchesPatch(job))} title="Halve the most rows one write batch may carry — a write batch is the lock window every reader of the graph waits for">Smaller batches</button>
                            <button type="button" disabled={busy || shape.replicaAckMin >= 5} className={BUTTON} onClick={send(waitForReplicasPatch(job))} title="Wait for one more replica of the graph store node to confirm each write before sending the next">Wait for replicas</button>
                            <button type="button" disabled={busy || shape.replicaAckMin === 0} className={BUTTON} onClick={send(releaseReplicaWaitPatch())} title="Stop waiting for replicas — releases a run held behind one that is behind">Stop waiting</button>
                            <button type="button" disabled={busy || !anyLive} className={BUTTON} onClick={send(backToSettingsPatch())} title="Clear every live change">Back to settings</button>
                        </div>
                    </section>

                    <p className="text-[10px] text-ink-muted">
                        Takes effect within about thirty seconds — per-query budgets, pacing, concurrency, scan width, the replica wait and the batch ceiling from the next query, write, wave, scan or batch. A cap is a ceiling: the pressure ladder may still narrow further on its own, and the batch sizer re-grows only toward the new ceiling. Waiting for replicas keeps the graph store’s copies from falling behind, which is what stops a node being restarted mid-rebuild. Scan floor, chunks and rollup storage change on the next Resume or Re-trigger.
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
