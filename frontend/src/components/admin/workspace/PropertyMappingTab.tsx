/**
 * PropertyMappingTab — understand → configure → preview → unpack, on one screen.
 *
 * The one-screen part is load-bearing. Split across two surfaces the operator
 * has to save, navigate, check, navigate back — and the preview is the whole
 * reason they trust the change. So the storage report, the mapping editor,
 * the before/after preview and the unpack action live together, and the
 * preview re-runs as the mapping is edited.
 *
 * The preview renders both sides with the REAL PropertyEditor in the same
 * `readOnly groupByPath` mode the EntityDrawer uses, so what an operator sees
 * here is literally what the drawer will show — not a mock-up of it.
 *
 * The report itself is profiled out-of-band and served from cache: classifying
 * live would mean sampling every label on the request path, which a
 * multi-million-node graph can't afford. That makes provenance ("from a
 * profile 4h ago") part of the design rather than a footnote, and it's where
 * Re-scan lives.
 *
 * Report state lives in React Query under the SAME key PropertyStorageFinding
 * reads, so a save or a re-scan here refreshes the finding in the Alignment
 * panel instead of leaving two copies of the truth to drift apart.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
    AlertTriangle, ArrowRight, Boxes, CheckCircle2, FolderTree, Loader2,
    PackageOpen, RefreshCw, RotateCcw, Save, Search, Sparkles, Wand2, XCircle,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { useToast } from '@/components/ui/toast'
import { HelpHint } from '@/components/ui/InfoTooltip'
import { useJob } from '@/hooks/useJob'
import { aggregationService } from '@/services/aggregationService'
import { PropertyEditor } from '@/components/panels/PropertyEditor'
import {
    CoverageRing, coverageColor,
} from '@/components/admin/AssetOnboardingWizard/steps/CoverageVisuals'
import { PropertyMappingForm } from '../shared/PropertyMappingForm'
import {
    DEFAULT_PROPERTY_MAPPING,
    alignProperties,
    getPropertyStorage,
    mappingFromReport,
    previewPropertyMapping,
    rescanPropertyStorage,
    savePropertyMapping,
    type LabelStorage,
    type PropertyMapping,
    type PropertyPreview,
    type PropertyStorageReport,
} from '@/services/propertyStorageService'

export interface PropertyMappingTabProps {
    wsId: string
    dataSourceId: string
    canEdit: boolean
}

const STORAGE_META: Record<LabelStorage['storage'], {
    label: string; bar: string; text: string
}> = {
    container: {
        label: 'Nested', bar: 'bg-amber-500',
        text: 'text-amber-600 dark:text-amber-400',
    },
    mixed: {
        label: 'Mixed', bar: 'bg-amber-400',
        text: 'text-amber-600 dark:text-amber-400',
    },
    native: {
        label: 'Unpacked', bar: 'bg-emerald-500',
        text: 'text-emerald-600 dark:text-emerald-400',
    },
    empty: {
        label: 'Empty', bar: 'bg-black/10 dark:bg-white/10',
        text: 'text-ink-muted',
    },
}

function sameMapping(a: PropertyMapping, b: PropertyMapping): boolean {
    return a.containerKey === b.containerKey
        && a.separator === b.separator
        && a.collectUnmapped === b.collectUnmapped
        && JSON.stringify(a.propertyOverrides) === JSON.stringify(b.propertyOverrides)
}

function timeAgo(seconds: number | null): string {
    // A missing age is not a fresh one. Saying "just now" over a profile of
    // unknown vintage is exactly the claim provenance exists to prevent.
    if (seconds == null) return 'age unknown'
    if (seconds < 90) return 'moments ago'
    const mins = Math.round(seconds / 60)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.round(mins / 60)
    if (hours < 48) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
}

/** Node counts, one format for the whole tab: exact below 100k, then k, then M. */
function compact(n: number): string {
    if (n < 100_000) return n.toLocaleString()
    if (n < 1_000_000) return `${Math.round(n / 1000)}k`
    return `${(n / 1_000_000).toFixed(1)}M`
}

// ─── Section rhythm ────────────────────────────────────────────────────────

function Section({ icon: Icon, title, help, aside, children }: {
    icon: typeof Boxes
    title: string
    help?: React.ReactNode
    aside?: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 overflow-hidden">
            <div className="px-4 pt-3.5 pb-1 flex items-center gap-2">
                <Icon className="w-4 h-4 text-indigo-500" />
                <h4 className="text-xs font-bold text-ink">{title}</h4>
                {help && <HelpHint label={title.toLowerCase()} content={help} />}
                {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
            </div>
            {children}
        </div>
    )
}

/**
 * The worked example, built from the user's OWN keys. Every abstract
 * explanation of flattening is worse than one concrete line showing the key
 * they are actually looking at turning into the key they will get.
 */
function WorkedExample({ container, sep, path }: {
    container: string | null; sep: string; path: string | null
}) {
    // `path` is already flattened by the profiler; split it back into the two
    // halves so the "before" side reads like the nested dictionary it is.
    const [head, ...rest] = (path ?? 'technical/format').split(sep)
    const leaf = rest.join(sep) || 'format'
    const key = container ?? 'properties'

    return (
        <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono">
            <span className="px-2 py-1 rounded-md bg-black/5 dark:bg-white/5 text-ink-muted">
                {key}: {'{'} {head}: {'{'} {leaf} {'}'} {'}'}
            </span>
            <ArrowRight className="w-3 h-3 text-ink-muted shrink-0" />
            <span className="px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-semibold">
                {head}{sep}{leaf}
            </span>
            <span className="flex items-center gap-1 text-[10.5px] font-sans text-ink-muted">
                <FolderTree className="w-3 h-3" />
                shown as a folder, and searchable
            </span>
        </div>
    )
}

/**
 * Per-label row: a calm proportional bar, not a ring. One branded ring per
 * panel is the house convention (see AdoptionMatchSection) — rings in rows
 * turn a scannable table into a wall of dials.
 */
function LabelRow({ label, info, sep }: {
    label: string; info: LabelStorage; sep: string
}) {
    const meta = STORAGE_META[info.storage]
    const nestedPct = info.sampled > 0
        ? Math.round(info.containerSampled / info.sampled * 100)
        : 0

    return (
        <div className="px-3 py-2.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-center">
            <span className="font-mono text-[11px] text-ink truncate">{label}</span>
            <span className={cn('text-[10px] font-bold uppercase tracking-wide', meta.text)}>
                {meta.label}
            </span>

            <div className="h-1.5 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden flex">
                <div className={cn(meta.bar, 'transition-all duration-500')}
                     style={{ width: `${nestedPct}%` }} />
            </div>
            <span className="text-[10.5px] text-ink-muted tabular-nums whitespace-nowrap">
                {info.affectedEstimate != null && info.affectedEstimate > 0
                    ? <>≈{compact(info.affectedEstimate)} nested</>
                    : info.labelTotal != null
                        ? <>{compact(info.labelTotal)} nodes</>
                        : <>{info.sampled} sampled</>}
            </span>

            {info.inferredPaths.length > 0 && (
                <span
                    className="col-span-2 font-mono text-[10px] text-ink-muted/80 truncate"
                    title={info.inferredPaths.join(', ')}
                >
                    {info.inferredPaths.slice(0, 5).join(`, `)}
                    {info.inferredPaths.length > 5
                        ? ` +${info.inferredPaths.length - 5} more`
                        : ''}
                </span>
            )}
            {info.unparseable > 0 && (
                <span
                    className="col-span-2 text-[10px] text-amber-600 dark:text-amber-400"
                    title={`Container present but not a property dictionary. Left untouched — separator "${sep}" was never applied to it.`}
                >
                    {info.unparseable} unreadable — preserved, never unpacked
                </span>
            )}
        </div>
    )
}

// ─── Live unpack progress ──────────────────────────────────────────────────

/**
 * The run, inline. A background job the user can't see is a job they assume
 * failed; the alternative here used to be a toast pointing at Job History,
 * which is a different page in a different tab.
 */
function UnpackProgress({ dataSourceId, jobId, onDone }: {
    dataSourceId: string; jobId: string; onDone: () => void
}) {
    const { snapshot, terminal, connected } = useJob(dataSourceId, jobId)
    const [final, setFinal] = useState<{ aligned: number; processed: number; status: string } | null>(null)
    const [cancelling, setCancelling] = useState(false)

    // The SSE terminal event carries the exact figures, but useJob's snapshot
    // only maps the live-progress fields. One REST read on terminal gets them —
    // and this is the number that replaces the estimate, so it's worth the call.
    useEffect(() => {
        if (!terminal) return
        let cancelled = false
        aggregationService.getJob(dataSourceId, jobId)
            .then(job => {
                if (cancelled) return
                setFinal({
                    aligned: job.processedEdges ?? 0,
                    processed: job.totalEdges ?? 0,
                    status: job.status,
                })
                onDone()
            })
            .catch(() => { if (!cancelled) onDone() })
        return () => { cancelled = true }
    }, [terminal, dataSourceId, jobId, onDone])

    if (final) {
        const ok = final.status === 'completed'
        return (
            <div className={cn(
                'flex items-start gap-2 p-3 rounded-xl border',
                ok ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
                   : 'border-amber-500/25 bg-amber-500/[0.06]',
            )}>
                {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    : <XCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />}
                <div className="min-w-0">
                    <p className="text-xs font-bold text-ink">
                        {ok ? 'Unpack finished' : `Unpack ${final.status}`}
                    </p>
                    <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5 tabular-nums">
                        <span className="font-semibold text-ink">{final.aligned.toLocaleString()}</span>
                        {' '}node{final.aligned === 1 ? '' : 's'} unpacked across{' '}
                        <span className="font-semibold text-ink">{final.processed.toLocaleString()}</span>
                        {' '}visited — an exact count, not the sampled estimate.
                    </p>
                </div>
            </div>
        )
    }

    const pct = snapshot.progress ?? 0
    return (
        <div className="p-3 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.05]">
            <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500 shrink-0" />
                <p className="text-xs font-bold text-ink">Unpacking properties…</p>
                <span className="ml-auto text-[10.5px] text-ink-muted tabular-nums">
                    {pct}% of the ID range
                </span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all duration-500"
                     style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-2 flex items-center gap-3 text-[10.5px] text-ink-muted tabular-nums">
                <span>
                    <span className="font-semibold text-ink">
                        {(snapshot.processed_edges ?? 0).toLocaleString()}
                    </span> unpacked
                </span>
                <span>
                    <span className="font-semibold text-ink">
                        {(snapshot.total_edges ?? 0).toLocaleString()}
                    </span> visited
                </span>
                {!connected && <span className="text-amber-500">live updates dropped — still running</span>}
                <button
                    onClick={() => {
                        setCancelling(true)
                        void aggregationService.cancelJob(dataSourceId, jobId).catch(() => {})
                    }}
                    disabled={cancelling}
                    className="ml-auto font-semibold text-ink-muted hover:text-red-500 transition-colors disabled:opacity-50"
                >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
            </div>
            <p className="mt-1.5 text-[10px] text-ink-muted/80 leading-relaxed">
                Progress tracks how far through the node ID range the walk is — it
                knows that long before it knows how many nodes carry a container.
                Cancelling is safe: the run checkpoints and resumes where it stopped.
            </p>
        </div>
    )
}

// ─── Tab ───────────────────────────────────────────────────────────────────

export function PropertyMappingTab({ wsId, dataSourceId, canEdit }: PropertyMappingTabProps) {
    const { showToast } = useToast()
    const queryClient = useQueryClient()
    const storageKey = useMemo(
        () => ['property-storage', wsId, dataSourceId] as const,
        [wsId, dataSourceId],
    )

    const { data: envelope, isLoading, error: loadError } = useQuery({
        queryKey: storageKey,
        queryFn: () => getPropertyStorage(wsId, dataSourceId),
        enabled: Boolean(wsId && dataSourceId),
        staleTime: 30_000,
        // A cold source answers `computing`; poll until the profile lands so
        // the operator isn't left staring at a spinner that never resolves.
        refetchInterval: q =>
            q.state.data?.meta?.status === 'computing' ? 4_000 : false,
    })

    const [saved, setSaved] = useState<PropertyMapping>(DEFAULT_PROPERTY_MAPPING)
    const [pending, setPending] = useState<PropertyMapping>(DEFAULT_PROPERTY_MAPPING)
    const [preview, setPreview] = useState<PropertyPreview | null>(null)
    const [previewing, setPreviewing] = useState(false)
    const [saving, setSaving] = useState(false)
    const [rescanning, setRescanning] = useState(false)
    const [starting, setStarting] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [jobId, setJobId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const report: PropertyStorageReport | null = envelope?.data ?? null
    const status = envelope?.meta?.status

    // Seed the editor from whatever mapping the report says is in force. Keyed
    // on the report identity so a background refetch doesn't stomp an edit in
    // progress with the server's copy.
    useEffect(() => {
        if (!report) return
        const current = mappingFromReport(report)
        setSaved(current)
        setPending(p => (sameMapping(p, DEFAULT_PROPERTY_MAPPING) ? current : p))
    }, [report])

    // Re-preview as the mapping is edited. Debounced so typing a container key
    // doesn't fire a sampled query per keystroke.
    useEffect(() => {
        if (isLoading || !report) return
        let cancelled = false
        const timer = setTimeout(async () => {
            setPreviewing(true)
            try {
                const next = await previewPropertyMapping(wsId, dataSourceId, pending)
                if (!cancelled) setPreview(next)
            } catch {
                if (!cancelled) setPreview(null)
            } finally {
                if (!cancelled) setPreviewing(false)
            }
        }, 400)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [wsId, dataSourceId, pending, isLoading, report])

    const isDirty = !sameMapping(pending, saved)

    /** Everything that reads this profile — this tab and the Alignment panel's
     *  finding — hangs off one query key, so one invalidation refreshes both. */
    const refreshReport = useCallback(
        () => queryClient.invalidateQueries({ queryKey: storageKey }),
        [queryClient, storageKey],
    )

    const handleSave = async () => {
        if (!isDirty || saving) return
        setSaving(true)
        setError(null)
        try {
            await savePropertyMapping(wsId, dataSourceId, pending)
            setSaved(pending)
            await refreshReport()
            showToast('success', 'Mapping saved. Re-scan to refresh the report.')
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setSaving(false)
        }
    }

    const handleRescan = async () => {
        setRescanning(true)
        try {
            await rescanPropertyStorage(wsId, dataSourceId)
            // Without this the button enqueues a job and visibly does nothing.
            // The invalidated query flips to `computing` and its own poll takes
            // over from there.
            await refreshReport()
            showToast('info', 'Re-scan queued — the report updates when it finishes.')
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : 'Could not queue the re-scan.')
        } finally {
            setRescanning(false)
        }
    }

    const handleUnpack = async () => {
        setStarting(true)
        try {
            const job = await alignProperties(dataSourceId)
            setJobId(job.jobId)
            setConfirming(false)
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : 'Could not start the unpack.')
        } finally {
            setStarting(false)
        }
    }

    const derived = useMemo(() => {
        const labels = Object.values(report?.labels ?? {})
        // Weight by real node totals where they're known: a 20-node lookup table
        // and a 4M-node asset each contribute one capped sample, so averaging
        // the samples lets the small one swing the headline.
        let weighted = 0
        let weight = 0
        for (const l of labels) {
            if (l.sampled === 0) continue
            const w = l.labelTotal ?? l.sampled
            weighted += (l.sampled - l.containerSampled) / l.sampled * w
            weight += w
        }
        return {
            // Null, not 100: an unprofiled or empty graph is unknown, and a
            // full green ring is the one thing it must not claim.
            unpackedPct: weight > 0 ? Math.round(weighted / weight * 100) : null,
            detectedKeys: Array.from(new Set(labels.flatMap(l => l.containerKeys))),
            // One row per field — the same physical field usually collides on
            // several labels.
            collisions: Array.from(
                new Map(labels.flatMap(l => l.collisions).map(c => [c.field, c])).values(),
            ),
            samplePath: labels.flatMap(l => l.inferredPaths)[0] ?? null,
        }
    }, [report])

    const needsUnpacking = report?.totals.needsAlignment ?? []

    // ── Loading / cold / error ───────────────────────────────────────
    if (isLoading) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-glass-border text-xs text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Reading the cached property profile…
            </div>
        )
    }

    if (loadError && !report) {
        return (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/20">
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <div>
                    <p className="text-xs font-bold text-ink">
                        Couldn't read this source's property storage
                    </p>
                    <p className="text-[11px] text-ink-muted mt-0.5">
                        {loadError instanceof Error ? loadError.message : String(loadError)}
                    </p>
                </div>
            </div>
        )
    }

    if (!report) {
        return (
            <div className="flex items-start gap-2 p-3 rounded-xl border border-glass-border bg-canvas-elevated/50">
                <Loader2 className={cn('w-4 h-4 text-indigo-500 shrink-0 mt-0.5',
                    status === 'computing' && 'animate-spin')} />
                <div>
                    <p className="text-xs font-bold text-ink">
                        {status === 'computing'
                            ? 'Profiling this source…'
                            : 'Not profiled yet'}
                    </p>
                    <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
                        The property report is built by the insights service so a
                        large graph is never scanned while you wait. It appears
                        here once the first profile lands.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: MOTION.sectionY }}
            animate={{ opacity: 1, y: 0 }}
            transition={MOTION.sectionEntry}
            className="space-y-5"
        >
            {/* ── Orientation ─────────────────────────────────────── */}
            <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.04] px-4 py-3.5">
                <div className="flex items-center gap-2 mb-1.5">
                    <PackageOpen className="w-4 h-4 text-indigo-500" />
                    <h4 className="text-xs font-bold text-ink">What this page does</h4>
                </div>
                <p className="text-[11px] text-ink-secondary leading-relaxed mb-2.5">
                    Graphs built outside the platform usually keep every property
                    inside one dictionary on the node instead of giving each its own
                    field. Only a real field can carry an index, so those properties
                    display but stay unsearchable.{' '}
                    <span className="font-semibold text-ink">Unpacking</span> gives
                    each nested property a field of its own.
                </p>
                <WorkedExample
                    container={report.containerKey}
                    sep={report.separator}
                    path={derived.samplePath}
                />
            </div>

            {/* ── 1. Understand ───────────────────────────────────── */}
            <Section
                icon={Boxes}
                title="Property storage"
                help={
                    <>
                        How each node type in this source stores its properties, from
                        the last background profile.
                        <span className="block mt-1.5 text-ink-muted">
                            Never scanned while you wait — a multi-million-node graph
                            can't afford that on a page load.
                        </span>
                    </>
                }
                aside={
                    <>
                        <span className="text-[10px] text-ink-muted">
                            from cached profile · {timeAgo(envelope?.meta?.age_seconds ?? null)}
                        </span>
                        {/* Enqueuing a profile is a write; the server rejects it
                            without manage rights, so offering the button to a
                            viewer only buys them a 403. */}
                        {canEdit && (
                            <button
                                onClick={handleRescan}
                                disabled={rescanning}
                                title="Queue a fresh profile of this graph"
                                className="flex items-center gap-1 text-[10px] font-semibold text-indigo-500 hover:text-indigo-600 transition-colors disabled:opacity-50"
                            >
                                <RefreshCw className={cn('w-3 h-3', rescanning && 'animate-spin')} />
                                Re-scan
                            </button>
                        )}
                    </>
                }
            >
                {/* Hero: one ring + a sentence that states the consequence. */}
                <div className="px-4 py-3 flex items-center gap-4">
                    {derived.unpackedPct != null ? (
                        <CoverageRing
                            percent={derived.unpackedPct}
                            size={64}
                            stroke={4}
                            color={coverageColor(derived.unpackedPct)}
                        />
                    ) : (
                        <div className="w-16 h-16 shrink-0 rounded-full border-4 border-dashed border-glass-border flex items-center justify-center text-[10px] font-bold text-ink-muted">
                            n/a
                        </div>
                    )}
                    <div className="min-w-0">
                        {derived.unpackedPct == null ? (
                            <>
                                <p className="text-sm font-bold text-ink">Nothing sampled yet</p>
                                <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                                    No nodes turned up in the profile, so there's nothing to
                                    report either way — this is not a clean bill of health.
                                </p>
                            </>
                        ) : needsUnpacking.length > 0 ? (
                            <>
                                <p className="text-sm font-bold text-ink tabular-nums">
                                    {report.totals.affectedEstimate != null
                                        ? <>≈{compact(report.totals.affectedEstimate)} nodes
                                            {' '}keep properties nested</>
                                        : <>Some nodes keep properties nested</>}
                                </p>
                                <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                                    They display correctly, but Advanced Search can't filter
                                    on them — a nested value isn't an indexable field.
                                    Unpacking would make{' '}
                                    <span className="font-semibold text-ink tabular-nums">
                                        {report.totals.newPaths}
                                    </span>{' '}
                                    propert{report.totals.newPaths === 1 ? 'y' : 'ies'} searchable.
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="text-sm font-bold text-ink">
                                    Every property is a native field
                                </p>
                                <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                                    Nothing is nested — Advanced Search can filter on all of it.
                                </p>
                            </>
                        )}
                    </div>
                </div>

                <div className="divide-y divide-glass-border/40 border-t border-glass-border/40">
                    {Object.entries(report.labels).map(([label, info]) => (
                        <LabelRow key={label} label={label} info={info}
                                  sep={report.separator} />
                    ))}
                    {Object.keys(report.labels).length === 0 && (
                        <p className="px-4 py-3 text-[11px] text-ink-muted italic">
                            No labels found in this graph.
                        </p>
                    )}
                </div>

                <p className="px-4 py-2 text-[10px] text-ink-muted/70 border-t border-glass-border/40">
                    {report.sizedFromCache
                        ? <>Node counts are estimated from a {report.samplePerLabel}-node
                            sample per type. The unpack run reports the exact figure.</>
                        : <>Type totals aren't cached yet, so only the proportions are
                            known. Re-scan once counts land for node estimates.</>}
                </p>
            </Section>

            {/* ── 2. Configure ────────────────────────────────────── */}
            <Section
                icon={Wand2}
                title="Mapping"
                help={
                    <>
                        How the platform READS this source. Saving it changes what the
                        drawer and the API show immediately — it does not touch the
                        graph.
                        <span className="block mt-1.5 text-ink-muted">
                            Rewriting the graph is the separate Unpack step below.
                        </span>
                    </>
                }
            >
                <div className="px-4 py-3">
                    <PropertyMappingForm
                        value={pending}
                        onChange={setPending}
                        disabled={!canEdit || saving}
                        detectedContainerKeys={derived.detectedKeys}
                        collisions={derived.collisions}
                    />
                </div>
            </Section>

            {/* ── 3. Preview ──────────────────────────────────────── */}
            <Section
                icon={Search}
                title="Preview"
                help={
                    <>
                        Real nodes, read through the mapping above and rendered by the
                        very component the entity drawer uses.
                        <span className="block mt-1.5 text-ink-muted">
                            Read-only: previewing writes nothing, at any size.
                        </span>
                    </>
                }
                aside={
                    <>
                        {previewing && <Loader2 className="w-3 h-3 animate-spin text-ink-muted" />}
                        <span className="text-[10px] text-ink-muted">live · nothing is written</span>
                    </>
                }
            >
                <div className="px-4 py-3 space-y-3">
                    {preview?.samples.length ? preview.samples.slice(0, 3).map(sample => (
                        <div key={sample.urn}
                             className="rounded-xl border border-glass-border/60 p-3">
                            <p className="text-[11px] font-bold text-ink truncate mb-2">
                                {sample.displayName || sample.urn}
                                <span className="ml-1.5 font-mono font-normal text-ink-muted">
                                    {sample.label}
                                </span>
                            </p>
                            {/* Side by side on purpose — the comparison IS the
                                content. `min-w-0` on both cells and `break-all`
                                inside keep a long JSON value from forcing the
                                whole panel to scroll sideways. */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="min-w-0 rounded-lg bg-black/[0.02] dark:bg-white/[0.02] p-2">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1.5">
                                        Nested today
                                    </p>
                                    <div className="min-w-0 [&_*]:break-all">
                                        <PropertyEditor value={sample.before} onChange={() => {}}
                                                        readOnly groupByPath bare hideToolbar />
                                    </div>
                                </div>
                                <div className="min-w-0 rounded-lg bg-emerald-500/[0.04] p-2">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1.5">
                                        After unpacking
                                    </p>
                                    <div className="min-w-0 [&_*]:break-all">
                                        <PropertyEditor value={sample.after} onChange={() => {}}
                                                        readOnly groupByPath bare hideToolbar />
                                    </div>
                                </div>
                            </div>
                            {sample.newlySearchable.length > 0 && (
                                <p className="mt-2 pt-2 border-t border-glass-border/40 flex items-start gap-1.5 text-[10.5px] text-ink-muted leading-relaxed">
                                    <Sparkles className="w-3 h-3 text-indigo-500 shrink-0 mt-0.5" />
                                    <span className="min-w-0">
                                        <span className="font-bold text-ink">
                                            {sample.newlySearchable.length} become searchable
                                        </span>{' '}
                                        once unpacked:{' '}
                                        <code className="font-mono break-all">
                                            {sample.newlySearchable.slice(0, 6).join(', ')}
                                            {sample.newlySearchable.length > 6 ? '…' : ''}
                                        </code>
                                    </span>
                                </p>
                            )}
                        </div>
                    )) : (
                        <p className="text-[11px] text-ink-muted italic">
                            {previewing ? 'Sampling…' : 'No nodes available to preview.'}
                        </p>
                    )}
                </div>
            </Section>

            {error && (
                <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>
            )}

            {/* ── Save (mapping) ──────────────────────────────────── */}
            {isDirty && canEdit && (
                <div className="flex items-center justify-end gap-2 p-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/20 animate-in slide-in-from-top-1 fade-in duration-150">
                    <button
                        onClick={() => setPending(saved)}
                        disabled={saving}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                        <RotateCcw className="w-3 h-3" /> Discard
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
                    >
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" />
                                : <Save className="w-3 h-3" />}
                        {saving ? 'Saving…' : 'Save Mapping'}
                    </button>
                </div>
            )}

            {/* ── 4. Unpack (the durable fix) ─────────────────────── */}
            {jobId ? (
                <UnpackProgress
                    dataSourceId={dataSourceId}
                    jobId={jobId}
                    onDone={() => { void refreshReport() }}
                />
            ) : canEdit && needsUnpacking.length > 0 && (
                <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-4">
                    <div className="flex items-center gap-1.5">
                        <p className="text-xs font-bold text-ink">Make them searchable</p>
                        <HelpHint
                            label="unpacking"
                            content={
                                <>
                                    The mapping above changes how the graph is READ. This
                                    rewrites the graph itself, so the properties become real
                                    FalkorDB fields that indexes and Advanced Search can use.
                                    <span className="block mt-1.5 text-ink-muted">
                                        Runs in fixed-size batches over the node ID range —
                                        constant memory at any graph size.
                                    </span>
                                </>
                            }
                        />
                    </div>
                    <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                        Rewrites each node so every property above becomes a real
                        FalkorDB field. Runs in the background in fixed-size batches —
                        safe on a graph of any size — and can be cancelled and resumed
                        from Job History. Save your mapping first if you've changed it.
                    </p>

                    {/* Pre-flight — state the change in words before making it. */}
                    {confirming && (
                        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-3 space-y-2">
                            <p className="text-[11px] font-bold text-ink">Before you start</p>
                            <ul className="space-y-1 text-[11px] text-ink-secondary leading-relaxed">
                                <li className="flex gap-1.5">
                                    <span className="text-ink-muted">·</span>
                                    <span>
                                        <span className="font-semibold text-ink tabular-nums">
                                            {report.totals.newPaths}
                                        </span>{' '}
                                        new field{report.totals.newPaths === 1 ? '' : 's'} added per
                                        matching node, named{' '}
                                        <code className="font-mono">head{pending.separator}leaf</code>.
                                    </span>
                                </li>
                                <li className="flex gap-1.5">
                                    <span className="text-ink-muted">·</span>
                                    <span>
                                        <code className="font-mono">{pending.containerKey ?? '—'}</code>{' '}
                                        is removed from a node only once its contents have been
                                        written out.
                                    </span>
                                </li>
                                <li className="flex gap-1.5">
                                    <span className="text-ink-muted">·</span>
                                    <span className="tabular-nums">
                                        {report.totals.affectedEstimate != null
                                            ? <>≈{compact(report.totals.affectedEstimate)} nodes affected —
                                                estimated from a {report.samplePerLabel}-node sample per
                                                type. The run reports the exact figure.</>
                                            : <>Node totals aren't cached, so the size of this run
                                                isn't known in advance.</>}
                                    </span>
                                </li>
                                <li className="flex gap-1.5">
                                    <span className="text-ink-muted">·</span>
                                    <span>
                                        A container that isn't a readable dictionary is{' '}
                                        <span className="font-semibold text-ink">preserved and
                                        counted</span>, never stripped.
                                    </span>
                                </li>
                            </ul>
                            <div className="flex items-center gap-2 pt-0.5">
                                <button
                                    onClick={handleUnpack}
                                    disabled={starting}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:from-indigo-600 hover:to-violet-700 transition-colors disabled:opacity-40 shadow-sm"
                                >
                                    {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                              : <CheckCircle2 className="w-3.5 h-3.5" />}
                                    {starting ? 'Starting…' : 'Yes, unpack now'}
                                </button>
                                <button
                                    onClick={() => setConfirming(false)}
                                    disabled={starting}
                                    className="px-3 py-2 rounded-lg text-xs font-medium text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
                                >
                                    Not yet
                                </button>
                            </div>
                        </div>
                    )}

                    {!confirming && (
                        <button
                            onClick={() => setConfirming(true)}
                            disabled={isDirty}
                            title={isDirty ? 'Save the mapping before unpacking.' : undefined}
                            className="mt-3 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:from-indigo-600 hover:to-violet-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                        >
                            <PackageOpen className="w-3.5 h-3.5" />
                            Unpack properties
                        </button>
                    )}
                </div>
            )}
        </motion.div>
    )
}
