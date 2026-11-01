/**
 * ResidencyPolicyCard — "Residency & eviction" (doc 17): what the capacity loop evicts and loads
 * by, changed live, with no redeploy.
 *
 * Every value shows the one in force, its default and its unit, and can be reset to the default
 * (saved as ``-1``). Each cluster master's memory is drawn as a gauge with the start and stop marks
 * on it (from the planner's preview of the values as they stand). Save first asks the planner what
 * the next pass would do with the new values — "Saving evicts 12 graphs, 9.4 GB, on master 2" — and
 * only a confirmation saves them; a value the server refuses is shown next to the field it names.
 * The card also says who changed the values last, and when, and when residency is off on this
 * deployment (``GRAPHVER_RESIDENCY_ENABLED``), in which case the values are kept but not acted on.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/primitives'
import { DateTime } from '@/components/ui/DateTime'
import {
    systemStatusService,
    type ResidencyPolicyChange,
    type ResidencyPolicyField,
    type ResidencyPreview,
    type ResidencyPreviewMaster,
} from '@/services/systemStatusService'
import { ConfirmDialog } from './ConfirmDialog'

const FIELD_CLS = 'w-24 px-2 py-1 rounded-lg border border-glass-border bg-canvas text-xs text-ink tabular-nums'
const RESET = '\u0000reset'

/** "7 days", "1 hour", "5 minutes", "45 seconds". */
function formatSecs(secs: number): string {
    const unit = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`
    if (secs >= 86400 && secs % 86400 === 0) return unit(secs / 86400, 'day')
    if (secs >= 3600 && secs % 3600 === 0) return unit(secs / 3600, 'hour')
    if (secs >= 60 && secs % 60 === 0) return unit(secs / 60, 'minute')
    return unit(secs, 'second')
}

/** Binary units, as the masters count them: "9.4 GB". */
function formatBytes(n: number | null | undefined): string {
    if (n == null) return 'unknown'
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
    let v = n
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
    }
    return i === 0 ? `${v.toLocaleString()} bytes` : `${Number(v.toFixed(1)).toLocaleString()} ${units[i]}`
}

type Kind = 'duration' | 'pct' | 'margin' | 'bytes' | 'entities' | 'seconds' | 'onoff' | 'class'

const FIELDS: { field: ResidencyPolicyField; label: string; kind: Kind; help: string }[] = [
    { field: 'evictionEnabled', label: 'Automatic eviction', kind: 'onoff',
      help: 'Off, nothing is evicted; loads and admission go on.' },
    { field: 'defaultResidency', label: 'Class of a new graph', kind: 'class',
      help: 'The class a graph gets when it is created.' },
    { field: 'standardIdleSecs', label: 'Unload unread Standard graphs after', kind: 'duration',
      help: 'From 1 hour to 365 days.' },
    { field: 'coldlineIdleSecs', label: 'Unload unread Coldline graphs after', kind: 'duration',
      help: 'From 5 minutes to 7 days, and no longer than the Standard time.' },
    { field: 'highWaterPct', label: 'Start mark', kind: 'pct',
      help: "Eviction starts when a master's memory reaches this; a load must fit under it. 50–95 %." },
    { field: 'lowWaterPct', label: 'Stop mark', kind: 'pct',
      help: 'Eviction stops here; at least 5 points under the start mark. 30–90 %.' },
    { field: 'loadMarginPct', label: 'Load headroom', kind: 'margin',
      help: 'The room a load needs over its estimate: ×1.0 to ×3.0.' },
    { field: 'bytesPerEntity', label: 'Size of an entity never measured', kind: 'bytes',
      help: 'The estimate per node or edge for a graph never measured. 100–10,000 bytes.' },
    { field: 'coldlineCanvasLoadAbove', label: 'Coldline: load on a canvas read above', kind: 'entities',
      help: 'A Coldline graph larger than this is loaded when a canvas reads it.' },
    { field: 'capacityIntervalSecs', label: 'Capacity pass every', kind: 'seconds',
      help: 'How often memory is checked and graphs evicted or loaded. 15–600 seconds.' },
]

const CLASS_LABEL: Record<string, string> = { always: 'Always', standard: 'Standard', coldline: 'Coldline' }

/** A value as people read it, in its unit. */
function shown(kind: Kind, v: number | boolean | string): string {
    switch (kind) {
        case 'duration': return formatSecs(Number(v))
        case 'pct': return `${v} %`
        case 'margin': return `×${Number(v) / 100}`
        case 'bytes': return `${Number(v).toLocaleString()} bytes`
        case 'entities': return `${Number(v).toLocaleString()} entities`
        case 'seconds': return `${Number(v).toLocaleString()} seconds`
        case 'onoff': return v ? 'On' : 'Off'
        case 'class': return CLASS_LABEL[String(v)] ?? String(v)
    }
}

/** What an input holds for a value: a margin as its multiplier, a duration in its own unit. */
const DURATION_UNITS = [{ secs: 86400, label: 'days' }, { secs: 3600, label: 'hours' }, { secs: 60, label: 'minutes' }]

function durationUnit(secs: number): number {
    return DURATION_UNITS.find(u => secs >= u.secs && secs % u.secs === 0)?.secs ?? 60
}

function inputText(kind: Kind, v: number | boolean | string, unit?: number): string {
    if (kind === 'margin') return String(Number(v) / 100)
    if (kind === 'duration') return String(Number(v) / (unit ?? durationUnit(Number(v))))
    return String(v)
}

/** The change to send for an edit, or an error to show. */
function parsed(kind: Kind, text: string, unit: number): { value?: number | boolean | string; error?: string } {
    if (text === RESET) return { value: -1 }
    if (kind === 'onoff') return { value: text === 'true' }
    if (kind === 'class') return { value: text }
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) return { error: 'Enter a number' }
    if (kind === 'margin') return { value: Math.round(n * 100) }
    if (kind === 'duration') return { value: Math.round(n * unit) }
    return { value: n }
}

type Refusal = { type?: string; field?: string; message?: string }

export function ResidencyPolicyCard() {
    const qc = useQueryClient()
    const policyQ = useQuery({
        queryKey: ['admin', 'residency-policy'],
        queryFn: systemStatusService.residencyPolicy,
        refetchOnWindowFocus: false,
    })
    const mastersQ = useQuery({
        queryKey: ['admin', 'residency-preview'],
        queryFn: () => systemStatusService.previewResidencyPolicy({}),
        refetchOnWindowFocus: false,
    })
    const [edits, setEdits] = useState<Partial<Record<ResidencyPolicyField, string>>>({})
    const [units, setUnits] = useState<Partial<Record<ResidencyPolicyField, number>>>({})
    const [errors, setErrors] = useState<Partial<Record<ResidencyPolicyField, string>>>({})
    const [confirm, setConfirm] = useState<{ change: ResidencyPolicyChange; preview: ResidencyPreview } | null>(null)
    const [pending, setPending] = useState(false)
    const [failure, setFailure] = useState<string | null>(null)

    const policy = policyQ.data

    const refused = (e: unknown): boolean => {
        const d = (e as { detail?: Refusal }).detail
        if (d?.type === 'invalid_residency_policy' && d.field) {
            setErrors({ [d.field as ResidencyPolicyField]: d.message ?? 'Not allowed' })
            setConfirm(null)
            return true
        }
        return false
    }

    const change = (): ResidencyPolicyChange | null => {
        if (!policy) return null
        const out: ResidencyPolicyChange = {}
        const bad: Partial<Record<ResidencyPolicyField, string>> = {}
        for (const { field, kind } of FIELDS) {
            const text = edits[field]
            if (text === undefined) continue
            const unit = units[field] ?? durationUnit(Number(policy.values[field].effective))
            const p = parsed(kind, text, unit)
            if (p.error) bad[field] = p.error
            else out[field] = p.value
        }
        setErrors(bad)
        return Object.keys(bad).length ? null : out
    }

    const save = async () => {
        const c = change()
        if (!c || Object.keys(c).length === 0) return
        setFailure(null)
        setPending(true)
        try {
            setConfirm({ change: c, preview: await systemStatusService.previewResidencyPolicy(c) })
        } catch (e) {
            if (!refused(e)) setFailure((e as Error).message)
        } finally {
            setPending(false)
        }
    }

    const commit = async () => {
        if (!confirm) return
        setPending(true)
        try {
            await systemStatusService.saveResidencyPolicy(confirm.change)
            setConfirm(null)
            setEdits({})
            setErrors({})
            void qc.invalidateQueries({ queryKey: ['admin', 'residency-policy'] })
            void qc.invalidateQueries({ queryKey: ['admin', 'residency-preview'] })
        } catch (e) {
            if (!refused(e)) setFailure((e as Error).message)
        } finally {
            setPending(false)
        }
    }

    if (policyQ.isLoading) {
        return <p className="px-5 py-3 text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the residency policy…</p>
    }
    if (!policy) {
        return <p className="px-5 py-3 text-xs text-red-600 dark:text-red-400">{(policyQ.error as Error | null)?.message ?? 'The residency policy could not be read.'}</p>
    }

    const marks = {
        start: Number(policy.values.highWaterPct.effective),
        stop: Number(policy.values.lowWaterPct.effective),
    }

    return (
        <section aria-label="Residency & eviction" className="mx-5 mb-4 rounded-xl border border-glass-border bg-canvas-elevated/40 p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Gauge className="w-4 h-4 text-indigo-500" />
                    <div>
                        <h3 className="text-sm font-semibold text-ink">Residency &amp; eviction</h3>
                        <p className="text-[11px] text-ink-muted">
                            {policy.updatedBy
                                ? <>Last changed by {policy.updatedBy}{policy.updatedAt && <> · <DateTime at={policy.updatedAt} variant="calendar" /></>}</>
                                : 'Never changed: every value is its default.'}
                        </p>
                    </div>
                </div>
            </div>

            {!policy.enabled && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Residency is off on this deployment (GRAPHVER_RESIDENCY_ENABLED): these values are kept, and nothing acts on them until it is turned on.
                </p>
            )}

            <MasterGauges masters={mastersQ.data?.masters ?? null} start={marks.start} stop={marks.stop} loading={mastersQ.isLoading} />

            <div className="grid gap-2">
                {FIELDS.map(({ field, label, kind, help }) => {
                    const v = policy.values[field]
                    const text = edits[field]
                    const unit = units[field] ?? durationUnit(Number(text === RESET ? v.default : v.effective))
                    const current = text === RESET ? inputText(kind, v.default, unit)
                        : text ?? inputText(kind, v.effective, unit)
                    const set = (t: string) => setEdits(prev => ({ ...prev, [field]: t }))
                    const changed = text !== undefined ? text !== RESET : v.saved !== null
                    return (
                        <div key={field} role="group" aria-label={label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
                            <div className="min-w-0">
                                <span className="text-xs font-medium text-ink">{label}</span>
                                <span className="block text-[10.5px] text-ink-muted">
                                    {help} Default: {shown(kind, v.default)}
                                </span>
                                {errors[field] && <span className="block text-[11px] text-red-600 dark:text-red-400">{errors[field]}</span>}
                            </div>
                            <div className="flex items-center gap-1.5 justify-end">
                                {kind === 'onoff' ? (
                                    <select aria-label={label} className={FIELD_CLS} value={current} onChange={e => set(e.target.value)}>
                                        <option value="true">On</option>
                                        <option value="false">Off</option>
                                    </select>
                                ) : kind === 'class' ? (
                                    <select aria-label={label} className={FIELD_CLS} value={current} onChange={e => set(e.target.value)}>
                                        {Object.entries(CLASS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                                    </select>
                                ) : (
                                    <>
                                        {kind === 'margin' && <span className="text-xs text-ink-muted">×</span>}
                                        <input
                                            type="number"
                                            aria-label={label}
                                            className={FIELD_CLS}
                                            step={kind === 'margin' ? 0.05 : 1}
                                            value={current}
                                            onChange={e => set(e.target.value)}
                                        />
                                        {kind === 'duration' ? (
                                            <select
                                                aria-label={`${label} (unit)`}
                                                className={FIELD_CLS}
                                                value={unit}
                                                onChange={e => {
                                                    setUnits(prev => ({ ...prev, [field]: Number(e.target.value) }))
                                                    if (text === undefined || text === RESET) set(current)
                                                }}
                                            >
                                                {DURATION_UNITS.map(u => <option key={u.secs} value={u.secs}>{u.label}</option>)}
                                            </select>
                                        ) : kind !== 'margin' && (
                                            <span className="text-xs text-ink-muted">
                                                {kind === 'pct' ? '%' : kind === 'bytes' ? 'bytes' : kind === 'entities' ? 'entities' : 'seconds'}
                                            </span>
                                        )}
                                    </>
                                )}
                                <button
                                    type="button"
                                    aria-label="Reset to default"
                                    disabled={!changed}
                                    onClick={() => set(RESET)}
                                    className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                                >
                                    Reset
                                </button>
                            </div>
                        </div>
                    )
                })}
            </div>

            <div className="flex items-center justify-end gap-2">
                {failure && <p className="text-[11px] text-red-600 dark:text-red-400 mr-auto">{failure}</p>}
                <Button size="sm" variant="ghost" disabled={pending || Object.keys(edits).length === 0} onClick={() => { setEdits({}); setErrors({}) }}>
                    Discard
                </Button>
                <Button size="sm" variant="primary" loading={pending && !confirm} disabled={Object.keys(edits).length === 0} onClick={save}>
                    Save
                </Button>
            </div>

            {confirm && (
                <ConfirmDialog
                    title="Save the residency policy"
                    confirmLabel="Save"
                    pending={pending}
                    error={failure}
                    onClose={() => setConfirm(null)}
                    onConfirm={commit}
                >
                    <PreviewSummary preview={confirm.preview} />
                </ConfirmDialog>
            )}
        </section>
    )
}

/** What the next pass would do with the new values: per master, what it evicts and loads. */
function PreviewSummary({ preview }: { preview: ResidencyPreview }) {
    const lines = preview.masters.flatMap(m => {
        const out: string[] = []
        if (m.evictions.length) {
            const bytes = m.evictions.reduce((n, e) => n + (e.bytes ?? 0), 0)
            out.push(`Saving evicts ${m.evictions.length} graph${m.evictions.length === 1 ? '' : 's'}, ${formatBytes(bytes)}, on master ${m.endpoint}.`)
        }
        if (m.loads.length) out.push(`It starts loading ${m.loads.length} graph${m.loads.length === 1 ? '' : 's'} on master ${m.endpoint}.`)
        return out
    })
    return (
        <div className="space-y-1">
            {lines.length ? lines.map(l => <p key={l}>{l}</p>) : <p>Saving evicts nothing now.</p>}
            <p className="text-[11px] text-ink-muted">The next capacity pass acts on the new values within a minute; reads of an evicted graph come from Postgres until it is loaded again.</p>
        </div>
    )
}

/** Each master's memory, with the start and stop marks drawn on it. */
function MasterGauges({ masters, start, stop, loading }: {
    masters: ResidencyPreviewMaster[] | null; start: number; stop: number; loading: boolean
}) {
    if (loading) return <p className="text-[11px] text-ink-muted">Reading each master's memory…</p>
    if (!masters || masters.length === 0) return <p className="text-[11px] text-ink-muted">No master holds a versioned graph.</p>
    return (
        <div className="grid gap-2">
            {masters.map(m => {
                const pct = m.usedBytes != null && m.maxBytes ? Math.round((m.usedBytes / m.maxBytes) * 100) : null
                return (
                    <div key={m.endpoint} className="text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-ink-secondary">{m.endpoint}</span>
                            <span className="text-ink-muted">
                                {m.usedBytes == null ? 'could not be read'
                                    : m.maxBytes ? `${formatBytes(m.usedBytes)} of ${formatBytes(m.maxBytes)}`
                                        : `${formatBytes(m.usedBytes)} · no memory limit`}
                                {m.hold && ` · held (${m.hold})`}
                            </span>
                        </div>
                        <div
                            role="meter"
                            aria-label={`Memory of ${m.endpoint}`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={pct ?? undefined}
                            className="relative mt-1 h-2 rounded-full bg-black/5 dark:bg-white/10 overflow-visible"
                        >
                            {pct != null && (
                                <div
                                    className={cn('h-2 rounded-full', pct >= start ? 'bg-red-500' : pct >= stop ? 'bg-amber-500' : 'bg-emerald-500')}
                                    style={{ width: `${Math.min(100, pct)}%` }}
                                />
                            )}
                            <span title={`Start mark ${start} %`} className="absolute -top-0.5 h-3 w-px bg-red-600" style={{ left: `${start}%` }} />
                            <span title={`Stop mark ${stop} %`} className="absolute -top-0.5 h-3 w-px bg-amber-600" style={{ left: `${stop}%` }} />
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
