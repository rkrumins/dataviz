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
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
    Activity, AlertTriangle, ArrowUpRight, CheckCircle2, ChevronRight, Clock, Database, Eraser,
    RefreshCw, Radar, RotateCcw, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useToast } from '@/components/ui/toast'
import { Backdrop } from '@/components/ui/Backdrop'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'
import { jobHistoryPath } from '../job-history/shared'
import { useRefreshSource, useSetFreshnessSettings, useSourceFreshness } from './useFreshness'
import { useActiveJobs } from './useActiveJobs'
import { AggStatusPill, FreshnessBadges, timeUntil } from './FreshnessRow'
import type { FailureCategory, FreshnessDoc } from '@/services/freshnessService'

function shortFp(fp?: string | null): string {
    if (!fp) return '—'
    return fp.length > 14 ? `${fp.slice(0, 14)}…` : fp
}

// Friendly names for the cache endpoint segments; anything else is sentence-
// cased (matching the casing of these — "Aggregated lineage", not Title Case).
const ENDPOINT_LABELS: Record<string, string> = {
    aggregated: 'Aggregated lineage',
    'children-with-edges': 'Hierarchy children',
    children: 'Hierarchy children',
    'top-level': 'Top-level roots',
}

function endpointLabel(key: string): string {
    if (ENDPOINT_LABELS[key]) return ENDPOINT_LABELS[key]
    const spaced = key.replace(/-/g, ' ')
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
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

/**
 * "Cache contents" — the source's live-cache footprint: total entries, a
 * per-endpoint breakdown, and the last-known-good fallback the cache serves
 * when a live rebuild fails. ``cacheKeyCount`` null = the cache couldn't be
 * read (unavailable); 0 = nothing cached yet — two distinct states.
 */
function CacheContents({ doc }: { doc: FreshnessDoc }) {
    const count = doc.cacheKeyCount
    const byEndpoint = Object.entries(doc.cacheKeyCountByEndpoint ?? {})
        .sort((a, b) => b[1] - a[1] || endpointLabel(a[0]).localeCompare(endpointLabel(b[0])))
    const lkg = doc.lkgCount != null
        ? `${doc.lkgCount.toLocaleString()} cached${doc.lkgOldestAgeSecs != null ? ` · oldest ${Math.round(doc.lkgOldestAgeSecs / 60)}m` : ''}`
        : '—'

    return (
        <div className="rounded-xl border border-glass-border bg-glass-base/30 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Database className="w-4 h-4 text-violet-500" /> Cache contents
                </div>
                {count != null && count > 0 && (
                    <span className="text-[11px] tabular-nums text-ink-muted">
                        {count.toLocaleString()} {count === 1 ? 'entry' : 'entries'}
                    </span>
                )}
            </div>

            {count == null ? (
                <p className="text-[11px] text-ink-muted">
                    Cache contents unavailable — the cache could not be read.
                </p>
            ) : count === 0 ? (
                <p className="text-[11px] text-ink-muted">Nothing cached yet.</p>
            ) : (
                <ul className="space-y-1">
                    {byEndpoint.map(([key, n]) => (
                        <li key={key} className="flex items-center justify-between gap-3 text-xs">
                            <span className="text-ink-secondary truncate">{endpointLabel(key)}</span>
                            <span className="tabular-nums text-ink-muted shrink-0">{n.toLocaleString()}</span>
                        </li>
                    ))}
                </ul>
            )}

            {/* Last known good: the snapshot served if a live rebuild fails. */}
            <div className="flex items-center justify-between gap-3 text-xs pt-1.5 border-t border-glass-border/60">
                <span className="text-ink-muted">Last known good</span>
                <span className="tabular-nums text-ink-muted shrink-0">{lkg}</span>
            </div>
        </div>
    )
}

/**
 * Category-specific resolution guidance for a failed rebuild (spec §9c). Each
 * entry supplies the plain-language WHY, the HOW-to-resolve steps, and which
 * CTAs to offer — with the *recommended* action as the filled primary. Copy is
 * white-label and non-alarmist: it explains and directs, it doesn't apologize.
 */
interface CategoryGuidance {
    why: string
    how: string
    /** Extra directive that isn't itself a button (e.g. "assign an ontology"). */
    note?: string
    showClear: boolean
    showRetry: boolean
    /** Which CTA is the recommended, filled primary. */
    primary: 'clear' | 'retry'
    /** Inline caution shown under Retry when a retry is likely to fail again. */
    retryWarning?: string
}

const GUIDANCE: Record<FailureCategory, CategoryGuidance> = {
    out_of_memory: {
        why: 'The graph store ran out of memory while building aggregated lineage for this large source.',
        how: 'Free up memory in the graph store (remove unused graphs) or raise its memory limit, then retry the rebuild.',
        showClear: true, showRetry: true, primary: 'clear',
        retryWarning: 'may fail again until memory is freed.',
    },
    provider_unavailable: {
        why: 'The graph store was unreachable during the rebuild.',
        how: 'Check that the graph store is back online, then retry the rebuild.',
        showClear: true, showRetry: true, primary: 'retry',
    },
    ontology: {
        why: "This data source has no ontology assigned, so its lineage can't be aggregated.",
        how: 'Assign an ontology to this data source, then rebuild its lineage.',
        note: "Set an ontology in this source's settings before rebuilding — a retry will fail until then.",
        showClear: true, showRetry: false, primary: 'clear',
    },
    timeout: {
        why: 'The rebuild took longer than the allowed time.',
        how: 'Retry the rebuild. If it keeps timing out, the source may be too large for the current limit.',
        showClear: true, showRetry: true, primary: 'retry',
    },
    conflict: {
        why: 'Another rebuild for this source was already running.',
        how: 'Wait for the running rebuild to finish, then retry if the lineage is still out of date.',
        showClear: true, showRetry: true, primary: 'retry',
    },
    unknown: {
        why: "The rebuild didn't complete.",
        how: 'Retry the rebuild. If it keeps failing, check the technical details below.',
        showClear: true, showRetry: true, primary: 'retry',
    },
}

/**
 * The resolution-guidance panel: what happened → why → how to resolve, plus
 * the Clear-cache / Retry-rebuild CTAs and a muted verbatim-error disclosure.
 * Guidance renders for everyone; the CTAs are ds:manage-gated (``canManage``).
 */
function ResolutionGuidance({ doc, canManage, busy, onClear, onRetry }: {
    doc: FreshnessDoc
    canManage: boolean
    busy: boolean
    onClear: () => void
    onRetry: () => void
}) {
    const category: FailureCategory = doc.lastFailureCategory ?? 'unknown'
    // ?? unknown: a future backend category we don't map yet must not throw.
    const g = GUIDANCE[category] ?? GUIDANCE.unknown
    const attempts = doc.retryCount != null && doc.retryCount > 1 ? doc.retryCount : null

    const primaryCls = 'text-white bg-indigo-600 hover:bg-indigo-700'
    const secondaryCls = 'text-ink-muted border border-glass-border hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
    const clearBtn = g.showClear ? (
        <button
            key="clear" type="button" onClick={onClear} disabled={busy}
            className={cn('inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50', g.primary === 'clear' ? primaryCls : secondaryCls)}
        >
            <Eraser className="w-3.5 h-3.5" /> Clear cache
        </button>
    ) : null
    const retryBtn = g.showRetry ? (
        <button
            key="retry" type="button" onClick={onRetry} disabled={busy}
            className={cn('inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50', g.primary === 'retry' ? primaryCls : secondaryCls)}
        >
            <RotateCcw className="w-3.5 h-3.5" /> Retry rebuild
        </button>
    ) : null
    const buttons = g.primary === 'clear' ? [clearBtn, retryBtn] : [retryBtn, clearBtn]

    return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4 space-y-3">
            {/* What */}
            <div className="flex items-start gap-2.5">
                <span className="shrink-0 mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                </span>
                <div className="min-w-0">
                    <h3 className="text-sm font-bold text-ink">Lineage rebuild failed</h3>
                    {attempts && (
                        <p className="text-[11px] text-ink-muted">Failed after {attempts} attempts</p>
                    )}
                </div>
            </div>

            {/* Why */}
            <p className="text-xs text-ink-secondary leading-relaxed">{g.why}</p>

            {/* How */}
            <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-ink-muted">How to resolve</div>
                <p className="text-xs text-ink-secondary leading-relaxed">{g.how}</p>
                {g.note && <p className="text-xs text-ink-secondary leading-relaxed">{g.note}</p>}
            </div>

            {/* CTAs */}
            {canManage && (
                <div className="space-y-2 pt-0.5">
                    <div className="flex flex-wrap items-center gap-2">{buttons}</div>
                    {g.showClear && (
                        <p className="text-[11px] text-ink-muted">
                            Clear cache resets cached data and the stuck state — safe to run now. It doesn't rebuild lineage.
                        </p>
                    )}
                    {g.showRetry && g.retryWarning && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
                            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> Retry rebuild {g.retryWarning}
                        </p>
                    )}
                </div>
            )}

            {/* Details — the verbatim error, for operators. */}
            {doc.lastFailureReason && (
                <details className="group pt-1">
                    <summary className="flex items-center gap-1 cursor-pointer select-none list-none text-[11px] text-ink-muted hover:text-ink-secondary transition-colors">
                        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" /> Details
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-glass-border bg-black/[0.03] dark:bg-white/[0.03] p-2 text-[10px] font-mono text-ink-muted whitespace-pre-wrap break-words">
                        {doc.lastFailureReason}
                    </pre>
                </details>
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
    const [retryOpen, setRetryOpen] = useState(false)

    const { data: doc, isLoading, isFetching, error } = useSourceFreshness(dsId, probe, isOpen)
    const probing = probe && isFetching
    const { byDataSource } = useActiveJobs()

    const { showToast } = useToast()
    const canManage = usePermission('workspace:datasource:manage', doc?.workspaceId ?? undefined)
    const refresh = useRefreshSource()
    const name = doc?.name || dsId || 'this source'

    // Clear cache is the safe reset — no confirm; Retry rebuilds (may fail
    // again for OOM) so it confirms first. Both invalidate fleet + doc via the
    // mutation's onSuccess, so the panel updates in place.
    const doClear = () => {
        if (!dsId) return
        refresh.mutate({ dsId, scope: 'clear' }, {
            onSuccess: () => showToast('success', `Cache cleared for ${name}.`),
            onError: (e) => showToast('error', e.message || 'Could not clear the cache.'),
        })
    }
    const doRetry = () => {
        if (!dsId) return
        refresh.mutate({ dsId, scope: 'rollups' }, {
            onSuccess: () => showToast('success', `Lineage rebuild queued for ${name}.`),
            onError: (e) => showToast('error', e.message || 'Could not start the rebuild.'),
        })
        setRetryOpen(false)
    }
    const retryMessage = doc?.lastFailureCategory === 'out_of_memory'
        ? 'Retries the aggregated-lineage rebuild for this source. It may fail again until memory is freed in the graph store.'
        : 'Retries the aggregated-lineage rebuild for this source. This can take a while.'

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
                                {dsId && (
                                    <Link
                                        to={jobHistoryPath({ dataSourceId: dsId })}
                                        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                                    >
                                        Open in Job History
                                        <ArrowUpRight className="w-3 h-3" />
                                    </Link>
                                )}
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
                                        <FreshnessBadges row={doc} job={byDataSource.get(dsId ?? '')} />
                                    </div>

                                    {/* Resolution guidance — leads for a failed source. */}
                                    {(doc.aggregationStatus === 'failed' || doc.lastFailureCategory != null) && (
                                        <ResolutionGuidance
                                            doc={doc}
                                            canManage={canManage}
                                            busy={refresh.isPending}
                                            onClear={doClear}
                                            onRetry={() => setRetryOpen(true)}
                                        />
                                    )}

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
                                        <Fact label="Stored fingerprint"><span className="font-mono text-xs">{shortFp(doc.storedFingerprint)}</span></Fact>
                                    </div>

                                    {/* Cache contents (live footprint + last-known-good) */}
                                    <CacheContents doc={doc} />

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

            {/* Retry-rebuild confirm — gates the OOM "may fail again" case. */}
            <ConfirmDialog
                open={retryOpen}
                title="Retry rebuild"
                message={retryMessage}
                confirmLabel="Retry rebuild"
                confirmColor="bg-indigo-600 hover:bg-indigo-700 shadow-md"
                confirmIcon={RotateCcw}
                loading={refresh.isPending}
                onConfirm={doRetry}
                onCancel={() => setRetryOpen(false)}
            />
        </>,
        document.body,
    )
}
