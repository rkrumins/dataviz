/**
 * The profiling policy, edited where it is felt.
 *
 * READABLE BY ANYONE WHO CAN READ PROFILING, writable by platform admins. A
 * policy someone cannot change is still one they need to see: it is the answer
 * to "why does my window stop there", and hiding it turns a deliberate
 * retention boundary into apparent data loss. The previous version gated the
 * READ at `system:admin` while showing the control to everyone, which gave
 * every non-admin a permanent spinner and a global access-denied modal.
 *
 * BLANK MEANS INHERIT. Each field shows the deployment default as its
 * placeholder and sends `-1` when cleared, so a no-op save round-trips the
 * real default instead of pinning whatever it happened to be that day.
 *
 * The CADENCES are shown and not editable. Compaction interval decides how
 * hard the service works, and the purge cannot delete raw beyond the
 * compaction watermark — a live-editable compact interval is a way to stall
 * retention from a settings page.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Info, Loader2, TriangleAlert, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { profilingService } from '@/services/profilingService'
import { PROFILING_KEY, useProfilingPolicy } from '@/hooks/useProfiling'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import { Segmented } from './BoardFilters'
import { INHERIT_DEFAULT, type ProfilingPolicy } from '@/types/profiling'
import {
    RetentionSummary, RetentionTimeline, StorageEstimate, type Tiers,
} from './RetentionTimeline'

type Draft = Record<string, string>

/** Ordered so the tiers read as the nesting the backend enforces. */
const RETENTION_FIELDS: {
    key: keyof ProfilingPolicy & string
    label: string
    unit: string
    help: string
}[] = [
    {
        key: 'rawRetentionDays', label: 'Raw observations', unit: 'days',
        help: 'Full resolution. What the 24-hour view reads.',
    },
    {
        key: 'hourlyRetentionDays', label: 'Hourly buckets', unit: 'days',
        help: 'The audit tier. Keep at or above your retention obligation.',
    },
    {
        key: 'dailyRetentionDays', label: 'Daily buckets', unit: 'days',
        help: 'One row per source per day — a long window costs almost nothing.',
    },
    {
        key: 'maxRowsPerSource', label: 'Raw rows per source', unit: 'rows',
        help: 'Safety valve against one source thrashing under a broken loader.',
    },
]

const CAPTURE_FIELDS: {
    key: keyof ProfilingPolicy & string
    label: string
    unit: string
    help: string
}[] = [
    {
        key: 'heartbeatSecs', label: 'Continuity snapshot', unit: 'seconds',
        help: 'Recorded when nothing changed. A change is never delayed by this.',
    },
    {
        key: 'silentAfterSecs', label: 'Silent after', unit: 'seconds',
        help: 'Unheard-from for this long and a source is reported as silent.',
    },
]

export function ProfilingSettings({
    onClose, sourceCount = 0,
}: {
    onClose: () => void
    /** Sources reporting right now, so the cost preview can scale from
     *  per-source to this deployment. */
    sourceCount?: number
}) {
    const canRead = useCanReadProfiling()
    const queryClient = useQueryClient()
    const { data: policy, isLoading, isError, error } = useProfilingPolicy({
        enabled: canRead,
    })

    const [draft, setDraft] = useState<Draft>({})
    const [alerts, setAlerts] = useState<{ enabled: boolean; severity: string } | null>(null)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)

    // Seeded once from the loaded policy, then owned by the form: re-syncing
    // on every refetch would overwrite what someone is halfway through typing.
    useEffect(() => {
        if (!policy) return
        setDraft((current) => (Object.keys(current).length ? current : seed(policy)))
        setAlerts((current) => current ?? {
            enabled: policy.alertsEnabled, severity: policy.alertMinSeverity,
        })
    }, [policy])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const editable = Boolean(policy?.editable)

    const patch = useMemo(
        () => (policy ? buildPatch(draft, policy, alerts) : {}),
        [draft, policy, alerts],
    )
    const dirty = Object.keys(patch).length > 0

    // The preview follows the DRAFT, not the saved policy. A picture that only
    // moves after you commit cannot help you decide whether to commit.
    const preview = useMemo<Tiers | null>(() => {
        if (!policy) return null
        const read = (key: string, fallbackKey: keyof ProfilingPolicy) => {
            const typed = (draft[key] ?? '').trim()
            if (typed) {
                const n = Number(typed)
                if (Number.isFinite(n) && n >= 1) return n
            }
            return (policy as unknown as Record<string, number>)[fallbackKey as string]
        }
        return {
            rawDays: read('rawRetentionDays', 'rawRetentionDays'),
            hourlyDays: read('hourlyRetentionDays', 'hourlyRetentionDays'),
            dailyDays: read('dailyRetentionDays', 'dailyRetentionDays'),
        }
    }, [draft, policy])

    const previewHeartbeat = useMemo(() => {
        if (!policy) return 0
        const typed = (draft.heartbeatSecs ?? '').trim()
        const n = Number(typed)
        return typed && Number.isFinite(n) && n >= 1 ? n : policy.heartbeatSecs
    }, [draft, policy])

    const previewCap = useMemo(() => {
        if (!policy) return 0
        const typed = (draft.maxRowsPerSource ?? '').trim()
        const n = Number(typed)
        return typed && Number.isFinite(n) && n >= 1 ? n : policy.maxRowsPerSource
    }, [draft, policy])

    if (!canRead) return null

    async function save() {
        if (!dirty) return
        setSaving(true)
        setSaveError(null)
        try {
            await profilingService.setPolicy(patch)
            await queryClient.invalidateQueries({ queryKey: [PROFILING_KEY] })
            onClose()
        } catch (err) {
            // The backend REFUSES a policy whose tiers do not nest rather than
            // clamping it. Showing that message verbatim is the point — it
            // names which pair is wrong and why.
            setSaveError(err instanceof Error ? err.message : 'The policy could not be saved.')
        } finally {
            setSaving(false)
        }
    }

    return createPortal(
        <>
            <Backdrop open onClick={onClose} />
            {/*
              A right-side drawer, like every other panel in this product.
              A centred modal has to fit the viewport in BOTH directions, and
              this content is tall — six settings with their reasons, plus the
              cadences. On a short window it ran off the bottom with its
              actions below the fold, which is a settings page you cannot save.
              A drawer is full height by construction and scrolls in one axis.
            */}
            <motion.aside
                role="dialog"
                aria-modal="true"
                aria-label="Profiling policy"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 40 }}
                className={cn(
                    'fixed right-0 top-0 z-50 h-full w-full max-w-lg',
                    'flex flex-col bg-canvas border-l border-glass-border shadow-2xl',
                )}
            >
                <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-glass-border shrink-0">
                    <div>
                        <h2 className="text-base font-bold text-ink">Profiling policy</h2>
                        <p className="text-xs text-ink-muted mt-0.5">
                            {/* Neutral while loading. `editable` is false until the
                                policy arrives, so keying the subtitle on it alone
                                told an admin they lacked permission for as long as
                                the request took. */}
                            {/* Neutral while loading. `editable` is false until the
                                policy arrives, so keying the subtitle on it alone
                                told an admin they lacked permission for as long as
                                the request took. */}
                            {!policy || editable
                                ? 'Applies to every data source on this platform.'
                                : 'This is what your history is kept for. Changing it is a '
                                  + 'platform-wide setting, so it needs a system administrator.'}
                        </p>
                    </div>
                    <button
                        type="button" onClick={onClose} aria-label="Close"
                        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </header>

                {isLoading && (
                    <p className="flex items-center gap-2 px-5 py-10 text-sm text-ink-muted">
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                        Reading the policy…
                    </p>
                )}

                {isError && (
                    <p className="mx-5 my-6 rounded-xl border border-rose-500/30 bg-rose-500/[0.05] px-4 py-3 text-sm text-ink">
                        The policy could not be read. {error?.message}
                    </p>
                )}

                {policy && (
                    <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
                        {/*
                          What the policy MEANS, before what it is set to.
                          Four labelled boxes describe the setting; this
                          describes the consequence, which is what someone
                          opened the panel to check.
                        */}
                        {preview && (
                            <section className="space-y-3">
                                <RetentionTimeline tiers={preview} />
                                <RetentionSummary tiers={preview} />
                                <StorageEstimate
                                    tiers={preview}
                                    heartbeatSecs={previewHeartbeat}
                                    maxRowsPerSource={previewCap}
                                    sources={sourceCount}
                                />
                            </section>
                        )}

                        <Section
                            title="How long each tier is kept"
                            note="Tiers must nest — daily reaches back at least as far as hourly, hourly as far as raw."
                        >
                            {RETENTION_FIELDS.map((f) => (
                                <Field
                                    key={f.key} field={f} policy={policy}
                                    draft={draft} setDraft={setDraft} editable={editable}
                                />
                            ))}
                        </Section>

                        <Section
                            title="How often a source is recorded"
                            note="A change is captured the moment it is observed. These govern stillness."
                        >
                            {CAPTURE_FIELDS.map((f) => (
                                <Field
                                    key={f.key} field={f} policy={policy}
                                    draft={draft} setDraft={setDraft} editable={editable}
                                />
                            ))}
                        </Section>

                        <AlertSection
                            policy={policy}
                            draft={draft}
                            setDraft={setDraft}
                            alerts={alerts}
                            setAlerts={setAlerts}
                            editable={editable}
                        />

                        <Cadences policy={policy} />

                        {saveError && (
                            <p className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.05] px-4 py-3 text-sm text-ink">
                                <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
                                {saveError}
                            </p>
                        )}
                    </div>
                )}

                {policy && editable && (
                    <footer className="flex items-center justify-between gap-3 px-5 py-4 border-t border-glass-border shrink-0 bg-canvas">
                        <button
                            type="button"
                            onClick={() => {
                                setDraft(seed(policy))
                                setAlerts({
                                    enabled: policy.alertsEnabled,
                                    severity: policy.alertMinSeverity,
                                })
                            }}
                            className="text-xs font-semibold text-ink-muted hover:text-ink"
                        >
                            Reset
                        </button>
                        <div className="flex items-center gap-2">
                            <button
                                type="button" onClick={onClose}
                                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={save}
                                disabled={!dirty || saving}
                                className={cn(
                                    'rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors',
                                    'bg-indigo-600 text-white hover:bg-indigo-500',
                                    'disabled:opacity-40 disabled:pointer-events-none',
                                )}
                            >
                                {saving ? 'Saving…' : 'Save policy'}
                            </button>
                        </div>
                    </footer>
                )}
            </motion.aside>
        </>,
        document.body,
    )
}

function Section({
    title, note, children,
}: { title: string; note: string; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="text-sm font-bold text-ink">{title}</h3>
            <p className="text-xs text-ink-muted mt-0.5 mb-3 leading-relaxed">{note}</p>
            <div className="space-y-3">{children}</div>
        </section>
    )
}

function Field({
    field, policy, draft, setDraft, editable,
}: {
    field: { key: string; label: string; unit: string; help: string }
    policy: ProfilingPolicy
    draft: Draft
    setDraft: (fn: (d: Draft) => Draft) => void
    editable: boolean
}) {
    // `defaults` carries the alert severity as a string alongside the numeric
    // knobs, so the lookup is widened rather than asserted.
    const fallback = (policy.defaults as unknown as Record<string, number | string>)[field.key]
    const effective = (policy as unknown as Record<string, number | string>)[field.key]
    const overridden = policy.overridden.includes(field.key)
    const value = draft[field.key] ?? ''

    return (
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
                <label
                    {...(editable ? { htmlFor: `policy-${field.key}` } : {})}
                    className="flex items-center gap-2 text-xs font-semibold text-ink"
                >
                    {field.label}
                    {overridden && (
                        <span className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
                            set
                        </span>
                    )}
                </label>
                <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed max-w-md">
                    {field.help}
                </p>
            </div>

            {editable ? (
                <div className="flex items-center gap-2 shrink-0">
                    <input
                        id={`policy-${field.key}`}
                        type="number"
                        min={1}
                        inputMode="numeric"
                        value={value}
                        // The deployment default as a PLACEHOLDER, so an empty
                        // box reads as "inherit this", not as an empty setting.
                        placeholder={String(fallback ?? '')}
                        onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                        className={cn(
                            'w-24 rounded-lg border border-glass-border bg-canvas px-2.5 py-1.5',
                            'text-sm text-ink tabular-nums text-right',
                            'focus:outline-none focus:ring-2 focus:ring-indigo-500/50',
                        )}
                    />
                    <span className="text-[11px] text-ink-muted w-14">{field.unit}</span>
                </div>
            ) : (
                /*
                  A READING, not a disabled form.
                
                  Rendering greyed inputs here showed a placeholder and nothing
                  else — every box empty, because an unset field has no value to
                  seed. To someone who cannot edit, that is a broken form rather
                  than an answer to the question they opened it with: how long is
                  my history kept, and did somebody change it?
                */
                <p className="shrink-0 text-right">
                    <span className="text-sm font-bold text-ink tabular-nums">
                        {humanise(field, effective)}
                    </span>
                    {/* Only the remarkable case is annotated. "deployment
                        default" under every one of six rows is six repetitions
                        of the unremarkable, and it crowds out the one row where
                        somebody actually changed something. */}
                    {overridden && (
                        <span className="block text-[10px] font-semibold text-indigo-600 dark:text-indigo-400">
                            set by an administrator
                        </span>
                    )}
                </p>
            )}
        </div>
    )
}

function Cadences({ policy }: { policy: ProfilingPolicy }) {
    const rows = [
        ['Compaction', policy.cadences.compactIntervalSecs],
        ['Retention pass', policy.cadences.retentionIntervalSecs],
        ['Finding evaluation', policy.cadences.alertIntervalSecs],
    ] as const
    return (
        <section className="rounded-xl border border-glass-border bg-canvas px-4 py-3">
            <h3 className="flex items-center gap-2 text-xs font-bold text-ink">
                <Info className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                Service cadences
            </h3>
            <p className="text-[11px] text-ink-muted mt-1 mb-2.5 leading-relaxed">
                Set per deployment, not here. The purge cannot delete raw beyond the
                compaction watermark, so a compaction interval that could be changed
                from this page would be a way to stall retention.
            </p>
            <dl className="grid grid-cols-3 gap-3">
                {rows.map(([label, secs]) => (
                    <div key={label}>
                        <dt className="text-[10px] uppercase tracking-wide text-ink-muted">
                            {label}
                        </dt>
                        <dd className="text-sm font-semibold text-ink tabular-nums">
                            {secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`}
                        </dd>
                    </div>
                ))}
            </dl>
        </section>
    )
}

const EDITABLE_KEYS = [
    ...RETENTION_FIELDS.map((f) => f.key),
    ...CAPTURE_FIELDS.map((f) => f.key),
    'alertCooldownSecs',
]

/** Only fields the operator has actually SET start with a value. Everything
 *  else starts blank, showing its default as a placeholder. */
function seed(policy: ProfilingPolicy): Draft {
    const out: Draft = {}
    for (const key of EDITABLE_KEYS) {
        out[key] = policy.overridden.includes(key)
            ? String((policy as unknown as Record<string, number>)[key])
            : ''
    }
    return out
}

/** What changed, in the shape the API takes. A field cleared to blank sends
 *  the inherit sentinel rather than being omitted — omitting it would leave
 *  the old override in place, which is the opposite of what clearing means. */
function buildPatch(
    draft: Draft,
    policy: ProfilingPolicy,
    alerts: { enabled: boolean; severity: string } | null,
): Record<string, number | boolean | string> {
    const patch: Record<string, number | boolean | string> = {}
    if (alerts) {
        if (alerts.enabled !== policy.alertsEnabled) patch.alertsEnabled = alerts.enabled
        if (alerts.severity !== policy.alertMinSeverity) {
            patch.alertMinSeverity = alerts.severity
        }
    }
    for (const key of EDITABLE_KEYS) {
        const raw = (draft[key] ?? '').trim()
        const wasSet = policy.overridden.includes(key)
        if (raw === '') {
            if (wasSet) patch[key] = INHERIT_DEFAULT
            continue
        }
        const next = Number(raw)
        if (!Number.isFinite(next) || next < 1) continue
        const current = (policy as unknown as Record<string, number>)[key]
        if (!wasSet || next !== current) patch[key] = next
    }
    return patch
}


/** "6 hours", "15 minutes" — the unit a person would say out loud. Seconds
 *  stay available as the exact value, because this is a setting. */
function humanDuration(secs: number): string {
    if (!Number.isFinite(secs) || secs <= 0) return '—'
    if (secs < 60) return `${secs}s`
    if (secs < 3600) {
        const m = secs / 60
        return `${Number.isInteger(m) ? m : m.toFixed(1)} min`
    }
    const h = secs / 3600
    return `${Number.isInteger(h) ? h : h.toFixed(1)} ${h === 1 ? 'hour' : 'hours'}`
}

/** "45 days", "1 year 35 days" — same idea for the long tiers. */
function humanDays(days: number): string {
    if (days < 365) return `${days} ${days === 1 ? 'day' : 'days'}`
    const years = Math.floor(days / 365)
    const rest = days % 365
    return rest
        ? `${years}y ${rest}d`
        : `${years} ${years === 1 ? 'year' : 'years'}`
}


/** A value in the unit a reader thinks in, not the unit the API stores. */
function humanise(
    field: { key: string; unit: string }, value: number | string,
): string {
    if (typeof value !== 'number') return String(value)
    if (field.unit === 'seconds') return humanDuration(value)
    if (field.unit === 'days') return humanDays(value)
    return `${value.toLocaleString()} ${field.unit}`
}


/**
 * When profiling should speak up.
 *
 * Sits with retention because they are one decision in practice: how much
 * evidence to keep and how loudly to react to it. Splitting them into two
 * pages makes an operator tune one without seeing the other.
 */
function AlertSection({
    policy, draft, setDraft, alerts, setAlerts, editable,
}: {
    policy: ProfilingPolicy
    draft: Draft
    setDraft: (fn: (d: Draft) => Draft) => void
    alerts: { enabled: boolean; severity: string } | null
    setAlerts: (next: { enabled: boolean; severity: string }) => void
    editable: boolean
}) {
    const enabled = alerts?.enabled ?? policy.alertsEnabled
    const severity = alerts?.severity ?? policy.alertMinSeverity

    return (
        <Section
            title="When profiling speaks up"
            note="Judged against each source's OWN usual movement, so a busy graph and a still one are held to different bars."
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-ink">Anomaly findings</p>
                    <p className="text-[11px] text-ink-muted mt-0.5">
                        Rings the in-app bell and records the evidence.
                    </p>
                </div>
                {editable ? (
                    <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        aria-label="Anomaly findings"
                        onClick={() => setAlerts({ enabled: !enabled, severity })}
                        className={cn(
                            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                            enabled ? 'bg-indigo-600' : 'bg-glass-border',
                        )}
                    >
                        <span className={cn(
                            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
                            enabled ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
                        )} />
                    </button>
                ) : (
                    <span className="shrink-0 text-sm font-bold text-ink">
                        {enabled ? 'On' : 'Off'}
                    </span>
                )}
            </div>

            {enabled && (
                <>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-ink">Report from</p>
                            <p className="text-[11px] text-ink-muted mt-0.5 max-w-md leading-relaxed">
                                A wipe is reported at any setting — a floor is a noise
                                control, and losing a graph is not noise.
                            </p>
                        </div>
                        {editable ? (
                            <Segmented
                                label="Severity floor"
                                size="sm"
                                value={severity as 'severe' | 'notable'}
                                onChange={(next) => setAlerts({ enabled, severity: next })}
                                options={[
                                    { key: 'notable' as const, label: '3× usual' },
                                    { key: 'severe' as const, label: '8× usual' },
                                ]}
                            />
                        ) : (
                            <span className="shrink-0 text-sm font-bold text-ink">
                                {severity === 'notable' ? '3× usual' : '8× usual'}
                            </span>
                        )}
                    </div>

                    <Field
                        field={{
                            key: 'alertCooldownSecs',
                            label: 'Quiet period',
                            unit: 'seconds',
                            help: 'One finding per source per measure per interval. A thrashing loader would otherwise page on every probe.',
                        }}
                        policy={policy} draft={draft} setDraft={setDraft} editable={editable}
                    />
                </>
            )}
        </Section>
    )
}
