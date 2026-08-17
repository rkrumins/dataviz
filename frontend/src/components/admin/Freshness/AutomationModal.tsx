/**
 * AutomationModal — automatic reconciliation as the one pipeline it actually
 * is: ① Detect → ② Check → ③ Act, in the order it runs.
 *
 * It replaces a 448px modal that listed the same three policies in the
 * OPPOSITE order, in three unrelated boxes, with units flipping between
 * minutes and seconds from one box to the next. Nothing in that layout showed
 * that Detect feeds Check — so an operator could turn Detect off and still
 * read the Check interval as a promise. Here the stages sit in order, the
 * connector between them goes dashed and amber when the upstream stage is off,
 * every cadence is one control in one unit, and the modal says out loud which
 * combinations contradict each other.
 *
 * The policy and the cadence are two endpoints but ONE stored record, so the
 * two writes are sequenced (policy first, then cadence), never raced.
 *
 * The cadence half is platform-admin only to READ, so a non-admin gets the
 * whole explanation, the live counts, and the policy controls disabled — the
 * explanation is the valuable half, and hiding it teaches nobody anything.
 *
 * Modal conventions are the house ones, and deliberately not Radix Dialog nor
 * <AnimatePresence>: a Radix modal that unmounts while open strands
 * ``body { pointer-events: none }``, and a portaled AnimatePresence with an
 * exit animation strands an invisible click-blocker over the page. createPortal
 * + a persistent <Backdrop> (a SIBLING of the pointer-events-none wrapper, so
 * its onClick is reachable) + useModalA11y instead.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Loader2, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { DurationField, formatDuration } from '@/components/ui/DurationField'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useToast } from '@/components/ui/toast'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { aggregationService, type AggregationCadence } from '@/services/aggregationService'
import type { FreshnessSummary } from '@/services/freshnessService'
import { DETECTORS, STAGE_ACCENT, automationWarnings } from './automationCopy'
import { StageCard } from './StageCard'
import { lastPassBrief, pickLastPassRun } from './reconcileHealth'
import { useReconcileNow, useReconciliation, useSetReconciliationPolicy } from './useFreshness'

const SETTINGS_KEY = ['aggregation', 'settings'] as const

/** Backend bounds, in the one unit the modal speaks. */
const MAX_SECS = 86400
const MIN_PROBE_SECS = 15
const MIN_CHECK_SECS = 60
const MAX_CAP = 200
const MAX_SHRINK_PCT = 100

/** Preset ladders per stage. Deliberately disjoint across the three stages:
 *  two stages offering the same chip is exactly the confusion this modal
 *  exists to remove. */
const DETECT_PRESETS = [15, 30, 60, 600]
const CHECK_PRESETS = [300, 1800, 3600, 21600]
const COOLDOWN_PRESETS = [0, 900, 7200, MAX_SECS]

/** How long the edits have to settle before we ask the server what the stored
 *  policy would do to the fleet. The dry run scans every source. */
const IMPACT_DEBOUNCE_MS = 600

/** One stage's on/off, worded as the sentence it is rather than a bare label,
 *  so the switch's accessible name is the promise it makes. The words are a
 *  <label> for the switch, not a bare <span>: the sentence is the biggest
 *  thing on the row and pointing at it has to do something. */
function ToggleRow({ id, label, checked, onChange, disabled }: {
    id: string
    label: string
    checked: boolean
    onChange: (v: boolean) => void
    disabled: boolean
}) {
    return (
        <div className="flex items-center justify-between gap-2">
            <label
                htmlFor={id}
                className={cn(
                    'text-[13px] text-ink-secondary leading-snug min-w-0',
                    disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                )}
            >
                {label}
            </label>
            <ToggleSwitch
                id={id}
                size="sm"
                checked={checked}
                onChange={onChange}
                disabled={disabled}
                aria-label={label}
            />
        </div>
    )
}

/** Two stages read from the admin-only cadence record, so both have to say the
 *  same thing in the same words to a reader who cannot see it. Silently
 *  dropping the controls would read as "this stage has no such setting". */
function AdminOnlyCadence() {
    return (
        <p className="text-[11px] text-ink-muted">
            Only platform admins can see this cadence.
        </p>
    )
}

/**
 * The seam between two stages, and the one loud thing in here.
 *
 * Feeding: a solid hairline in the downstream stage's accent. Starved: dashed,
 * amber, and labelled — the moment the upstream stage goes off, the downstream
 * cadence stops meaning what it says. The state is carried by the dash pattern
 * and the word as well as the colour, and nothing about it animates on a loop.
 */
function Connector({ starved, into }: { starved: boolean; into: keyof typeof STAGE_ACCENT }) {
    const accent = STAGE_ACCENT[into]
    return (
        <div
            aria-hidden
            className="flex md:flex-col items-center justify-center shrink-0 gap-1.5 py-1 md:py-0 md:px-1"
        >
            {/* Stacked below md, so the line rotates to vertical and the arrow
                drops below it; a row from md, arrow at the right-hand end. */}
            <span className="flex flex-col md:flex-row items-center">
                <span
                    className={cn(
                        'block h-7 border-l md:h-0 md:w-9 md:border-l-0 md:border-t transition-colors duration-200 motion-reduce:transition-none',
                        starved ? 'border-dashed border-amber-500' : accent.line,
                    )}
                />
                <ArrowRight
                    className={cn(
                        'w-3.5 h-3.5 -mt-1 md:mt-0 md:-ml-1 rotate-90 md:rotate-0 transition-colors duration-200 motion-reduce:transition-none',
                        starved ? 'text-amber-500' : accent.arrow,
                    )}
                />
            </span>
            {starved && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    starved
                </span>
            )}
        </div>
    )
}

export function AutomationModal({ open, onClose, isAdmin, summary }: {
    open: boolean
    /** Must be referentially stable: it feeds ``useModalA11y``'s focus effect,
     *  and a fresh identity on every parent render would pull focus back to
     *  the dialog mid-keystroke. */
    onClose: () => void
    isAdmin: boolean
    summary?: FreshnessSummary | null
}) {
    const qc = useQueryClient()
    const { showToast } = useToast()
    const dialogRef = useModalA11y(open, onClose)

    const reconQ = useReconciliation()
    const policy = reconQ.data?.policy

    // The stored cadence is readable by platform admins only, so a non-admin
    // never fires a request that can only 403.
    const settingsQ = useQuery({
        queryKey: SETTINGS_KEY,
        queryFn: () => aggregationService.getAggregationSettings(),
        enabled: open && isAdmin,
    })
    const cadence = settingsQ.data?.cadence

    const [probeEnabled, setProbeEnabled] = useState(true)
    const [probeSecs, setProbeSecs] = useState<number | null>(null)
    const [checkEnabled, setCheckEnabled] = useState(true)
    const [checkSecs, setCheckSecs] = useState<number | null>(null)
    const [driftAuto, setDriftAuto] = useState(true)
    const [cooldownSecs, setCooldownSecs] = useState<number | null>(null)
    const [cap, setCap] = useState('')
    const [shrinkPct, setShrinkPct] = useState('')
    const [detectors, setDetectors] = useState<string[]>([])

    // ``seeded`` is STATE, not a ref: nothing editable and no Save may render
    // before the real values have landed. An effect is passive, so a ref would
    // still paint one frame of the initial state — and that state says
    // ``detectors: []``, which is a real configuration meaning "act on
    // nothing". One click on a Save rendered from it clobbers the fleet.
    const [seeded, setSeeded] = useState(false)
    // Set by every control. Until then the modal keeps adopting fresh payloads,
    // because a modal that sits open for an hour must not show an hour-old
    // policy; after that it stops, because it must not eat half-typed edits.
    const [dirty, setDirty] = useState(false)
    /** What the controls were last seeded from — lets an edit-in-progress say
     *  "someone else changed this" instead of quietly overwriting them. State
     *  rather than a ref because it is compared during render. */
    const [seededSig, setSeededSig] = useState('')

    const remoteSig = JSON.stringify([
        policy?.enabled, policy?.checkIntervalSecs, policy?.maxActionsPerRun,
        policy?.shrinkTolerancePct, policy?.detectors,
        cadence?.probeEnabled, cadence?.probeIntervalSecs,
        cadence?.driftAutoRebuild, cadence?.rebuildMinIntervalSecs,
    ])

    useEffect(() => {
        if (open) return
        setSeeded(false)
        setDirty(false)
    }, [open])

    useEffect(() => {
        if (!open || dirty || !policy) return
        if (isAdmin && !settingsQ.data) return

        setCheckEnabled(policy.enabled ?? policy.envEnabled)
        setCheckSecs(policy.checkIntervalSecs ?? null)
        setCap(policy.maxActionsPerRun != null ? String(policy.maxActionsPerRun) : '')
        setShrinkPct(policy.shrinkTolerancePct != null ? String(policy.shrinkTolerancePct) : '')
        // Unset means every detector is on, so seed from the full list. An
        // EMPTY stored array is a real configuration ("act on nothing") and
        // must survive as such — never a truthiness test.
        setDetectors(policy.detectors ?? policy.allDetectors)

        if (settingsQ.data) {
            // Fall back to the EFFECTIVE env default the server reports, never
            // a hardcoded guess: it means a save that only meant to change one
            // interval round-trips the real current state of every toggle
            // instead of flipping it fleet-wide.
            setProbeEnabled(cadence?.probeEnabled ?? settingsQ.data.envProbeEnabled ?? true)
            setProbeSecs(cadence?.probeIntervalSecs ?? null)
            setDriftAuto(cadence?.driftAutoRebuild ?? settingsQ.data.envDriftAutoRebuild ?? true)
            setCooldownSecs(cadence?.rebuildMinIntervalSecs ?? null)
        }
        setSeededSig(remoteSig)
        setSeeded(true)
    }, [open, dirty, policy, settingsQ.data, cadence, isAdmin, remoteSig])

    /** Marks the form edited before applying the change, so one payload
     *  arriving mid-edit cannot undo what was just typed. */
    const edit = <T,>(set: (v: T) => void) => (v: T) => {
        setDirty(true)
        set(v)
    }

    const saveCadence = useMutation({
        mutationFn: (body: AggregationCadence) => aggregationService.putAggregationCadence(body),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: SETTINGS_KEY })
            // The controls now hold what the server holds, so the modal may go
            // back to adopting whatever anyone else writes.
            setDirty(false)
            showToast('success', 'Automation saved. Takes effect within a minute.')
            onClose()
        },
        onError: (e: Error) => showToast('error', e.message || 'Could not save the cadence.'),
    })
    const saveRecon = useSetReconciliationPolicy()

    // What the STORED policy would do to the fleet right now. Debounced so
    // opening and closing the modal does not set a fleet scan going, and
    // re-armed after a save so the number reflects what was just written.
    const dryRun = useReconcileNow()
    const dryRunMutate = dryRun.mutate
    const [savedAt, setSavedAt] = useState(0)
    useEffect(() => {
        if (!open || !isAdmin) return
        const id = setTimeout(() => dryRunMutate({ dryRun: true }), IMPACT_DEBOUNCE_MS)
        return () => clearTimeout(id)
    }, [open, isAdmin, dryRunMutate, savedAt])

    const onSave = () => {
        if (checkSecs != null && (!Number.isFinite(checkSecs) || checkSecs < MIN_CHECK_SECS || checkSecs > MAX_SECS)) {
            showToast('error', 'Check no more often than once a minute, and at least once a day.')
            return
        }
        const capNum = cap.trim() === '' ? null : Number(cap)
        if (capNum != null && (!Number.isFinite(capNum) || capNum < 0 || capNum > MAX_CAP)) {
            showToast('error', 'Rebuilds per check must be between 0 and 200.')
            return
        }
        const shrinkNum = shrinkPct.trim() === '' ? null : Number(shrinkPct)
        if (shrinkNum != null && (!Number.isFinite(shrinkNum) || shrinkNum < 0 || shrinkNum > MAX_SHRINK_PCT)) {
            showToast('error', 'The shrink allowance must be between 0 and 100 percent.')
            return
        }
        if (probeSecs != null && (!Number.isFinite(probeSecs) || probeSecs < MIN_PROBE_SECS || probeSecs > MAX_SECS)) {
            showToast('error', 'Look for changes no more often than every 15 seconds, and at least once a day.')
            return
        }
        if (cooldownSecs != null && (!Number.isFinite(cooldownSecs) || cooldownSecs < 0 || cooldownSecs > MAX_SECS)) {
            showToast('error', 'The wait between rebuilds must be between 0 seconds and 24 hours.')
            return
        }
        // Both writes land in the same stored record, so they are sequenced
        // rather than raced: the policy first, then the cadence, each merging
        // into what the other left.
        saveRecon.mutate(
            {
                enabled: checkEnabled,
                checkIntervalSecs: checkSecs,
                maxActionsPerRun: capNum,
                shrinkTolerancePct: shrinkNum,
                // Sent as an explicit list, never omitted: an empty list means
                // "act on nothing", which is a real choice, not an unset one.
                detectors,
            },
            {
                onSuccess: () => {
                    setSavedAt(Date.now())
                    saveCadence.mutate({
                        rebuildMinIntervalSecs: cooldownSecs,
                        driftAutoRebuild: driftAuto,
                        probeEnabled,
                        probeIntervalSecs: probeSecs,
                    })
                },
                onError: (e: Error) =>
                    showToast('error', e.message || 'Could not save the reconciliation policy.'),
            },
        )
    }

    // On a FIRST read failure both queries stop loading with no data, so "not
    // loading" is not "ready", and the only honest option is to say so: the
    // alternative is an editable form full of invented defaults over a live
    // Save. Once seeded it is the opposite — query-core reports `status:
    // 'error'` for a failed BACKGROUND poll even though the cached policy is
    // still there, and pulling the form out from under a half-typed edit for
    // a refresh that will retry in a minute destroys work to report nothing.
    const readFailed = reconQ.isError || (isAdmin && settingsQ.isError)
    const ready = seeded && policy != null
    const changedElsewhere = seeded && dirty && remoteSig !== seededSig
    const warnings = automationWarnings(
        { enabled: checkEnabled, detectors, maxActionsPerRun: cap.trim() === '' ? null : Number(cap) },
        // A non-admin cannot read the probe setting, so we must not claim it
        // is off — undefined leaves that warning unsaid rather than wrong.
        { probeEnabled: isAdmin ? probeEnabled : undefined },
    )

    const pass = pickLastPassRun(reconQ.data?.runs)
    const checkStat = pass
        ? (lastPassBrief(pass) ?? `${pass.scanned.toLocaleString()} checked · all in sync`)
        : 'No check has run yet'
    const actStat = pass
        ? `${pass.actions.toLocaleString()} rebuilt at the last check`
        : 'Nothing rebuilt yet'
    // No fleet summary means no number — "0 sources watched" is a claim, not a
    // placeholder. And "watched" is only true while change detection is on,
    // which a non-admin cannot see either way.
    const watching = isAdmin ? probeEnabled : null
    const detectStat = summary == null
        ? undefined
        : `${summary.total.toLocaleString()} sources`
            + (watching === true ? ' watched' : watching === false ? ' — watching is off' : '')
    const dryFindings = dryRun.data?.findings?.length ?? null
    const impact = dryFindings == null
        ? null
        : dryFindings === 0
            ? 'Right now a check would rebuild nothing.'
            : `Right now a check would rebuild ${dryFindings.toLocaleString()} `
                + `source${dryFindings === 1 ? '' : 's'}.`

    return createPortal(
        <>
            {/* Sibling of the pointer-events-none wrapper below, never its
                child — nested, its onClick never receives the click. */}
            <Backdrop open={open} onClick={onClose} zClassName="z-[60]" className="bg-black/50" />
            {/* No <AnimatePresence>: a portaled exit animation that gets
                interrupted strands an invisible click-blocker over the page.
                It still animates in. */}
            {open && (
                <div className="fixed inset-0 z-[61] flex items-start sm:items-center justify-center p-3 sm:p-4 pointer-events-none">
                    <motion.div
                        ref={dialogRef}
                        tabIndex={-1}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="automation-title"
                        initial={{ opacity: 0, scale: 0.98, y: 8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ duration: 0.16, ease: 'easeOut' }}
                        className="pointer-events-auto outline-none w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated shadow-glass-lg overflow-hidden"
                    >
                        {/* Header and footer are flex children of a bounded
                            column, so only the middle scrolls: a settings modal
                            that hides its own Save is the failure mode of the
                            dialog this replaces. */}
                        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-glass-border">
                            <div className="min-w-0">
                                <h2 id="automation-title" className="text-base font-bold text-ink">
                                    Automation
                                </h2>
                                <p className="text-[13px] text-ink-secondary mt-0.5">
                                    How the system watches your data and repairs it.
                                </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <kbd
                                    aria-hidden
                                    className="hidden sm:inline-block px-1.5 py-0.5 rounded border border-glass-border text-[10px] font-semibold text-ink-muted"
                                >
                                    esc
                                </kbd>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    aria-label="Close automation settings"
                                    className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        </header>

                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-4">
                            <p className="text-[12px] text-ink-muted leading-snug mb-3.5">
                                One pipeline, in the order it runs. Each stage feeds the next, so
                                turning one off changes what the ones after it can see.
                            </p>

                            {readFailed && !ready ? (
                                <div
                                    role="alert"
                                    className="rounded-xl border border-red-500/30 bg-red-500/[0.07] px-3.5 py-3 text-[13px] text-ink-secondary leading-snug"
                                >
                                    Could not read the automation settings, so they cannot be shown
                                    or changed here. Nothing has been altered — the schedule is
                                    still running on whatever it was last saved with. Close this
                                    and open it again to retry.
                                </div>
                            ) : !ready ? (
                                <div className="flex items-center gap-2 justify-center py-16 text-sm text-ink-muted">
                                    <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                                </div>
                            ) : (
                                <>
                                    <div className="flex flex-col md:flex-row items-stretch gap-2">
                                        <StageCard
                                            stage="detect"
                                            on={isAdmin ? probeEnabled : null}
                                            stat={detectStat}
                                        >
                                            {isAdmin ? (
                                                <>
                                                    <ToggleRow
                                                        id="automation-probe"
                                                        label="Watch for changes made outside this app"
                                                        checked={probeEnabled}
                                                        onChange={edit(setProbeEnabled)}
                                                        disabled={false}
                                                    />
                                                    <DurationField
                                                        label="Look for changes every"
                                                        value={probeSecs}
                                                        onChange={edit(setProbeSecs)}
                                                        presets={DETECT_PRESETS}
                                                        defaultSecs={settingsQ.data?.envProbeIntervalSecs ?? 60}
                                                        min={MIN_PROBE_SECS}
                                                        max={MAX_SECS}
                                                        disabled={!probeEnabled}
                                                    />
                                                </>
                                            ) : <AdminOnlyCadence />}
                                        </StageCard>

                                        <Connector starved={isAdmin && !probeEnabled} into="check" />

                                        <StageCard
                                            stage="check"
                                            on={checkEnabled}
                                            muted={isAdmin && checkEnabled && !probeEnabled}
                                            stat={checkStat}
                                        >
                                            <ToggleRow
                                                id="automation-check"
                                                label="Check every source on a schedule"
                                                checked={checkEnabled}
                                                onChange={edit(setCheckEnabled)}
                                                disabled={!isAdmin}
                                            />
                                            <DurationField
                                                label="Check every"
                                                value={checkSecs}
                                                onChange={edit(setCheckSecs)}
                                                presets={CHECK_PRESETS}
                                                defaultSecs={policy.envCheckIntervalSecs}
                                                min={MIN_CHECK_SECS}
                                                max={MAX_SECS}
                                                disabled={!isAdmin || !checkEnabled}
                                            />

                                            <div>
                                                <label
                                                    htmlFor="automation-shrink"
                                                    className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-1.5"
                                                >
                                                    Allow rollups to shrink by
                                                </label>
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        id="automation-shrink"
                                                        type="number" min={0} max={MAX_SHRINK_PCT} step={1}
                                                        value={shrinkPct}
                                                        disabled={!isAdmin}
                                                        onChange={(e) => edit(setShrinkPct)(e.target.value)}
                                                        placeholder={`Default (${policy.envShrinkTolerancePct})`}
                                                        className="w-24 h-7 px-2 rounded-lg border border-glass-border bg-canvas text-xs text-ink disabled:opacity-50"
                                                    />
                                                    <span className="text-[12px] text-ink-muted">percent</span>
                                                </div>
                                                <p className="mt-1 text-[11px] text-ink-muted leading-snug">
                                                    A smaller drop than this is treated as noise rather than
                                                    “Rollups shrank”.
                                                </p>
                                            </div>

                                            {/* Deploy-owned, so it is context and not a
                                                disabled input pretending to be editable. */}
                                            <p className="text-[11px] text-ink-muted leading-snug">
                                                Evidence older than{' '}
                                                <span className="text-ink-secondary tabular-nums">
                                                    {formatDuration(policy.envStatsMaxAgeSecs)}
                                                </span>{' '}
                                                is too stale to judge on.{' '}
                                                <span className="text-ink-muted/70">Set by the deploy.</span>
                                            </p>
                                        </StageCard>

                                        <Connector starved={!checkEnabled} into="act" />

                                        <StageCard
                                            stage="act"
                                            on={isAdmin ? driftAuto : null}
                                            muted={isAdmin && driftAuto && !checkEnabled}
                                            stat={actStat}
                                        >
                                            {isAdmin ? (
                                                <>
                                                    <ToggleRow
                                                        id="automation-drift-auto"
                                                        label="Automatically rebuild a source when drift is detected"
                                                        checked={driftAuto}
                                                        onChange={edit(setDriftAuto)}
                                                        disabled={false}
                                                    />
                                                    <DurationField
                                                        label="Minimum time between rebuilds"
                                                        value={cooldownSecs}
                                                        onChange={edit(setCooldownSecs)}
                                                        presets={COOLDOWN_PRESETS}
                                                        defaultSecs={settingsQ.data?.envRebuildMinIntervalSecs ?? 900}
                                                        min={0}
                                                        max={MAX_SECS}
                                                    />
                                                </>
                                            ) : <AdminOnlyCadence />}

                                            <div className="flex items-center gap-2">
                                                <label className="text-[12px] text-ink-secondary" htmlFor="automation-cap">
                                                    At most
                                                </label>
                                                <input
                                                    id="automation-cap"
                                                    type="number" min={0} max={MAX_CAP} step={1}
                                                    value={cap}
                                                    disabled={!isAdmin}
                                                    onChange={(e) => edit(setCap)(e.target.value)}
                                                    placeholder={`Default (${policy.envMaxActionsPerRun})`}
                                                    className="w-24 h-7 px-2 rounded-lg border border-glass-border bg-canvas text-xs text-ink disabled:opacity-50"
                                                />
                                                <span className="text-[12px] text-ink-muted">rebuilds per check</span>
                                            </div>
                                            <p className="text-[11px] text-ink-muted -mt-2 leading-snug">
                                                Anything over the cap waits for the next check, so turning
                                                this on cannot rebuild the whole fleet at once.
                                            </p>

                                            <fieldset className="space-y-1.5">
                                                <legend className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-1">
                                                    What to act on
                                                </legend>
                                                {DETECTORS.map(d => (
                                                    <label key={d.key} className="flex items-start gap-2 text-[12px] text-ink-secondary cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            checked={detectors.includes(d.key)}
                                                            disabled={!isAdmin}
                                                            onChange={(e) => {
                                                                setDirty(true)
                                                                setDetectors(prev => e.target.checked
                                                                    ? [...prev, d.key]
                                                                    : prev.filter(k => k !== d.key))
                                                            }}
                                                            className="accent-indigo-500 mt-0.5"
                                                        />
                                                        <span className="min-w-0">
                                                            {d.label}
                                                            <span className="block text-[11px] text-ink-muted">{d.hint}</span>
                                                        </span>
                                                    </label>
                                                ))}
                                            </fieldset>

                                            {/* The breaker's limit is deploy-owned and the API does
                                                not report it, so this states the rule and the live
                                                count rather than inventing a number. */}
                                            <p className="text-[11px] text-ink-muted leading-snug">
                                                A source that keeps needing the same rebuild is stopped
                                                and waits for a person
                                                {summary?.suspended != null && (
                                                    <>
                                                        {' — '}
                                                        <span className="text-ink-secondary tabular-nums">
                                                            {summary.suspended.toLocaleString()} stopped now
                                                        </span>
                                                    </>
                                                )}
                                                . <span className="text-ink-muted/70">
                                                    How many tries it allows is set by the deploy.
                                                </span>
                                            </p>
                                        </StageCard>
                                    </div>

                                    {/* A poll that failed AFTER the form was seeded is news, not a
                                        reason to take the form away. */}
                                    {readFailed && (
                                        <p
                                            role="status"
                                            className="mt-3.5 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[12px] text-ink-secondary leading-snug"
                                        >
                                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                                            These settings could not be refreshed just now, so the live
                                            counts may be out of date. Nothing you have typed was lost,
                                            and Save still works.
                                        </p>
                                    )}

                                    {changedElsewhere && (
                                        <p
                                            role="status"
                                            className="mt-3.5 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[12px] text-ink-secondary leading-snug"
                                        >
                                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                                            Someone else changed these settings while you were editing.
                                            Saving will replace theirs with what is on screen; Cancel keeps
                                            theirs.
                                        </p>
                                    )}

                                    {warnings.length > 0 && (
                                        <ul className="mt-3.5 space-y-1.5">
                                            {warnings.map(w => (
                                                <li
                                                    key={w.id}
                                                    className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5"
                                                >
                                                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                                                    <span className="text-[12px] text-ink-secondary leading-snug">{w.text}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}

                                    {impact && (
                                        <p className="mt-3.5 text-[12px] text-ink-muted tabular-nums">
                                            {impact}{' '}
                                            <span className="text-ink-muted/80">
                                                Measured against the saved policy, not these edits.
                                            </span>
                                        </p>
                                    )}
                                </>
                            )}
                        </div>

                        {/* The footer exists only once the real values have landed. A Save
                            painted over the initial state would write `detectors: []` — a
                            real configuration meaning "act on nothing" — on one click.
                            Until then the header × and Esc are the way out. */}
                        {ready && (
                            <footer className="flex items-center justify-end gap-3 px-5 py-3 border-t border-glass-border bg-canvas-elevated">
                                {isAdmin ? (
                                    <>
                                        <p className="mr-auto text-[11px] text-ink-muted hidden sm:block">
                                            Changes take effect within a minute — no restart needed.
                                        </p>
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="h-8 px-3 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onSave}
                                            disabled={saveRecon.isPending || saveCadence.isPending}
                                            className="inline-flex items-center gap-1.5 h-8 px-4 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                        >
                                            {(saveRecon.isPending || saveCadence.isPending) && (
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            )}
                                            Save
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <p className="mr-auto text-[11px] text-ink-muted">
                                            Only platform admins can change these settings.
                                        </p>
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="h-8 px-3 rounded-lg text-xs font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                        >
                                            Close
                                        </button>
                                    </>
                                )}
                            </footer>
                        )}
                    </motion.div>
                </div>
            )}
        </>,
        document.body,
    )
}
