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
import { Cpu, Loader2, Settings2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePolling } from '@/hooks/usePolling'
import { POLLING_INTERVALS } from '@/config/polling'
import { Backdrop } from '@/components/ui/Backdrop'
import {
    aggregationService,
    type AggregationTuning,
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

interface TuningField {
    key: keyof AggregationTuning
    label: string
    min: number
    max: number
    step?: number
    placeholder: string
    help: string
}

const TUNING_FIELDS: TuningField[] = [
    { key: 'scanRangeWidth', label: 'Scan range width', min: 10_000, max: 5_000_000, placeholder: '200000', help: 'Edge-ID range per read query' },
    { key: 'maxPendingPairs', label: 'Memory cap (pairs)', min: 50_000, max: 50_000_000, placeholder: '50000000', help: 'In-worker pair cap before early flush' },
    { key: 'writePacingRatio', label: 'Write pacing ratio', min: 0, max: 10, step: 0.1, placeholder: '1.0', help: 'Sleep after each write × duration; lower is faster' },
    { key: 'extractConcurrency', label: 'Extract concurrency', min: 1, max: 4, placeholder: '1', help: 'Parallel read scans per job' },
    { key: 'applyChunk', label: 'Apply chunk', min: 1_000, max: 200_000, placeholder: '20000', help: 'Pairs written per apply chunk' },
    { key: 'deleteChunk', label: 'Delete chunk', min: 100, max: 50_000, placeholder: '10000', help: 'Stale edges deleted per query' },
    { key: 'maxMaterializedEdges', label: 'Write budget (edges)', min: 10_000, max: 50_000_000, placeholder: '25000000', help: 'Fail loudly instead of exceeding this; sized per graph-store node' },
]

function DefaultsDialog({ onClose }: { onClose: () => void }) {
    const [tuning, setTuning] = useState<AggregationTuning>({})
    const [envFinePairs, setEnvFinePairs] = useState<'auto' | 'true' | 'false'>('true')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        aggregationService.getAggregationSettings()
            .then(res => {
                if (cancelled) return
                setTuning(res.tuning ?? {})
                if (res.envMaterializeFinePairs) setEnvFinePairs(res.envMaterializeFinePairs)
            })
            .catch(() => { /* fresh install — empty defaults */ })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [])

    const setField = (key: keyof AggregationTuning, raw: string) => {
        setMessage(null)
        if (raw === '') {
            // An explicit null, not a deleted key: the server MERGES `tuning`
            // now (so the Automation modal's rollup-storage save cannot wipe
            // these numbers), and a merge can only be told to clear a field by
            // being sent one.
            setTuning(prev => ({ ...prev, [key]: null }))
            return
        }
        const num = Number(raw)
        if (Number.isNaN(num)) return
        setTuning(prev => ({ ...prev, [key]: num }))
    }

    const clampField = (key: keyof AggregationTuning, field: TuningField) => {
        setTuning(prev => {
            const val = prev[key]
            if (typeof val !== 'number') return prev
            return { ...prev, [key]: Math.max(field.min, Math.min(field.max, val)) }
        })
    }

    // Absent means INHERIT, so what the fleet would actually run is the stored
    // value or, failing that, whatever the server says it resolves to.
    const resolvedFinePairs = tuning.materializeFinePairs ?? envFinePairs
    const finePairsIsFull = resolvedFinePairs === true || resolvedFinePairs === 'true'

    const save = async () => {
        setSaving(true)
        setMessage(null)
        try {
            await aggregationService.putAggregationSettings(tuning)
            setMessage('Defaults saved — applied to every new job at trigger time.')
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Failed to save defaults')
        } finally {
            setSaving(false)
        }
    }

    return (
        <>
        <Backdrop open={true} onClick={onClose} zClassName="z-50" className="bg-black/40" />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div
                className="pointer-events-auto w-full max-w-lg rounded-2xl border border-glass-border bg-canvas p-5 shadow-xl space-y-4"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <div>
                        <h4 className="text-sm font-bold text-ink">Aggregation tuning defaults</h4>
                        <p className="text-[11px] text-ink-muted mt-0.5">
                            Global caps/floors for the self-tuning pipeline. Per-job overrides in the
                            trigger dialog layer on top; empty fields fall back to environment defaults.
                        </p>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-8 text-ink-muted">
                        <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                ) : (
                    <>
                        <div className="grid grid-cols-2 gap-3">
                            {TUNING_FIELDS.map(field => (
                                <label key={field.key} className="block">
                                    <span className="block text-[10px] text-ink-muted/70 uppercase tracking-wider font-bold mb-1">
                                        {field.label}
                                    </span>
                                    <input
                                        type="number"
                                        min={field.min}
                                        max={field.max}
                                        step={field.step ?? 1}
                                        placeholder={field.placeholder}
                                        value={typeof tuning[field.key] === 'number' ? String(tuning[field.key]) : ''}
                                        onChange={e => setField(field.key, e.target.value)}
                                        onBlur={() => clampField(field.key, field)}
                                        className="w-full px-2.5 py-1.5 text-[12px] rounded-lg border border-glass-border bg-transparent text-ink tabular-nums focus:border-indigo-500/50 focus:outline-none"
                                    />
                                    <span className="block text-[10px] text-ink-muted/60 mt-0.5">{field.help}</span>
                                </label>
                            ))}
                        </div>
                        <label className="flex items-center gap-2 text-[12px] text-ink">
                            <input
                                type="checkbox"
                                checked={tuning.materializeLeafPairs === true}
                                onChange={e => setTuning(prev => ({ ...prev, materializeLeafPairs: e.target.checked || undefined }))}
                            />
                            Materialize leaf-to-leaf mirror pairs (legacy behavior; doubles write volume)
                        </label>
                        {/* Not a checkbox. Unchecking one used to write
                            `undefined`, and an absent key means INHERIT — which
                            now resolves to full detail, so the box would have
                            read "off" while meaning "on". Both states are
                            written explicitly, in the trigger dialog's words. */}
                        <div>
                            <span className="block text-[10px] text-ink-muted/70 uppercase tracking-wider font-bold mb-1">
                                Rollup storage
                            </span>
                            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Rollup storage">
                                {([
                                    ['auto', 'Auto', 'Full detail within budget; diagonal + on-demand above it.'],
                                    ['full', 'Always full detail', 'Pre-create every combination; fails instead of exceeding the budget.'],
                                ] as const).map(([id, label, help]) => {
                                    const selected = id === 'full' ? finePairsIsFull : !finePairsIsFull
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            role="radio"
                                            aria-checked={selected}
                                            onClick={() => setTuning(prev => ({
                                                ...prev,
                                                materializeFinePairs: id === 'full' ? true : 'auto',
                                            }))}
                                            className={cn(
                                                'px-2.5 py-2 rounded-lg border text-left transition-colors duration-150',
                                                selected
                                                    ? 'border-indigo-500/40 bg-indigo-500/5'
                                                    : 'border-glass-border hover:border-indigo-500/20',
                                            )}
                                        >
                                            <span className="block text-[11px] font-medium text-ink-secondary">{label}</span>
                                            <span className="block text-[10px] text-ink-muted/60 mt-0.5">{help}</span>
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                        {message && (
                            <p className="text-[11px] font-medium text-ink-muted">{message}</p>
                        )}
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={onClose}
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-glass-border text-ink-muted hover:border-glass-border-hover"
                            >
                                Close
                            </button>
                            <button
                                onClick={save}
                                disabled={saving}
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 flex items-center gap-1.5"
                            >
                                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                Save defaults
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
        </>
    )
}

// ─── Fleet panel ────────────────────────────────────────────────────────

export function AggregationFleetPanel() {
    const [fleet, setFleet] = useState<WorkersResponse | null>(null)
    const [showDefaults, setShowDefaults] = useState(false)

    const poll = useCallback(async () => {
        try {
            setFleet(await aggregationService.listAggregationWorkers())
        } catch { /* endpoint unavailable (e.g. non-admin) — hide panel */ }
    }, [])

    // WS0.4's self-scheduling poll with BACKPRESSURE — the next tick arms only
    // after the previous settles, so a hung workers endpoint (e.g. fleet
    // unavailable while a provider is down) can't stack requests every 10s.
    // `usePolling` is that same await-then-arm loop, and it also jitters each
    // tick and pauses while the tab is hidden — neither of which the local
    // copy did, so this panel kept hitting the fleet endpoint every 10s in
    // background tabs.
    usePolling(poll, POLLING_INTERVALS.aggregationFleet)

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

            {showDefaults && <DefaultsDialog onClose={() => setShowDefaults(false)} />}
        </div>
    )
}
