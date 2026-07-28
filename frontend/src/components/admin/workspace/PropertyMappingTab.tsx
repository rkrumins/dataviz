/**
 * PropertyMappingTab — configure → preview → save, on one screen.
 *
 * The one-screen part is load-bearing. Split across two surfaces the operator
 * has to save, navigate, check, navigate back — and the preview is the whole
 * reason they trust the change. So the storage report, the mapping editor and
 * the before/after preview live together, and the preview re-runs as the
 * mapping is edited.
 *
 * The preview renders both sides with the REAL PropertyEditor in the same
 * `readOnly groupByPath` mode the EntityDrawer uses, so what an operator sees
 * here is literally what the drawer will show — not a mock-up of it.
 */
import { useCallback, useEffect, useState } from 'react'
import {
    AlertTriangle, Boxes, CheckCircle2, Loader2, RotateCcw, Save, Search,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { PropertyEditor } from '@/components/panels/PropertyEditor'
import { PropertyMappingForm } from '../shared/PropertyMappingForm'
import {
    DEFAULT_PROPERTY_MAPPING,
    getPropertyStorage,
    mappingFromReport,
    previewPropertyMapping,
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

const STORAGE_STYLE: Record<LabelStorage['storage'], { label: string; cls: string }> = {
    container: { label: 'Nested', cls: 'text-amber-600 dark:text-amber-400 bg-amber-500/10' },
    mixed: { label: 'Mixed', cls: 'text-amber-600 dark:text-amber-400 bg-amber-500/10' },
    native: { label: 'Aligned', cls: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10' },
    empty: { label: 'Empty', cls: 'text-ink-muted bg-black/5 dark:bg-white/5' },
}

function sameMapping(a: PropertyMapping, b: PropertyMapping): boolean {
    return a.containerKey === b.containerKey
        && a.separator === b.separator
        && a.collectUnmapped === b.collectUnmapped
        && JSON.stringify(a.propertyOverrides) === JSON.stringify(b.propertyOverrides)
}

export function PropertyMappingTab({ wsId, dataSourceId, canEdit }: PropertyMappingTabProps) {
    const [report, setReport] = useState<PropertyStorageReport | null>(null)
    const [saved, setSaved] = useState<PropertyMapping>(DEFAULT_PROPERTY_MAPPING)
    const [pending, setPending] = useState<PropertyMapping>(DEFAULT_PROPERTY_MAPPING)
    const [preview, setPreview] = useState<PropertyPreview | null>(null)
    const [loading, setLoading] = useState(true)
    const [previewing, setPreviewing] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const next = await getPropertyStorage(wsId, dataSourceId)
            setReport(next)
            const current = mappingFromReport(next)
            setSaved(current)
            setPending(current)
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
            // Re-read: the saved mapping changes how the graph is classified.
            await load()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setSaving(false)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center gap-2 py-8 text-xs text-ink-muted">
                <Loader2 className="w-4 h-4 animate-spin" /> Sampling the graph…
            </div>
        )
    }

    if (error && !report) {
        return (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <div>
                    <p className="text-xs font-semibold text-red-600 dark:text-red-400">
                        Couldn't read this source's property storage
                    </p>
                    <p className="text-[11px] text-ink-muted mt-0.5">{error}</p>
                </div>
            </div>
        )
    }

    const needsAlignment = report?.totals.needsAlignment ?? []
    const detectedKeys = Array.from(new Set(
        Object.values(report?.labels ?? {}).flatMap(l => l.containerKeys),
    ))
    const allCollisions = Object.values(report?.labels ?? {}).flatMap(l => l.collisions)
    // One row per field — the same physical field usually collides on several labels.
    const collisions = Array.from(
        new Map(allCollisions.map(c => [c.field, c])).values(),
    )

    return (
        <div className="space-y-6">
            {/* ── Verdict ───────────────────────────────────────────── */}
            {needsAlignment.length > 0 ? (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/20">
                    <Boxes className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                            {report?.totals.affectedNodes.toLocaleString()} nodes store their
                            properties in a nested container
                        </p>
                        <p className="text-[11px] text-amber-600/80 dark:text-amber-400/80 mt-0.5 leading-relaxed">
                            They display correctly, but Advanced Search can't filter on them —
                            a nested value isn't an indexable field. Unpacking would produce{' '}
                            {report?.totals.newPaths} searchable propert
                            {report?.totals.newPaths === 1 ? 'y' : 'ies'}.
                        </p>
                    </div>
                </div>
            ) : (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/20">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                        Every sampled label stores its properties as native fields.
                    </p>
                </div>
            )}

            {/* ── Per-label report ──────────────────────────────────── */}
            <div>
                <h4 className="text-xs font-semibold text-ink mb-2">Storage by type</h4>
                <div className="rounded-lg border border-glass-border divide-y divide-glass-border/40">
                    {Object.entries(report?.labels ?? {}).map(([label, info]) => (
                        <div key={label} className="flex items-center gap-3 px-3 py-2 text-[11px]">
                            <span className="font-mono text-ink truncate w-32 shrink-0">{label}</span>
                            <span className={cn(
                                'px-1.5 py-0.5 rounded font-semibold shrink-0',
                                STORAGE_STYLE[info.storage].cls,
                            )}>
                                {STORAGE_STYLE[info.storage].label}
                            </span>
                            <span className="text-ink-muted tabular-nums shrink-0 w-20 text-right">
                                {info.affectedNodes > 0
                                    ? `${info.affectedNodes.toLocaleString()} nodes`
                                    : `${info.sampled} sampled`}
                            </span>
                            <span
                                className="font-mono text-ink-muted truncate flex-1"
                                title={info.inferredPaths.join(', ')}
                            >
                                {info.inferredPaths.slice(0, 4).join(', ')}
                                {info.inferredPaths.length > 4
                                    ? ` +${info.inferredPaths.length - 4}`
                                    : ''}
                            </span>
                            {info.unparseable > 0 && (
                                <span
                                    className="text-amber-600 dark:text-amber-400 shrink-0"
                                    title="Container present but not a property dictionary — left untouched."
                                >
                                    {info.unparseable} unreadable
                                </span>
                            )}
                        </div>
                    ))}
                    {Object.keys(report?.labels ?? {}).length === 0 && (
                        <div className="px-3 py-3 text-[11px] text-ink-muted italic">
                            No labels found in this graph.
                        </div>
                    )}
                </div>
            </div>

            {/* ── Mapping editor ────────────────────────────────────── */}
            <div className="pt-2 border-t border-glass-border">
                <h4 className="text-xs font-semibold text-ink mb-3">Property mapping</h4>
                <PropertyMappingForm
                    value={pending}
                    onChange={setPending}
                    disabled={!canEdit || saving}
                    detectedContainerKeys={detectedKeys}
                    collisions={collisions}
                />
            </div>

            {/* ── Preview ───────────────────────────────────────────── */}
            <div className="pt-2 border-t border-glass-border">
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-ink mb-1">
                    <Search className="w-3.5 h-3.5 text-ink-muted" />
                    Preview
                    {previewing && <Loader2 className="w-3 h-3 animate-spin text-ink-muted" />}
                </h4>
                <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
                    Real nodes from this graph, rendered exactly as the entity drawer will
                    show them. Nothing is written.
                </p>

                {preview?.samples.length ? (
                    <div className="space-y-4">
                        {preview.samples.slice(0, 3).map(sample => (
                            <div key={sample.urn} className="rounded-lg border border-glass-border p-3">
                                <p className="text-[11px] font-semibold text-ink truncate mb-2">
                                    {sample.displayName || sample.urn}
                                    <span className="ml-1.5 font-mono font-normal text-ink-muted">
                                        {sample.label}
                                    </span>
                                </p>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-1">
                                            Now
                                        </p>
                                        <PropertyEditor
                                            value={sample.before}
                                            onChange={() => {}}
                                            readOnly
                                            groupByPath
                                            bare
                                        />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400 mb-1">
                                            With this mapping
                                        </p>
                                        <PropertyEditor
                                            value={sample.after}
                                            onChange={() => {}}
                                            readOnly
                                            groupByPath
                                            bare
                                        />
                                    </div>
                                </div>
                                {sample.nativeAfter.length > 0 && (
                                    <p className="mt-2 pt-2 border-t border-glass-border/40 text-[10.5px] text-ink-muted leading-relaxed">
                                        <span className="font-semibold text-ink">
                                            {sample.nativeAfter.length} searchable
                                        </span>{' '}
                                        once aligned:{' '}
                                        <code className="font-mono">
                                            {sample.nativeAfter.slice(0, 6).join(', ')}
                                            {sample.nativeAfter.length > 6 ? '…' : ''}
                                        </code>
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-[11px] text-ink-muted italic">
                        {previewing ? 'Sampling…' : 'No nodes available to preview.'}
                    </p>
                )}
            </div>

            {error && report && (
                <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>
            )}

            {/* ── Save / Discard ────────────────────────────────────── */}
            {isDirty && canEdit && (
                <div className="flex items-center justify-end gap-2 p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 animate-in slide-in-from-top-1 fade-in duration-150">
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
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
                    >
                        {saving
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <Save className="w-3 h-3" />}
                        {saving ? 'Saving…' : 'Save Mapping'}
                    </button>
                </div>
            )}
        </div>
    )
}
