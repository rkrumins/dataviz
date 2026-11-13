/**
 * BuildPolicyCard — "New-version builds" (doc 14 §6): when and how a versioned graph's next version
 * is built in a second key while the key that serves it keeps serving, then switched to, and the
 * pacing and Postgres limits that keep reads served while a graph is written, changed live, with no
 * redeploy.
 *
 * The settings are the server's (``fields``), grouped by section. Each shows the value in force, its
 * default and whether it is set here, and can be reset to the default (saved as ``-1``); a value out
 * of its range is refused before it is sent. Save first lists each change, from → to, and only a
 * confirmation saves them; a value the server refuses is shown next to the field it names. The card
 * also says who changed the values last, and when, and whether the New-version builds switch
 * (Admin → Features) is on.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/primitives'
import { DateTime } from '@/components/ui/DateTime'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { systemStatusService, type BuildPolicyField } from '@/services/systemStatusService'
import { ConfirmDialog } from './ConfirmDialog'

const FIELD_CLS = 'w-24 px-2 py-1 rounded-lg border border-glass-border bg-canvas text-xs text-ink tabular-nums'
const CHIP_CLS = 'inline-flex px-1.5 py-px rounded-full border text-[9px] uppercase tracking-wide shrink-0'
const RESET = '\u0000reset'

type Unit = NonNullable<BuildPolicyField['unit']>
type Value = number | boolean | string

const SECTIONS: Record<BuildPolicyField['section'], string> = {
    when: 'When to build beside',
    room: 'Room and copies',
    lifecycle: 'Lifecycle',
    pacing: 'Pacing projector writes',
    postgres: 'Reads from Postgres',
}

const CHOICE_LABEL: Record<string, string> = {
    auto: 'Copy if room, else seed from Postgres',
    copy: 'Copy only',
    reseed: 'Seed from Postgres',
    wait: 'Wait, keep serving the current version',
    in_place: 'Write in place, paced',
}

/** The units a size or a duration is entered in, largest first. */
const SCALES: Partial<Record<Unit, { size: number; label: string }[]>> = {
    bytes: [{ size: 1024 ** 4, label: 'TB' }, { size: 1024 ** 3, label: 'GB' }, { size: 1024 ** 2, label: 'MB' }],
    secs: [{ size: 3600, label: 'h' }, { size: 60, label: 'min' }, { size: 1, label: 's' }],
}

/** The unit after an input that has no unit selector. */
const UNIT_TEXT: Partial<Record<Unit, string>> = { rows: 'rows', pct: '%', ms: 'ms' }

/** "1 row", "200,000 rows". */
function plural(n: number, one: string): string {
    return `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`
}

/** "1 hour", "30 minutes", "45 seconds". */
function formatSecs(secs: number): string {
    if (secs >= 3600 && secs % 3600 === 0) return plural(secs / 3600, 'hour')
    if (secs >= 60 && secs % 60 === 0) return plural(secs / 60, 'minute')
    return plural(secs, 'second')
}

/** Binary units, as the masters count them: "2 GB". */
function formatBytes(n: number): string {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
    let v = n
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
    }
    return i === 0 ? `${v.toLocaleString()} bytes` : `${Number(v.toFixed(1)).toLocaleString()} ${units[i]}`
}

/** A value as people read it, in its unit. */
function shown(f: BuildPolicyField, v: Value): string {
    if (f.kind === 'bool') return v ? 'On' : 'Off'
    if (f.kind === 'choice') return CHOICE_LABEL[String(v)] ?? String(v)
    const n = Number(v)
    switch (f.unit) {
        case 'bytes': return formatBytes(n)
        case 'secs': return formatSecs(n)
        case 'pct': return `${n} %`
        case 'rows': return plural(n, 'row')
        case 'ms': return `${n.toLocaleString()} ms`
        default: return n.toLocaleString()
    }
}

/** The unit a size or a duration shows in: the largest it is a whole number of, else the smallest. */
function scaleOf(f: BuildPolicyField, n: number): number {
    const scales = f.unit ? SCALES[f.unit] : undefined
    if (!scales) return 1
    return scales.find(s => n >= s.size && n % s.size === 0)?.size ?? scales[scales.length - 1].size
}

/** What an input holds for a value: a size or a duration in its unit. */
function inputText(v: Value, scale: number): string {
    return typeof v === 'number' ? String(v / scale) : String(v)
}

/** The value to send for an edit, or why it can't be sent: in its range, as the server checks. */
function parsed(f: BuildPolicyField, text: string, scale: number): { value: Value } | { error: string } {
    if (text === RESET) return { value: -1 }
    if (f.kind === 'bool') return { value: text === 'true' }
    if (f.kind === 'choice') return { value: text }
    const n = Number(text) * scale
    if (text.trim() === '' || !Number.isFinite(n)) return { error: 'Enter a number' }
    if (f.kind === 'int' && scale === 1 && !Number.isInteger(n)) return { error: 'Enter a whole number' }
    const value = f.kind === 'int' ? Math.round(n) : n
    if (f.min != null && f.max != null && (value < f.min || value > f.max)) {
        return { error: `Enter a value from ${shown(f, f.min)} to ${shown(f, f.max)}` }
    }
    return { value }
}

type Refusal = { type?: string; field?: string; message?: string }

export function BuildPolicyCard() {
    const qc = useQueryClient()
    const policyQ = useQuery({
        queryKey: ['admin', 'build-policy'],
        queryFn: systemStatusService.buildPolicy,
        refetchOnWindowFocus: false,
    })
    const [edits, setEdits] = useState<Record<string, string | undefined>>({})
    const [units, setUnits] = useState<Record<string, number>>({})
    const [errors, setErrors] = useState<Record<string, string>>({})
    const [confirm, setConfirm] = useState<Record<string, Value> | null>(null)
    const [pending, setPending] = useState(false)
    const [failure, setFailure] = useState<string | null>(null)

    const policy = policyQ.data

    const refused = (e: unknown): boolean => {
        const d = (e as { detail?: Refusal }).detail
        if (d?.type === 'invalid_build_policy' && d.field) {
            setErrors({ [d.field]: d.message ?? 'Not allowed' })
            setConfirm(null)
            return true
        }
        return false
    }

    /** The edits that change a value, or null when one can't be sent (its error is shown by it). */
    const change = (): Record<string, Value> | null => {
        if (!policy) return null
        const out: Record<string, Value> = {}
        const bad: Record<string, string> = {}
        for (const f of policy.fields) {
            const text = edits[f.wire]
            if (text === undefined) continue
            const v = policy.values[f.wire]
            const p = parsed(f, text, units[f.wire] ?? scaleOf(f, Number(v.effective)))
            if ('error' in p) bad[f.wire] = p.error
            else if (text === RESET || p.value !== v.effective) out[f.wire] = p.value
        }
        setErrors(bad)
        return Object.keys(bad).length ? null : out
    }

    const save = () => {
        const c = change()
        if (!c) return
        if (Object.keys(c).length === 0) {
            setEdits({})   // every edit puts back the value in force
            return
        }
        setFailure(null)
        setConfirm(c)
    }

    const commit = async () => {
        if (!confirm) return
        setPending(true)
        try {
            await systemStatusService.saveBuildPolicy(confirm)
            setConfirm(null)
            setEdits({})
            setErrors({})
            void qc.invalidateQueries({ queryKey: ['admin', 'build-policy'] })
        } catch (e) {
            if (!refused(e)) setFailure((e as Error).message)
        } finally {
            setPending(false)
        }
    }

    if (policyQ.isLoading) {
        return <p className="px-5 py-3 text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the New-version build settings…</p>
    }
    if (!policy) {
        return <p className="px-5 py-3 text-xs text-red-600 dark:text-red-400">{(policyQ.error as Error | null)?.message ?? 'The New-version build settings could not be read.'}</p>
    }

    const dirty = Object.values(edits).some(t => t !== undefined)

    return (
        <section aria-label="New-version builds" className="mx-5 mb-4 rounded-xl border border-glass-border bg-canvas-elevated/40 p-4 space-y-4">
            <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-500" />
                <div>
                    <h3 className="text-sm font-semibold text-ink">New-version builds</h3>
                    <p className="text-[11px] text-ink-muted">
                        {policy.updatedBy
                            ? <>Last changed by {policy.updatedBy}{policy.updatedAt && <> · <DateTime at={policy.updatedAt} variant="calendar" /></>}</>
                            : 'Never changed: every value is its default.'}
                    </p>
                </div>
            </div>

            {policy.enabled
                ? <p className="text-[11px] text-ink-muted">On</p>
                : (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                        New-version builds is off — turn it on under{' '}
                        <Link to="/admin/features" className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">Admin → Features</Link>
                    </p>
                )}

            {Object.entries(SECTIONS).map(([section, title]) => {
                const fields = policy.fields.filter(f => f.section === section)
                return fields.length > 0 && (
                    <div key={section} role="group" aria-labelledby={`build-policy-${section}`} className="grid gap-2">
                        <h4 id={`build-policy-${section}`} className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-muted">{title}</h4>
                        {fields.map(f => {
                            const v = policy.values[f.wire]
                            const text = edits[f.wire]
                            const scale = units[f.wire] ?? scaleOf(f, Number(text === RESET ? v.default : v.effective))
                            const current = text === RESET ? inputText(v.default, scale) : text ?? inputText(v.effective, scale)
                            const set = (t: string | undefined) => setEdits(prev => ({ ...prev, [f.wire]: t }))
                            const changed = text !== undefined ? text !== RESET : v.saved !== null
                            const setHere = v.saved !== null && v.saved !== v.default
                            const scales = f.unit ? SCALES[f.unit] : undefined
                            const unitText = f.unit ? UNIT_TEXT[f.unit] : undefined
                            return (
                                <div key={f.wire} role="group" aria-label={f.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
                                    <div className="min-w-0">
                                        <span className="text-xs font-medium text-ink">{f.label}</span>{' '}
                                        <span className={cn(CHIP_CLS, setHere
                                            ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                                            : 'border-glass-border bg-black/5 dark:bg-white/5 text-ink-muted')}
                                        >
                                            {setHere ? 'Set here' : 'Default'}
                                        </span>
                                        <span className="block text-[10.5px] text-ink-muted">
                                            {f.help} Default: {shown(f, v.default)}
                                        </span>
                                        {errors[f.wire] && <span className="block text-[11px] text-red-600 dark:text-red-400">{errors[f.wire]}</span>}
                                    </div>
                                    <div className="flex items-center gap-1.5 justify-end">
                                        {f.kind === 'bool' ? (
                                            <ToggleSwitch size="sm" aria-label={f.label} checked={current === 'true'} onChange={on => set(String(on))} />
                                        ) : f.kind === 'choice' ? (
                                            <select aria-label={f.label} className={cn(FIELD_CLS, 'w-auto')} value={current} onChange={e => set(e.target.value)}>
                                                {(f.choices ?? []).map(c => <option key={c} value={c}>{CHOICE_LABEL[c] ?? c}</option>)}
                                            </select>
                                        ) : (
                                            <>
                                                <input
                                                    type="number"
                                                    aria-label={f.label}
                                                    className={FIELD_CLS}
                                                    step={f.kind === 'ratio' ? 0.05 : 1}
                                                    value={current}
                                                    onChange={e => set(e.target.value)}
                                                />
                                                {scales ? (
                                                    <select
                                                        aria-label={`${f.label} (unit)`}
                                                        className={FIELD_CLS}
                                                        value={scale}
                                                        onChange={e => {
                                                            // The same value in the new unit: an untouched value only shows
                                                            // in it, an edit is converted.
                                                            const next = Number(e.target.value)
                                                            setUnits(prev => ({ ...prev, [f.wire]: next }))
                                                            if (text !== undefined && text !== RESET && text.trim() !== '' && !Number.isNaN(Number(text))) {
                                                                set(String(Number(text) * scale / next))
                                                            }
                                                        }}
                                                    >
                                                        {scales.map(s => <option key={s.size} value={s.size}>{s.label}</option>)}
                                                    </select>
                                                ) : unitText && <span className="text-xs text-ink-muted">{unitText}</span>}
                                            </>
                                        )}
                                        <button
                                            type="button"
                                            aria-label="Reset to default"
                                            disabled={!changed}
                                            onClick={() => set(v.saved === null ? undefined : RESET)}
                                            className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                                        >
                                            Reset
                                        </button>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                )
            })}

            <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={pending || !dirty} onClick={() => { setEdits({}); setErrors({}) }}>
                    Discard
                </Button>
                <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>
                    Save
                </Button>
            </div>

            {confirm && (
                <ConfirmDialog
                    title="Save the New-version build settings"
                    confirmLabel="Save"
                    pending={pending}
                    error={failure}
                    onClose={() => { setConfirm(null); setFailure(null) }}
                    onConfirm={commit}
                >
                    <ul className="space-y-1.5">
                        {policy.fields.filter(f => f.wire in confirm).map(f => {
                            const v = policy.values[f.wire]
                            const to = confirm[f.wire]
                            return (
                                <li key={f.wire}>
                                    <span className="font-medium text-ink">{f.label}</span>: {shown(f, v.effective)} → {to === -1 ? `${shown(f, v.default)} (default)` : shown(f, to)}
                                    {f.applies === 'next' && <span className="block text-[11px] text-ink-muted">Builds already under way keep their settings.</span>}
                                </li>
                            )
                        })}
                    </ul>
                </ConfirmDialog>
            )}
        </section>
    )
}
