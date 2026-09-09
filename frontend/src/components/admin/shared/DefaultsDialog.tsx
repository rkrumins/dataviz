/**
 * The fleet-wide Defaults: every tuning knob a rebuild resolves when its job
 * carries no override, in one dialog, with every value labelled by where it
 * came from.
 *
 * Built on the house dialog shell (the Automation modal's): a portal, a
 * sibling ``<Backdrop>``, an inert full-viewport wrapper OUTSIDE the presence
 * tree, a focus-trapped panel, a gradient icon tile, a scrolling body under a
 * fixed header and footer, a dirty guard before discarding, and a
 * notification on save. It replaces a plain grid of nine number boxes whose
 * placeholders were guesses: here the placeholder is the server's live env
 * default, a value set in this dialog carries a "Set here" chip, and Reset
 * sends an explicit null — the server MERGES tuning, so only a null clears a
 * stored key.
 *
 * The Capacity section is where this dialog earns its keep: a live what-if
 * that, as the reserve or bytes-per-edge is edited, restates how many more
 * rollup edges each measured shard would take — before Save, from the same
 * arithmetic the next rebuild will use.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info, Loader2, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'
import { DocsLink } from '@/components/help/DocsLink'
import {
    aggregationService,
    type AggregationSettingsResponse, type AggregationTuning, type EnvTuningDefaults,
} from '@/services/aggregationService'
import {
    KNOB_BY_KEY, KNOB_GROUPS, TUNING_KNOBS, clampKnob, compactBytes, compactEdges,
    envDefaultFor, fitsEdges, fleetTimeoutCapMs, freeAfterReserve, knobPlaceholder, serverCapNote,
    type KnobGroup, type TuningKnob,
} from './aggregationKnobs'
import { CAPACITY_KEYS, useFleetCapacity } from './useAggregationCapacity'

/** The same key the Automation modal reads, so a save here is visible there. */
export const SETTINGS_KEY = ['aggregation', 'settings'] as const

const GROUP_ORDER: KnobGroup[] = ['capacity', 'reading', 'writing', 'timeouts']

const INPUT = 'w-32 px-2.5 py-1.5 text-[13px] text-right tabular-nums rounded-lg border border-glass-border bg-transparent text-ink placeholder:text-ink-muted outline-none transition-colors duration-150 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 disabled:opacity-60 disabled:cursor-not-allowed'

type FinePairs = 'auto' | 'true' | 'false'

function isSet(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v)
}

/** Drop nulls for the dirty comparison: the stored row never carries them. */
function fingerprint(t: AggregationTuning): string {
    const entries = Object.entries(t).filter(([, v]) => v != null).sort(([a], [b]) => a.localeCompare(b))
    return JSON.stringify(entries)
}

function SourceChip({ set }: { set: boolean }) {
    return (
        <span className={cn(
            'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap',
            set
                ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                : 'border-glass-border text-ink-muted',
        )}>
            {set ? 'Set here' : 'Environment default'}
        </span>
    )
}

function KnobRow({ knob, value, env, shardCapMs, disabled, onChange, onReset }: {
    knob: TuningKnob
    value: number | null | undefined
    env: EnvTuningDefaults | null | undefined
    /** The lowest TIMEOUT_MAX read from the fleet's shards, when known. */
    shardCapMs: number | null
    disabled: boolean
    onChange: (raw: string, clamp: boolean) => void
    onReset: () => void
}) {
    const set = isSet(value)
    const id = `defaults-${knob.key}`
    const envValue = envDefaultFor(knob, env)
    const capNote = serverCapNote(knob, set ? value : null, env, shardCapMs)
    const resolvedLine = set
        ? `Set here: ${value.toLocaleString()}${knob.emptyMeans ? '' : ` (environment default ${envValue.toLocaleString()})`}`
        : knob.emptyMeans
            ? `Empty — the ${knob.emptyMeans}.`
            : `Environment default: ${envValue.toLocaleString()}`
    return (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
                <label htmlFor={id} className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary leading-snug cursor-pointer">
                    {knob.label}
                    <HoverTip label={knob.tip} width="data">
                        <span className="inline-flex" aria-label={`About ${knob.label}`}>
                            <Info className="w-3.5 h-3.5 text-ink-muted cursor-help" />
                        </span>
                    </HoverTip>
                </label>
                <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">{knob.help}</p>
                <p className="mt-0.5 text-[11px] text-ink-muted tabular-nums">{resolvedLine}</p>
                {capNote && <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{capNote}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-auto">
                <input
                    id={id}
                    type="number"
                    min={knob.min}
                    max={knob.max}
                    step={knob.step ?? 1}
                    disabled={disabled}
                    placeholder={knobPlaceholder(knob, env)}
                    value={set ? String(value) : ''}
                    onChange={e => onChange(e.target.value, false)}
                    onBlur={e => onChange(e.target.value, true)}
                    className={INPUT}
                />
                <SourceChip set={set} />
                {set && !disabled && (
                    <button
                        type="button"
                        onClick={onReset}
                        aria-label={`Reset ${knob.label} to the environment default`}
                        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </div>
    )
}

export function DefaultsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const qc = useQueryClient()
    const { notify } = useAppNotifications()
    const isAdmin = usePermission('system:admin')

    const settingsQ = useQuery<AggregationSettingsResponse, Error>({
        queryKey: SETTINGS_KEY,
        queryFn: () => aggregationService.getAggregationSettings(),
        enabled: open,
        staleTime: 0,
        retry: 1,
    })
    const capacityQ = useFleetCapacity(open)

    const [draft, setDraft] = useState<AggregationTuning>({})
    const [seed, setSeed] = useState<string>(fingerprint({}))
    const [confirmDiscard, setConfirmDiscard] = useState(false)
    const seededFor = useRef<AggregationSettingsResponse | null>(null)

    // Seed once per open from what the server holds; never re-seed under an
    // operator's hands when a poll lands.
    useEffect(() => {
        if (!open) { seededFor.current = null; return }
        const data = settingsQ.data
        if (!data || seededFor.current === data) return
        if (seededFor.current != null) return
        seededFor.current = data
        const stored = data.tuning ?? {}
        setDraft(stored)
        setSeed(fingerprint(stored))
    }, [open, settingsQ.data])

    const env = settingsQ.data?.envTuningDefaults ?? null
    const ready = !!settingsQ.data
    const dirty = fingerprint(draft) !== seed
    // The cap the per-query timeouts are really bounded by: read from the
    // shards when the sweep has them (it can be raised at runtime), else the
    // deployment's mirror.
    const shardCapMs = fleetTimeoutCapMs(capacityQ.data)

    // The a11y hook re-runs its effect — and re-focuses the panel — whenever
    // its close callback changes identity. ``dirty`` changes on every
    // keystroke, so the callback the hook sees must stay stable while the
    // one it calls through stays current; otherwise the second character
    // typed into any field lands on the panel instead of the input.
    const requestCloseRef = useRef<() => void>(() => onClose())
    requestCloseRef.current = () => {
        if (dirty && isAdmin) setConfirmDiscard(true)
        else onClose()
    }
    const requestClose = useCallback(() => requestCloseRef.current(), [])
    const dialogRef = useModalA11y(open && !confirmDiscard, requestClose)

    const save = useMutation<AggregationSettingsResponse, Error, AggregationTuning>({
        mutationFn: (tuning) => aggregationService.putAggregationSettings(tuning),
        onSuccess: (res) => {
            qc.setQueryData(SETTINGS_KEY, res)
            void qc.invalidateQueries({ queryKey: SETTINGS_KEY })
            void qc.invalidateQueries({ queryKey: CAPACITY_KEYS.fleet })
            notify('success', 'Defaults saved — applied to every new job at trigger time.')
            onClose()
        },
        onError: (e) => notify('error', e.message || 'Could not save the defaults.'),
    })

    const setKnob = (knob: TuningKnob, raw: string, clamp: boolean) => {
        setDraft(prev => {
            const next: AggregationTuning = { ...prev }
            const parsed = knob.float ? parseFloat(raw) : parseInt(raw)
            if (raw === '' || !Number.isFinite(parsed)) {
                // An explicit null, not a deleted key: the server merges tuning
                // and only a null clears a stored default.
                if (raw === '' || clamp) next[knob.key] = null
                return next
            }
            next[knob.key] = clamp ? clampKnob(knob, parsed) : parsed
            return next
        })
    }
    const resetKnob = (knob: TuningKnob) => setDraft(prev => ({ ...prev, [knob.key]: null }))

    // Rollup storage: absent means INHERIT the env; written as 'auto' or
    // true, never by omission (omission cannot walk back a stored true).
    const envFine: FinePairs = env?.materializeFinePairs ?? settingsQ.data?.envMaterializeFinePairs ?? 'true'
    const rawFine = draft.materializeFinePairs
    const finePairs: FinePairs = rawFine == null ? envFine : rawFine === 'auto' ? 'auto' : rawFine ? 'true' : 'false'
    const fineSet = rawFine != null
    const leafPairs = draft.materializeLeafPairs ?? env?.materializeLeafPairs ?? false

    // The what-if: the pipeline's own arithmetic on every measured shard, at
    // the DRAFT reserve and bytes-per-edge.
    const whatIf = useMemo(() => {
        const cap = capacityQ.data
        if (!cap) return null
        const reserve = isSet(draft.shardReservePct) ? draft.shardReservePct : envDefaultFor(KNOB_BY_KEY.shardReservePct, env)
        const bpe = isSet(draft.bytesPerEdge) ? draft.bytesPerEdge : envDefaultFor(KNOB_BY_KEY.bytesPerEdge, env)
        const ceiling = isSet(draft.maxMaterializedEdges) ? draft.maxMaterializedEdges : null
        const measured = cap.shards.filter(s => s.measurable).map(s => {
            const free = freeAfterReserve(s, reserve)
            return { endpoint: s.endpoint, free, fits: fitsEdges(free, bpe) }
        })
        const unmeasured = cap.shards.filter(s => !s.measurable).length
        return { reserve, bpe, ceiling, measured, unmeasured, staticCap: cap.limits.staticCap }
    }, [capacityQ.data, draft.shardReservePct, draft.bytesPerEdge, draft.maxMaterializedEdges, env])

    return createPortal(
        <>
            <Backdrop open={open} onClick={requestClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[61] flex items-start sm:items-center justify-center p-3 sm:p-4 pointer-events-none">
                <AnimatePresence>
                    {open && (
                        <motion.div
                            ref={dialogRef}
                            tabIndex={-1}
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="defaults-title"
                            initial={{ scale: 0.95, opacity: 0, y: 20 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.95, opacity: 0, y: 20 }}
                            transition={{ duration: 0.12 }}
                            className="pointer-events-auto outline-none w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg overflow-hidden"
                        >
                            <header className="flex items-center justify-between gap-4 px-6 sm:px-8 py-5 border-b border-glass-border bg-gradient-to-r from-black/[0.02] to-transparent dark:from-white/[0.02] shrink-0">
                                <div className="flex items-center gap-4 min-w-0">
                                    <div className="w-12 h-12 shrink-0 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-md">
                                        <SlidersHorizontal className="w-6 h-6" />
                                    </div>
                                    <div className="min-w-0">
                                        <h2 id="defaults-title" className="text-xl font-bold text-ink">Aggregation defaults</h2>
                                        <p className="text-sm text-ink-muted">
                                            What every rebuild resolves when its job sets nothing else.{' '}
                                            <DocsLink slug="rollup-capacity" variant="inline" label="How capacity is measured" />
                                        </p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={requestClose}
                                    aria-label="Close aggregation defaults"
                                    className="p-2 shrink-0 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                >
                                    <X className="w-5 h-5 text-ink-muted" />
                                </button>
                            </header>

                            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 sm:px-8 py-5">
                                {!ready ? (
                                    <div className="flex items-center justify-center py-12 text-ink-muted">
                                        {settingsQ.isError
                                            ? <p className="text-sm">Could not load the current defaults.</p>
                                            : <Loader2 className="w-5 h-5 animate-spin" />}
                                    </div>
                                ) : (
                                    <div className="space-y-7">
                                        {GROUP_ORDER.map(group => (
                                            <section key={group} aria-labelledby={`defaults-group-${group}`}>
                                                <h3 id={`defaults-group-${group}`} className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-muted">
                                                    {KNOB_GROUPS[group].title}
                                                </h3>
                                                <p className="mt-1 text-[12px] text-ink-muted leading-snug">{KNOB_GROUPS[group].blurb}</p>
                                                <div className="mt-2 border-t border-glass-border divide-y divide-glass-border">
                                                    {TUNING_KNOBS.filter(k => k.group === group).map(knob => (
                                                        <KnobRow
                                                            key={knob.key}
                                                            knob={knob}
                                                            value={draft[knob.key] as number | null | undefined}
                                                            env={env}
                                                            shardCapMs={shardCapMs}
                                                            disabled={!isAdmin || save.isPending}
                                                            onChange={(raw, clamp) => setKnob(knob, raw, clamp)}
                                                            onReset={() => resetKnob(knob)}
                                                        />
                                                    ))}
                                                </div>

                                                {group === 'timeouts' && env && (() => {
                                                    const capMs = shardCapMs ?? env.serverTimeoutMaxMs
                                                    const cap = typeof capMs === 'number' && capMs > 0 ? `${capMs / 1000} s` : 'no limit'
                                                    return (
                                                        <p className="mt-3 text-[11px] text-ink-muted">
                                                            The graph store caps any query at {cap} (TIMEOUT_MAX, {shardCapMs != null ? 'read from the store' : 'from the deployment'} — administrators adjust it under Infrastructure → Memory headroom).
                                                            Set by the deployment: a narrowest scan that keeps timing out is retried {env.scanTimeoutRetries ?? 6} times with backoff before the run resumes from its checkpoint;
                                                            the reconcile switches to keys-only at {compactEdges(env.reconcileKeysOnlyWidth ?? 5_000)} rows.
                                                        </p>
                                                    )
                                                })()}
                                                {group === 'capacity' && (
                                                    <div className="mt-3 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] p-3 space-y-2">
                                                        <p className="text-[11px] font-semibold text-ink-secondary">What these limits mean on your shards right now</p>
                                                        {whatIf == null ? (
                                                            <p className="text-[11px] text-ink-muted">
                                                                {capacityQ.isError ? 'Capacity could not be measured right now.' : 'Measuring the graph store…'}
                                                            </p>
                                                        ) : whatIf.measured.length === 0 ? (
                                                            <p className="text-[11px] text-ink-muted">
                                                                No shard can be measured (no maxmemory, or unreachable) — the static cap of {compactEdges(whatIf.staticCap)} edges governs.
                                                            </p>
                                                        ) : (
                                                            <ul className="space-y-1" data-testid="defaults-what-if">
                                                                {whatIf.measured.map(m => (
                                                                    <li key={m.endpoint} className="text-[11px] text-ink-secondary tabular-nums">
                                                                        <span className="font-mono">{m.endpoint}</span>
                                                                        {': '}{compactBytes(m.free)} free after a {whatIf.reserve}% reserve
                                                                        {' → '}fits ~{compactEdges(m.fits)} more rollup edges at {whatIf.bpe} B each
                                                                        {whatIf.ceiling != null && ` (ceiling ${compactEdges(whatIf.ceiling)} in total)`}
                                                                    </li>
                                                                ))}
                                                                {whatIf.unmeasured > 0 && (
                                                                    <li className="text-[11px] text-ink-muted">
                                                                        {whatIf.unmeasured} shard{whatIf.unmeasured === 1 ? '' : 's'} cannot be measured — the static cap of {compactEdges(whatIf.staticCap)} edges applies there.
                                                                    </li>
                                                                )}
                                                            </ul>
                                                        )}
                                                        {env && (
                                                            <p className="text-[11px] text-ink-muted">
                                                                Set by the deployment: Auto’s cube ceiling {compactEdges(env.maxCubeEdges)} edges,
                                                                estimate margin {env.estimateMarginPct ?? 25}%, shard re-measured every {compactEdges(env.budgetRecheckEdges)} edges written.
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                            </section>
                                        ))}

                                        <section aria-labelledby="defaults-group-rollup">
                                            <h3 id="defaults-group-rollup" className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-muted">Rollup storage</h3>
                                            <p className="mt-1 text-[12px] text-ink-muted leading-snug">
                                                Where the fleet stores its rollups. A source can override this in its drawer; a job can override both.
                                            </p>
                                            <div className="mt-2 border-t border-glass-border divide-y divide-glass-border">
                                                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
                                                    <div className="min-w-0 flex-1">
                                                        <span className="block text-[13px] text-ink-secondary leading-snug">Rollup storage</span>
                                                        <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">
                                                            {finePairs === 'auto'
                                                                ? 'Full detail wherever it fits what the shard can hold; the depth-diagonal above that. Degrades instead of failing.'
                                                                : 'Every combination pre-created. A cube the owning shard cannot take is refused before anything is written.'}
                                                        </p>
                                                        <p className="mt-0.5 text-[11px] text-ink-muted">
                                                            {fineSet ? 'Set here' : `Environment default: ${envFine === 'auto' ? 'Auto' : 'Full detail'}`}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2 shrink-0 ml-auto">
                                                        <span className="flex shrink-0 rounded-lg border border-glass-border p-0.5" role="radiogroup" aria-label="Rollup storage">
                                                            {([['auto', 'Auto'], ['true', 'Full detail']] as const).map(([id, label]) => {
                                                                const selected = finePairs === id
                                                                return (
                                                                    <button
                                                                        key={id}
                                                                        type="button"
                                                                        role="radio"
                                                                        aria-checked={selected}
                                                                        disabled={!isAdmin || save.isPending}
                                                                        onClick={() => setDraft(prev => ({ ...prev, materializeFinePairs: id === 'true' ? true : 'auto' }))}
                                                                        className={cn(
                                                                            'rounded-md px-2.5 py-1 text-[12px] transition-colors duration-150',
                                                                            'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                                            selected ? 'bg-indigo-500/10 text-ink font-medium' : 'text-ink-muted hover:text-ink-secondary',
                                                                            (!isAdmin || save.isPending) && 'cursor-not-allowed opacity-60',
                                                                        )}
                                                                    >
                                                                        {label}
                                                                    </button>
                                                                )
                                                            })}
                                                        </span>
                                                        <SourceChip set={fineSet} />
                                                        {fineSet && isAdmin && (
                                                            <button
                                                                type="button"
                                                                onClick={() => setDraft(prev => ({ ...prev, materializeFinePairs: undefined }))}
                                                                aria-label="Reset Rollup storage to the environment default"
                                                                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                                            >
                                                                <RotateCcw className="w-3.5 h-3.5" />
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                                                    <div className="min-w-0 flex-1">
                                                        <label htmlFor="defaults-leaf-pairs" className="block text-[13px] text-ink-secondary leading-snug cursor-pointer">
                                                            Materialize leaf-to-leaf mirror pairs
                                                        </label>
                                                        <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">
                                                            Legacy behaviour; doubles write volume. Off for new deployments.
                                                        </p>
                                                    </div>
                                                    <ToggleSwitch
                                                        id="defaults-leaf-pairs"
                                                        size="sm"
                                                        checked={leafPairs === true}
                                                        onChange={(next) => setDraft(prev => ({ ...prev, materializeLeafPairs: next || undefined }))}
                                                        disabled={!isAdmin || save.isPending}
                                                        aria-label="Materialize leaf-to-leaf mirror pairs"
                                                    />
                                                </div>
                                            </div>
                                        </section>
                                    </div>
                                )}
                            </div>

                            {ready && (
                                <footer className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-6 sm:px-8 py-5 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                                    {isAdmin ? (
                                        <>
                                            <p className="mr-auto text-[12px] text-ink-muted">
                                                Applies to every job triggered from now on. Running jobs keep the settings they started with.
                                            </p>
                                            <button
                                                type="button"
                                                onClick={onClose}
                                                className="px-5 py-2.5 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => save.mutate(draft)}
                                                disabled={save.isPending || !dirty}
                                                className={cn(
                                                    'flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150',
                                                    'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                    save.isPending || !dirty
                                                        ? 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed'
                                                        : 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md',
                                                )}
                                            >
                                                {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                                                Save defaults
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <p className="mr-auto text-[12px] text-ink-muted">Only platform admins can change these settings.</p>
                                            <button
                                                type="button"
                                                onClick={onClose}
                                                className="px-5 py-2.5 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                            >
                                                Close
                                            </button>
                                        </>
                                    )}
                                </footer>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <ConfirmDialog
                open={confirmDiscard}
                title="Discard these default changes?"
                message="Your unsaved changes will be lost if you close now. Every new job keeps resolving against the last saved defaults."
                confirmLabel="Discard"
                confirmIcon={RotateCcw}
                onCancel={() => setConfirmDiscard(false)}
                onConfirm={() => { setConfirmDiscard(false); onClose() }}
            />
        </>,
        document.body,
    )
}

export default DefaultsDialog
