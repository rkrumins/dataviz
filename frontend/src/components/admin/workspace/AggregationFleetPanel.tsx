/**
 * AggregationFleetPanel — live worker-fleet view + global tuning defaults.
 *
 * Renders inside WorkspaceAggregationDashboard:
 * - Stat tiles (workers online, queue depth, pending deliveries)
 * - Per-worker cards: slots, memory bar (RSS vs cgroup limit), large-job
 *   and draining badges, active job ids — polled every 10s while mounted.
 * - A "Defaults" dialog editing the stored global pipeline tuning
 *   (GET/PUT /aggregation/settings) that seeds every new job.
 */

import { useCallback, useEffect, useState } from 'react'
import { Cpu, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DefaultsDialog } from '../shared/DefaultsDialog'
import {
    aggregationService,
    type WorkersResponse,
} from '@/services/aggregationService'

function shortId(workerId: string): string {
    return workerId.length > 28 ? `${workerId.slice(0, 28)}…` : workerId
}

function uptime(startedAt?: string | null): string {
    if (!startedAt) return '—'
    const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000)
    if (mins < 1) return '<1m'
    if (mins < 60) return `${mins}m`
    const h = Math.floor(mins / 60)
    return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

// ─── Defaults dialog ────────────────────────────────────────────────────
// The fleet-wide Defaults live in ``shared/DefaultsDialog`` now — the same
// dialog the Freshness page's capacity card opens — so the knobs are
// described once and the placeholders are the server's live env defaults.

// ─── Fleet panel ────────────────────────────────────────────────────────

export function AggregationFleetPanel() {
    const [fleet, setFleet] = useState<WorkersResponse | null>(null)
    const [showDefaults, setShowDefaults] = useState(false)

    const poll = useCallback(async () => {
        try {
            setFleet(await aggregationService.listAggregationWorkers())
        } catch { /* endpoint unavailable (e.g. non-admin) — hide panel */ }
    }, [])

    // WS0.4: self-scheduling poll with BACKPRESSURE — the next tick arms only
    // after the previous settles, so a hung workers endpoint (e.g. fleet
    // unavailable while a provider is down) can't stack requests every 10s.
    useEffect(() => {
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const tick = async () => {
            await poll()
            if (!cancelled) timer = setTimeout(tick, 10_000)
        }
        tick()
        return () => { cancelled = true; if (timer) clearTimeout(timer) }
    }, [poll])

    return (
        <div className="rounded-xl border border-glass-border/60 bg-canvas p-4 space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-indigo-500" />
                    <h4 className="text-sm font-bold text-ink">Workers</h4>
                    {fleet && (
                        <span className="text-[11px] text-ink-muted tabular-nums">
                            {fleet.workers.length} online · queue {fleet.queueDepth} · pending {fleet.queuePending}
                        </span>
                    )}
                </div>
                <button
                    onClick={() => setShowDefaults(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-glass-border text-ink-muted hover:border-indigo-500/30 hover:text-indigo-500 transition-colors"
                >
                    <Settings2 className="w-3.5 h-3.5" />
                    Defaults
                </button>
            </div>

            {!fleet || fleet.workers.length === 0 ? (
                <p className="text-[12px] text-ink-muted py-2">
                    No workers connected{fleet ? '' : ' (fleet endpoint unavailable)'}.
                </p>
            ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                    {fleet.workers.map(w => {
                        const memPct = w.rssMb != null && w.memLimitMb ? Math.min(100, Math.round((w.rssMb / w.memLimitMb) * 100)) : null
                        return (
                            <div key={w.workerId} className="rounded-lg border border-glass-border/60 px-3 py-2 space-y-1.5">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-semibold text-ink truncate" title={w.workerId}>
                                        {shortId(w.workerId)}
                                    </span>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        {w.drain && (
                                            <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                                draining
                                            </span>
                                        )}
                                        {w.largeJobsActive > 0 && (
                                            <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                                                {w.largeJobsActive} large
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-3 text-[10px] text-ink-muted tabular-nums">
                                    <span>up {uptime(w.startedAt)}</span>
                                    <span>slots {w.activeJobs.length}/{w.concurrency}</span>
                                    {memPct != null && <span>mem {Math.round(w.rssMb!)}MB ({memPct}%)</span>}
                                </div>
                                {memPct != null && (
                                    <div className="h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                                        <div
                                            className={cn(
                                                'h-full rounded-full transition-all',
                                                memPct >= 75 ? 'bg-red-400' : memPct >= 50 ? 'bg-amber-400' : 'bg-emerald-400',
                                            )}
                                            style={{ width: `${memPct}%` }}
                                        />
                                    </div>
                                )}
                                {w.activeJobs.length > 0 && (
                                    <p className="text-[10px] text-ink-muted/70 truncate">
                                        {w.activeJobs.map(j => j.jobId).join(', ')}
                                    </p>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            <DefaultsDialog open={showDefaults} onClose={() => setShowDefaults(false)} />
        </div>
    )
}
