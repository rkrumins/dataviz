/**
 * PropertyMappingTab — configure → preview → align, on one screen.
 *
 * The one-screen part is load-bearing. Split across two surfaces the operator
 * has to save, navigate, check, navigate back — and the preview is the whole
 * reason they trust the change. So the storage report, the mapping editor,
 * the before/after preview and the align action live together, and the
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
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
    AlertTriangle, Boxes, CheckCircle2, Loader2, RefreshCw, RotateCcw,
    Save, Search, Sparkles, Wand2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { useToast } from '@/components/ui/toast'
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
    type StorageEnvelope,
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
        label: 'Aligned', bar: 'bg-emerald-500',
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
    if (seconds == null) return 'just now'
    if (seconds < 90) return 'moments ago'
    const mins = Math.round(seconds / 60)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.round(mins / 60)
    if (hours < 48) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
}

/** Compact number for headline stats — 12,043 stays exact, 1.2M doesn't need to be. */
function compact(n: number): string {
    if (n < 10_000) return n.toLocaleString()
    if (n < 1_000_000) return `${Math.round(n / 1000)}k`
    return `${(n / 1_000_000).toFixed(1)}M`
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
                    {info.unparseable} unreadable — preserved, not aligned
                </span>
            )}
        </div>
    )
}

export function PropertyMappingTab({ wsId, dataSourceId, canEdit }: PropertyMappingTabProps) {
    const { showToast } = useToast()
    const [envelope, setEnvelope] = useState<StorageEnvelope | null>(null)
    const [saved, setSaved] = useState<PropertyMapping>(DEFAULT_PROPERTY_MAPPING)
    const [pending, setPending] = useState<PropertyMapping>(DEFAULT_PROPERTY_MAPPING)
    const [preview, setPreview] = useState<PropertyPreview | null>(null)
    const [loading, setLoading] = useState(true)
    const [previewing, setPreviewing] = useState(false)
    const [saving, setSaving] = useState(false)
    const [rescanning, setRescanning] = useState(false)
    const [aligning, setAligning] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const report: PropertyStorageReport | null = envelope?.data ?? null
    const status = envelope?.meta?.status

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const next = await getPropertyStorage(wsId, dataSourceId)
            setEnvelope(next)
            if (next.data) {
                const current = mappingFromReport(next.data)
                setSaved(current)
                setPending(current)
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [wsId, dataSourceId])

    useEffect(() => { void load() }, [load])

    // Re-preview as the mapping is edited. Debounced so typing a container key
    // doesn't fire a sampled query per keystroke.
    useEffect(() => {
        if (loading || error) return
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
    }, [wsId, dataSourceId, pending, loading, error])

    const isDirty = !sameMapping(pending, saved)

    const handleSave = async () => {
        if (!isDirty || saving) return
        setSaving(true)
        setError(null)
        try {
            await savePropertyMapping(wsId, dataSourceId, pending)
            setSaved(pending)
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
            showToast('info', 'Re-scan queued — the report updates when it finishes.')
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : 'Could not queue the re-scan.')
        } finally {
            setRescanning(false)
        }
    }

    const handleAlign = async () => {
        setAligning(true)
        try {
            await alignProperties(dataSourceId)
            showToast('success', 'Alignment started — follow it in Job History.')
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : 'Could not start the alignment.')
        } finally {
            setAligning(false)
        }
    }

    const derived = useMemo(() => {
        const labels = Object.values(report?.labels ?? {})
        const sampled = labels.reduce((n, l) => n + l.sampled, 0)
        const nested = labels.reduce((n, l) => n + l.containerSampled, 0)
        return {
            alignedPct: sampled > 0
                ? Math.round((sampled - nested) / sampled * 100)
                : 100,
            detectedKeys: Array.from(new Set(labels.flatMap(l => l.containerKeys))),
            // One row per field — the same physical field usually collides on
            // several labels.
            collisions: Array.from(
                new Map(labels.flatMap(l => l.collisions).map(c => [c.field, c])).values(),
            ),
        }
    }, [report])

    const needsAlignment = report?.totals.needsAlignment ?? []

    // ── Loading / cold / error ───────────────────────────────────────
    if (loading) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-glass-border text-xs text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Reading the cached property profile…
            </div>
        )
    }

    if (error && !report) {
        return (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/20">
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <div>
                    <p className="text-xs font-bold text-ink">
                        Couldn't read this source's property storage
                    </p>
                    <p className="text-[11px] text-ink-muted mt-0.5">{error}</p>
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
            {/* ── Report card ─────────────────────────────────────── */}
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 overflow-hidden">
                <div className="px-4 pt-3.5 pb-1 flex items-center gap-2">
                    <Boxes className="w-4 h-4 text-indigo-500" />
                    <h4 className="text-xs font-bold text-ink">Property storage</h4>
                    <div className="ml-auto flex items-center gap-2">
                        <span className="text-[10px] text-ink-muted">
                            from cached profile · {timeAgo(envelope?.meta?.age_seconds ?? null)}
                        </span>
                        <button
                            onClick={handleRescan}
                            disabled={rescanning}
                            title="Queue a fresh profile of this graph"
                            className="flex items-center gap-1 text-[10px] font-semibold text-indigo-500 hover:text-indigo-600 transition-colors disabled:opacity-50"
                        >
                            <RefreshCw className={cn('w-3 h-3', rescanning && 'animate-spin')} />
                            Re-scan
                        </button>
                    </div>
                </div>

                {/* Hero: one ring + a sentence that states the consequence. */}
                <div className="px-4 py-3 flex items-center gap-4">
                    <CoverageRing
                        percent={derived.alignedPct}
                        size={64}
                        stroke={4}
                        color={coverageColor(derived.alignedPct)}
                    />
                    <div className="min-w-0">
                        {needsAlignment.length > 0 ? (
                            <>
                                <p className="text-sm font-bold text-ink">
                                    {report.totals.affectedEstimate != null
                                        ? <>≈{report.totals.affectedEstimate.toLocaleString()} nodes
                                            {' '}store properties in a container</>
                                        : <>Some nodes store properties in a container</>}
                                </p>
                                <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                                    They display correctly, but Advanced Search can't filter
                                    on them — a nested value isn't an indexable field.
                                    Aligning would make{' '}
                                    <span className="font-semibold text-ink">
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
                                    Nothing is trapped in a container — Advanced Search can
                                    filter on all of it.
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
                            sample per type. The alignment run reports the exact figure.</>
                        : <>Type totals aren't cached yet, so only the proportions are
                            known. Re-scan once counts land for node estimates.</>}
                </p>
            </div>

            {/* ── Mapping editor ──────────────────────────────────── */}
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 overflow-hidden">
                <div className="px-4 pt-3.5 pb-1 flex items-center gap-2">
                    <Wand2 className="w-4 h-4 text-indigo-500" />
                    <h4 className="text-xs font-bold text-ink">Mapping</h4>
                </div>
                <div className="px-4 py-3">
                    <PropertyMappingForm
                        value={pending}
                        onChange={setPending}
                        disabled={!canEdit || saving}
                        detectedContainerKeys={derived.detectedKeys}
                        collisions={derived.collisions}
                    />
                </div>
            </div>

            {/* ── Preview ─────────────────────────────────────────── */}
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated/50 overflow-hidden">
                <div className="px-4 pt-3.5 pb-1 flex items-center gap-2">
                    <Search className="w-4 h-4 text-indigo-500" />
                    <h4 className="text-xs font-bold text-ink">Preview</h4>
                    {previewing && (
                        <Loader2 className="w-3 h-3 animate-spin text-ink-muted" />
                    )}
                    <span className="ml-auto text-[10px] text-ink-muted">
                        live · nothing is written
                    </span>
                </div>
                <p className="px-4 text-[11px] text-ink-muted leading-relaxed">
                    Real nodes from this graph, rendered by the same component the
                    entity drawer uses — so this is exactly how they will look.
                </p>

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
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1">
                                        Now
                                    </p>
                                    <PropertyEditor value={sample.before} onChange={() => {}}
                                                    readOnly groupByPath bare />
                                </div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 mb-1">
                                        With this mapping
                                    </p>
                                    <PropertyEditor value={sample.after} onChange={() => {}}
                                                    readOnly groupByPath bare />
                                </div>
                            </div>
                            {sample.newlySearchable.length > 0 && (
                                <p className="mt-2 pt-2 border-t border-glass-border/40 flex items-start gap-1.5 text-[10.5px] text-ink-muted leading-relaxed">
                                    <Sparkles className="w-3 h-3 text-indigo-500 shrink-0 mt-0.5" />
                                    <span>
                                        <span className="font-bold text-ink">
                                            {sample.newlySearchable.length} become searchable
                                        </span>{' '}
                                        once aligned:{' '}
                                        <code className="font-mono">
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
            </div>

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

            {/* ── Align (the durable fix) ─────────────────────────── */}
            {canEdit && needsAlignment.length > 0 && (
                <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-4">
                    <p className="text-xs font-bold text-ink">Make them searchable</p>
                    <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">
                        Rewrites each node so every property above becomes a real
                        FalkorDB field. Runs in the background in fixed-size batches —
                        safe on a graph of any size — and can be cancelled and resumed
                        from Job History. Save your mapping first if you've changed it.
                    </p>
                    <button
                        onClick={handleAlign}
                        disabled={aligning || isDirty}
                        title={isDirty ? 'Save the mapping before aligning.' : undefined}
                        className="mt-3 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:from-indigo-600 hover:to-violet-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                    >
                        {aligning ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : <CheckCircle2 className="w-3.5 h-3.5" />}
                        {aligning ? 'Starting…' : 'Align properties'}
                    </button>
                </div>
            )}
        </motion.div>
    )
}
