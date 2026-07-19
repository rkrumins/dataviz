/**
 * FreshnessDrawer — per-source detail: the full freshness doc, an on-demand
 * live "Probe now", and the recent refresh-event history.
 *
 * The base doc loads without a probe (no provider/FalkorDB work). "Probe now"
 * re-fetches with ``probe=true`` — one bounded provider call — and reveals the
 * live fingerprint/counts and the drift verdict.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
    Activity, AlertTriangle, CheckCircle2, Clock, Database, RefreshCw, Radar, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useToast } from '@/components/ui/toast'
import { Backdrop } from '@/components/ui/Backdrop'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { useSetFreshnessSettings, useSourceFreshness } from './useFreshness'
import { AggStatusPill, FreshnessBadges, timeUntil } from './FreshnessRow'
import type { FreshnessDoc } from '@/services/freshnessService'

function shortFp(fp?: string | null): string {
    if (!fp) return '—'
    return fp.length > 14 ? `${fp.slice(0, 14)}…` : fp
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-ink-muted mb-0.5">{label}</div>
            <div className="text-sm text-ink truncate">{children}</div>
        </div>
    )
}

const MAX_INTERVAL_SECS = 86400

function fmtInterval(secs?: number | null): string {
    if (secs == null) return '—'
    if (secs === 0) return 'Off (rebuild every change)'
    if (secs % 3600 === 0) return `${secs / 3600}h`
    return `${Math.round(secs / 60)}m`
}

const SOURCE_LABEL: Record<string, string> = {
    custom: 'Custom',
    global: 'Global default',
    default: 'System default',
}

/**
 * "Rebuild cadence" — the resolved rebuild window + where it came from, with a
 * ds:manage-gated override editor (minutes; "Reset to default" clears it). The
 * value flows from the same server-side resolution the cooldown badge reads.
 */
function RebuildCadenceRow({ doc }: { doc: FreshnessDoc }) {
    const { showToast } = useToast()
    const canManage = usePermission('workspace:datasource:manage', doc.workspaceId ?? undefined)
    const setSettings = useSetFreshnessSettings()

    const overrideMins = doc.rebuildOverrideSecs != null
        ? String(Math.round(doc.rebuildOverrideSecs / 60))
        : ''
    const [mins, setMins] = useState(overrideMins)
    const source = doc.rebuildIntervalSource ?? 'default'

    // The override lives on the aggregation state row, which only exists once a
    // source has been built — a never-aggregated source would 404 the PATCH.
    // Detect that and show guidance instead of a control that can't succeed.
    const neverBuilt = !doc.lastAggregatedAt
        && (doc.aggregationStatus == null || doc.aggregationStatus === 'none')

    const save = (value: number | null) => {
        setSettings.mutate({ dsId: doc.dataSourceId, rebuildMinIntervalSecs: value }, {
            onSuccess: () => showToast('success', value == null
                ? 'Rebuild cadence reset to the default.'
                : 'Rebuild cadence updated.'),
            onError: (e) => showToast('error', e.message || 'Could not update rebuild cadence.'),
        })
    }

    const onSave = () => {
        const n = mins.trim() === '' ? null : Number(mins)
        if (n != null && (!Number.isFinite(n) || n < 0 || n * 60 > MAX_INTERVAL_SECS)) {
            showToast('error', 'Enter a whole number of minutes between 0 and 1440.')
            return
        }
        save(n == null ? null : Math.round(n * 60))
    }

    return (
        <div className="rounded-xl border border-glass-border bg-glass-base/30 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Clock className="w-4 h-4 text-ink-muted" /> Rebuild cadence
                </div>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                    {SOURCE_LABEL[source] ?? source}
                </span>
            </div>
            <p className="text-[11px] text-ink-muted">
                Minimum time between automatic rebuilds of this source. Currently{' '}
                <span className="font-semibold text-ink">{fmtInterval(doc.resolvedRebuildIntervalSecs)}</span>.
            </p>
            {canManage && neverBuilt && (
                <p className="text-[11px] text-ink-muted pt-1">
                    You can set a custom cadence once this source has been built for the first time.
                </p>
            )}
            {canManage && !neverBuilt && (
                <div className="flex items-center gap-2 pt-1">
                    <input
                        type="number" min={0} max={1440} step={1}
                        value={mins}
                        onChange={(e) => setMins(e.target.value)}
                        placeholder="Use default"
                        aria-label="Rebuild cadence override (minutes)"
                        className="w-28 h-8 px-2 rounded-lg border border-glass-border bg-canvas text-sm text-ink"
                    />
                    <span className="text-[11px] text-ink-muted">minutes</span>
                    <button
                        onClick={onSave}
                        disabled={setSettings.isPending}
                        className="ml-auto inline-flex items-center h-8 px-2.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50"
                    >
                        Save
                    </button>
                    {doc.rebuildOverrideSecs != null && (
                        <button
                            onClick={() => { setMins(''); save(null) }}
                            disabled={setSettings.isPending}
                            className="inline-flex items-center h-8 px-2.5 rounded-lg text-xs font-semibold text-ink-muted border border-glass-border hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50"
                        >
                            Reset to default
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}

export function FreshnessDrawer({ dsId, isOpen, onClose, workspaceName }: {
    dsId: string | null
    isOpen: boolean
    onClose: () => void
    workspaceName?: string
}) {
    // The host keys this component on ``dsId``, so each open remounts fresh
    // and probe starts false — no reset effect needed.
    const [probe, setProbe] = useState(false)

    const { data: doc, isLoading, isFetching, error } = useSourceFreshness(dsId, probe, isOpen)
    const probing = probe && isFetching

    return createPortal(
        <>
            <Backdrop open={isOpen && !!dsId} onClick={onClose} />
            {/* No AnimatePresence: this portaled popover unmounts instantly on close so an interrupted exit can't strand an invisible click-blocker over the page. It still animates in. */}
            <>
                {isOpen && dsId && (
                    <motion.div
                        role="dialog" aria-label="Data source freshness"
                        initial={{ x: '100%' }} animate={{ x: 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 40 }}
                        className="fixed right-0 top-0 z-50 h-full w-full max-w-xl overflow-y-auto bg-canvas border-l border-glass-border shadow-2xl"
                    >
                        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 p-4 bg-canvas/80 backdrop-blur border-b border-glass-border">
                            <div className="min-w-0">
                                <h2 className="text-base font-bold text-ink truncate">
                                    {doc?.name || dsId}
                                </h2>
                                <p className="text-[11px] text-ink-muted truncate">
                                    {doc?.providerName || 'Unknown provider'}
                                    {workspaceName ? ` · ${workspaceName}` : ''}
                                </p>
                            </div>
                            <button onClick={onClose} aria-label="Close" className="shrink-0 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="p-4 space-y-5">
                            {isLoading && (
                                <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center">
                                    <RefreshCw className="w-4 h-4 animate-spin" /> Loading freshness…
                                </div>
                            )}

                            {error && !doc && (
                                <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                                    Could not load this source's freshness.
                                </div>
                            )}

                            {doc && (
                                <>
                                    {/* Status + badges */}
                                    <div className="flex flex-wrap items-center gap-2">
                                        <AggStatusPill status={doc.aggregationStatus} />
                                        <FreshnessBadges row={doc} />
                                    </div>

                                    {/* Key facts */}
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                                        <Fact label="Lineage updated">
                                            {doc.lastAggregatedAt ? <TimeStamp at={doc.lastAggregatedAt} prefix="updated" /> : '—'}
                                        </Fact>
                                        <Fact label="Cache as of">
                                            {doc.cacheAsOf ? <TimeStamp at={doc.cacheAsOf} prefix="as of" icon={Database} /> : '—'}
                                        </Fact>
                                        <Fact label="Generation">{doc.generation ?? '—'}</Fact>
                                        <Fact label="Next rebuild">{timeUntil(doc.cooldownUntil) ? `in ${timeUntil(doc.cooldownUntil)}` : 'ready now'}</Fact>
                                        <Fact label="Last known good">
                                            {doc.lkgCount != null
                                                ? `${doc.lkgCount} cached${doc.lkgOldestAgeSecs != null ? ` · oldest ${Math.round(doc.lkgOldestAgeSecs / 60)}m` : ''}`
                                                : '—'}
                                        </Fact>
                                        <Fact label="Stored fingerprint"><span className="font-mono text-xs">{shortFp(doc.storedFingerprint)}</span></Fact>
                                    </div>

                                    {/* Rebuild cadence (resolved + per-source override) */}
                                    <RebuildCadenceRow doc={doc} />

                                    {/* Live probe */}
                                    <div className="rounded-xl border border-glass-border bg-glass-base/30 p-3">
                                        <div className="flex items-center justify-between gap-2 mb-2">
                                            <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                                                <Radar className="w-4 h-4 text-indigo-500" /> Live check
                                            </div>
                                            <button
                                                onClick={() => setProbe(true)}
                                                disabled={probing}
                                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 transition-colors disabled:opacity-50"
                                            >
                                                <RefreshCw className={cn('w-3.5 h-3.5', probing && 'animate-spin')} />
                                                {probing ? 'Probing…' : 'Probe now'}
                                            </button>
                                        </div>
                                        {!probe && (
                                            <p className="text-[11px] text-ink-muted">
                                                Compare the last aggregation against the live source. This makes one bounded call to the provider.
                                            </p>
                                        )}
                                        {probe && !probing && (
                                            <div className="space-y-2">
                                                {doc.drifted === true && (
                                                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                                                        <AlertTriangle className="w-3.5 h-3.5" /> Drift detected — the live source differs from the last aggregation.
                                                    </div>
                                                )}
                                                {doc.drifted === false && (
                                                    <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                                                        <CheckCircle2 className="w-3.5 h-3.5" /> In sync — the live source matches the last aggregation.
                                                    </div>
                                                )}
                                                <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
                                                    <Fact label="Live fingerprint"><span className="font-mono text-xs">{shortFp(doc.liveFingerprint)}</span></Fact>
                                                    <Fact label="Live nodes">{doc.liveNodeCount ?? '—'}</Fact>
                                                    <Fact label="Live edges">{doc.liveEdgeCount ?? '—'}</Fact>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Recent activity */}
                                    <div>
                                        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink mb-2">
                                            <Activity className="w-4 h-4 text-ink-muted" /> Recent activity
                                        </div>
                                        {doc.events.length === 0 ? (
                                            <p className="text-[11px] text-ink-muted">No refresh activity recorded yet.</p>
                                        ) : (
                                            <ul className="space-y-1.5">
                                                {doc.events.map((e, i) => (
                                                    <li key={i} className="flex items-center justify-between gap-3 text-xs">
                                                        <span className="text-ink-secondary">{e.origin} · {e.outcome}</span>
                                                        <TimeStamp at={e.ts} icon={null} colorByAge={false} />
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </motion.div>
                )}
            </>
        </>,
        document.body,
    )
}
