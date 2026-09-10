/**
 * AutomationModal — automatic reconciliation as the one pipeline it actually
 * is: ① Detect → ② Check → ③ Act, in the order it runs.
 *
 * It replaces a 448px modal that listed the same three policies in the
 * OPPOSITE order, in three unrelated boxes, with units flipping between
 * minutes and seconds from one box to the next. Nothing in that layout showed
 * that Detect feeds Check — so an operator could turn Detect off and still
 * read the Check interval as a promise. Here the pipeline is stated once as a
 * diagram under the header, its connectors go dashed and amber and grey
 * everything downstream when a stage is starved, every cadence is one control
 * in one unit, and the modal says out loud which combinations contradict each
 * other.
 *
 * The stages stack full-width rather than sitting in three equal columns. The
 * columns were the defect: three boxes of settings reading as unrelated, and a
 * shared height that left Detect in a screen of void while Act ran long —
 * ranking Act highest when Detect is the stage that makes the other two mean
 * anything.
 *
 * Each stage's controls are a ledger — words on the left, the control on the
 * right, a hairline between — with everything past the essentials behind one
 * Advanced disclosure. Nothing was dropped; it was ranked.
 *
 * The policy and the cadence are two endpoints but ONE stored record, so the
 * two writes are sequenced (policy first, then cadence), never raced.
 *
 * The cadence half is platform-admin only to READ, so a non-admin gets the
 * whole explanation, the live counts, and the policy controls disabled — the
 * explanation is the valuable half, and hiding it teaches nobody anything.
 *
 * The shell is the house wizard chrome (``ViewWizard``'s ``WizardShell`` and
 * ``AssetOnboardingWizard``): gradient header with an icon tile, a rail row
 * beneath it, a scrolling body and a footer whose primary action is a gradient
 * button. Deliberately NOT Radix Dialog — a Radix modal that unmounts while
 * open strands ``body { pointer-events: none }`` and freezes the app. The
 * <Backdrop> is a plain CSS transition rendered OUTSIDE <AnimatePresence> and
 * as a SIBLING of the pointer-events-none wrapper, which is the house fix for
 * the StrictMode click-shield; the panel itself is inside <AnimatePresence> so
 * it leaves rather than vanishing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, Workflow, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { DurationField, formatDuration } from '@/components/ui/DurationField'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { aggregationService, type AggregationCadence, type AggregationTuning } from '@/services/aggregationService'
import type { FreshnessSummary } from '@/services/freshnessService'
import {
    CADENCE_LABEL, CHECK_PRESETS, COOLDOWN_PRESETS, DETECTORS, DETECT_PRESETS,
    MAX_SECS, MIN_CHECK_SECS, MIN_PROBE_SECS, automationWarnings, hintIdFor,
} from './automationCopy'
import { Advanced, PipelineRail, SettingRow, StageRow } from './StageRow'
import { lastPassBrief, pickLastPassRun } from './reconcileHealth'
import { useReconcileNow, useReconciliation, useSetReconciliationPolicy } from './useFreshness'

const SETTINGS_KEY = ['aggregation', 'settings'] as const

/** Bounds this modal owns alone; the shared ones live in ``automationCopy``
 *  because the per-source drawer edits the same three cadences. */
const MAX_CAP = 200
const MAX_SHRINK_PCT = 100

/** How long the edits have to settle before we ask the server what the stored
 *  policy would do to the fleet. The dry run scans every source. */
const IMPACT_DEBOUNCE_MS = 600

/** Number fields are mostly digits; the spinners are 16px of chrome that was
 *  wide enough to clip the placeholder beside it. */
const NUMBER_BOX = cn(
    'w-24 h-7 px-2 rounded-lg border border-glass-border bg-canvas',
    'text-xs text-ink tabular-nums placeholder:text-ink-muted/70',
    'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none',
    '[&::-webkit-inner-spin-button]:appearance-none',
)

/** A value the deploy owns. Marked, so it is not mistaken for a control that
 *  has been greyed out — those are two very different invitations. */
function DeployTag() {
    return (
        <span className="shrink-0 whitespace-nowrap rounded-full border border-glass-border px-1.5 py-0.5 text-[10px] text-ink-muted">
            set by the deploy
        </span>
    )
}

/** The container for a stage's ledger: a hairline off the prose above it, and
 *  one between every row. */
function Ledger({ children }: { children: React.ReactNode }) {
    return (
        <div className="mt-2.5 border-t border-glass-border/50 divide-y divide-glass-border/50">
            {children}
        </div>
    )
}

/**
 * The unsaved-changes guard, mirroring ``ProviderOnboardingWizard``'s
 * ``ConfirmCloseDialog``.
 *
 * Putting these settings in a modal handed them two brand-new ways to throw
 * work away that the inline panel they replaced did not have — Escape and the
 * backdrop — plus the header ×. All three ask first.
 *
 * It is a second portalled dialog, which is normally how this codebase has
 * frozen itself; the sanctioned shape avoids it by having NO exit animation
 * and no <AnimatePresence> of its own (``if (!open) return null``), so nothing
 * of it can be stranded over the page.
 *
 * It also traps Tab, which the shape it borrows from does not. That wizard's
 * parent has no focus trap at all, so its confirm could be as loose as it liked;
 * pairing the same dialog with ``useModalA11y`` created a new interaction —
 * Shift+Tab reached Save, Tab from Save cycled back into the form, and a
 * keyboard user could edit fields and SAVE while being asked whether to discard
 * them. The listener is registered in CAPTURE so it runs before the parent's,
 * and it pulls focus back in if it ever lands outside.
 */
function ConfirmCloseDialog({ open, onCancel, onConfirm }: {
    open: boolean
    onCancel: () => void
    onConfirm: () => void
}) {
    const panelRef = useRef<HTMLDivElement>(null)
    const keepRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (!open) return
        keepRef.current?.focus()

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Tab' || !panelRef.current) return
            const stops = panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')
            if (stops.length === 0) return
            const first = stops[0]
            const last = stops[stops.length - 1]
            const active = document.activeElement

            if (!panelRef.current.contains(active)) {
                e.preventDefault()
                first.focus()
            } else if (e.shiftKey && active === first) {
                e.preventDefault()
                last.focus()
            } else if (!e.shiftKey && active === last) {
                e.preventDefault()
                first.focus()
            }
        }

        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
    }, [open])

    if (!open) return null

    return (
        <>
            <Backdrop open onClick={onCancel} zClassName="z-[120]" className="bg-black/50" />
            <div className="fixed inset-0 z-[120] flex items-center justify-center px-4 pointer-events-none">
                <motion.div
                    ref={panelRef}
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="automation-discard-title"
                    aria-describedby="automation-discard-body"
                    initial={{ opacity: 0, y: 12, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    className="pointer-events-auto w-full max-w-md rounded-2xl border border-glass-border bg-canvas-elevated p-6 shadow-lg"
                >
                    <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
                            <AlertTriangle className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 id="automation-discard-title" className="text-lg font-semibold text-ink">
                                Discard these automation changes?
                            </h3>
                            <p id="automation-discard-body" className="mt-1 text-sm text-ink-muted">
                                Your unsaved changes will be lost if you close now. The schedule
                                keeps running on whatever it was last saved with.
                            </p>
                        </div>
                    </div>
                    <div className="mt-6 flex items-center justify-end gap-3">
                        <button
                            ref={keepRef}
                            type="button"
                            onClick={onCancel}
                            className="rounded-xl border border-glass-border px-4 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-black/5 dark:hover:bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                        >
                            Keep editing
                        </button>
                        <button
                            type="button"
                            onClick={onConfirm}
                            className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600 outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                        >
                            Discard
                        </button>
                    </div>
                </motion.div>
            </div>
        </>
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
    const { notify } = useAppNotifications()

    const reconQ = useReconciliation()
    const policy = reconQ.data?.policy

    // Readable at ingestion-read server-side (the PUT stays admin), so the
    // read-only rendering shows non-admins the real Detect and Act state
    // instead of "hidden" pills.
    const settingsQ = useQuery({
        queryKey: SETTINGS_KEY,
        queryFn: () => aggregationService.getAggregationSettings(),
        enabled: open,
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
    /** Rollup storage for every rebuild this stage queues. Two states only —
     *  `true` and `'auto'` — both written explicitly, never by clearing the
     *  key: an absent key means "inherit", and inheritance cannot walk a
     *  stored `true` back to Auto. */
    const [finePairs, setFinePairs] = useState<true | 'auto'>('auto')

    // Closed by default: the essentials are the pipeline, and everything here
    // is a tuning knob that most readers open this modal without needing.
    const [checkAdvanced, setCheckAdvanced] = useState(false)
    const [actAdvanced, setActAdvanced] = useState(false)

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
    /** Armed by a dismissal gesture while there are unsaved edits. */
    const [showCloseConfirm, setShowCloseConfirm] = useState(false)

    const remoteSig = JSON.stringify([
        policy?.enabled, policy?.checkIntervalSecs, policy?.maxActionsPerRun,
        policy?.shrinkTolerancePct, policy?.detectors,
        cadence?.probeEnabled, cadence?.probeIntervalSecs,
        cadence?.driftAutoRebuild, cadence?.rebuildMinIntervalSecs,
        settingsQ.data?.tuning?.materializeFinePairs,
    ])

    // Read through a ref inside ``requestClose``: that callback is the argument
    // to ``useModalA11y``'s effect, so a new identity when ``dirty`` flips would
    // re-run the effect — refocusing the dialog and stealing the caret on the
    // very first keystroke of an edit. The ref is written in an effect, not
    // during render, and effects flush before the next input event can arrive,
    // so a dismissal can never read a stale flag.
    const dirtyRef = useRef(dirty)
    useEffect(() => { dirtyRef.current = dirty }, [dirty])
    const confirmRef = useRef(showCloseConfirm)
    useEffect(() => { confirmRef.current = showCloseConfirm }, [showCloseConfirm])

    /**
     * Escape, the backdrop and the × are dismissal gestures, not decisions:
     * putting a modal in front of this form gave it two brand-new ways to throw
     * away work that the inline panel it replaced did not have. They ask first
     * once something has been typed, and pass straight through when nothing has.
     *
     * With the prompt already up, a dismissal means "back out of the prompt".
     * Escape summons it, so Escape is the key a reader will press to leave it —
     * and without this branch that press set ``showCloseConfirm`` to the value
     * it already held, React bailed out of the render, and the guard answered
     * the key that raised it with silence.
     *
     * Cancel is deliberately NOT routed here. It is a labelled button that says
     * what it does, and confirming an explicit discard is the kind of politeness
     * that trains people to click through dialogs.
     */
    const requestClose = useCallback(() => {
        if (confirmRef.current) {
            setShowCloseConfirm(false)
            return
        }
        if (dirtyRef.current) {
            setShowCloseConfirm(true)
            return
        }
        onClose()
    }, [onClose])

    const dialogRef = useModalA11y(open, requestClose)

    /**
     * Every way out of the prompt — Keep editing, Escape, its backdrop — unmounts
     * the button holding focus, so focus falls to <body>. ``useModalA11y``'s trap
     * only engages when the active element is the panel or one of its end stops,
     * so from <body> it never engages at all and the next Tab walks into the page
     * behind the modal. Handled here rather than in each dismissal, because there
     * are three of them and a fourth would forget.
     */
    const wasConfirming = useRef(false)
    useEffect(() => {
        if (wasConfirming.current && !showCloseConfirm && open) dialogRef.current?.focus()
        wasConfirming.current = showCloseConfirm
    }, [showCloseConfirm, open, dialogRef])

    useEffect(() => {
        if (open) return
        setSeeded(false)
        setDirty(false)
        setShowCloseConfirm(false)
        setCheckAdvanced(false)
        setActAdvanced(false)
    }, [open])

    useEffect(() => {
        if (!open || dirty || !policy) return
        if (!settingsQ.data) return

        setCheckEnabled(policy.enabled ?? policy.envEnabled)
        setCheckSecs(policy.checkIntervalSecs ?? null)
        setCap(policy.maxActionsPerRun != null ? String(policy.maxActionsPerRun) : '')
        setShrinkPct(policy.shrinkTolerancePct != null ? String(policy.shrinkTolerancePct) : '')
        // Unset means every detector is on, so seed from the full list. An
        // EMPTY stored array is a real configuration ("act on nothing") and
        // must survive as such — never a truthiness test.
        setDetectors(policy.detectors ?? policy.allDetectors)

        // Fall back to the EFFECTIVE env default the server reports, never
        // a hardcoded guess: it means a save that only meant to change one
        // interval round-trips the real current state of every toggle
        // instead of flipping it fleet-wide.
        setProbeEnabled(cadence?.probeEnabled ?? settingsQ.data.envProbeEnabled ?? true)
        setProbeSecs(cadence?.probeIntervalSecs ?? null)
        setDriftAuto(cadence?.driftAutoRebuild ?? settingsQ.data.envDriftAutoRebuild ?? true)
        setCooldownSecs(cadence?.rebuildMinIntervalSecs ?? null)
        // Same rule as the toggles above: the stored default if there is one,
        // otherwise whatever the server says it resolves to. `false` is not
        // reachable from this control, so it seeds as Auto — the honest
        // reading, since forcing the diagonal is not "always full detail".
        const resolvedFine = settingsQ.data.tuning?.materializeFinePairs
            ?? settingsQ.data.envMaterializeFinePairs
        setFinePairs(resolvedFine === true || resolvedFine === 'true' ? true : 'auto')
        setSeededSig(remoteSig)
        setSeeded(true)
    }, [open, dirty, policy, settingsQ.data, cadence, remoteSig])

    /** Marks the form edited before applying the change, so one payload
     *  arriving mid-edit cannot undo what was just typed. */
    const edit = <T,>(set: (v: T) => void) => (v: T) => {
        setDirty(true)
        set(v)
    }

    // Rollup storage is the third link, and the terminal one: it writes
    // `tuning_json` where the other two write `cadence_json` and the
    // reconciliation policy. All three land in the same settings row, which is
    // why they are sequenced rather than raced.
    const saveTuning = useMutation({
        mutationFn: (body: AggregationTuning) => aggregationService.putAggregationSettings(body),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: SETTINGS_KEY })
            // The controls now hold what the server holds, so the modal may go
            // back to adopting whatever anyone else writes — and closing can
            // stop asking whether it is safe.
            setDirty(false)
            notify('success', 'Automation saved. Takes effect within a minute.')
            onClose()
        },
        onError: (e: Error) => notify(
            'error',
            `Watch policy and cadence saved, but the rollup storage default did not: ${
                e.message || 'unknown error'
            }. Save again to retry it.`,
        ),
    })
    const saveCadence = useMutation({
        mutationFn: (body: AggregationCadence) => aggregationService.putAggregationCadence(body),
        onSuccess: () => {
            // Only `materializeFinePairs` is sent. The server MERGES `tuning`,
            // so the workspace Defaults dialog's caps and floors survive this
            // write untouched — a read-modify-write here would race them.
            saveTuning.mutate({ materializeFinePairs: finePairs })
        },
        // The policy PUT that precedes this one has already landed (see
        // onSave), so a generic "could not save" would be a lie about half
        // the form. Say exactly which half failed; Save again re-sends the
        // policy with identical values (harmless) and retries the cadence.
        onError: (e: Error) => notify(
            'error',
            `Watch policy saved, but the Detect and Act settings did not save: ${
                e.message || 'unknown error'
            }. Save again to retry them.`,
        ),
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
            notify('error', 'Check no more often than once a minute, and at least once a day.')
            return
        }
        const capNum = cap.trim() === '' ? null : Number(cap)
        if (capNum != null && (!Number.isFinite(capNum) || capNum < 0 || capNum > MAX_CAP)) {
            // Reveal the field being complained about: a notification pointing at a
            // control folded away behind a disclosure is a dead end.
            setActAdvanced(true)
            notify('error', 'Rebuilds per check must be between 0 and 200.')
            return
        }
        const shrinkNum = shrinkPct.trim() === '' ? null : Number(shrinkPct)
        if (shrinkNum != null && (!Number.isFinite(shrinkNum) || shrinkNum < 0 || shrinkNum > MAX_SHRINK_PCT)) {
            setCheckAdvanced(true)
            notify('error', 'The shrink allowance must be between 0 and 100 percent.')
            return
        }
        if (probeSecs != null && (!Number.isFinite(probeSecs) || probeSecs < MIN_PROBE_SECS || probeSecs > MAX_SECS)) {
            notify('error', 'Look for changes no more often than every 15 seconds, and at least once a day.')
            return
        }
        if (cooldownSecs != null && (!Number.isFinite(cooldownSecs) || cooldownSecs < 0 || cooldownSecs > MAX_SECS)) {
            notify('error', 'The wait between rebuilds must be between 0 seconds and 24 hours.')
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
                    notify('error', e.message || 'Could not save the reconciliation policy.'),
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
    const readFailed = reconQ.isError || settingsQ.isError
    const ready = seeded && policy != null
    const changedElsewhere = seeded && dirty && remoteSig !== seededSig
    const warnings = automationWarnings(
        { enabled: checkEnabled, detectors, maxActionsPerRun: cap.trim() === '' ? null : Number(cap) },
        { probeEnabled },
    )

    // Starvation runs DOWNSTREAM: Detect off does not merely dim Check, it dims
    // Act too, because what reaches Act is only as fresh as what reached Check.
    const starvedIntoCheck = !probeEnabled
    const starvedIntoAct = !checkEnabled

    const pass = pickLastPassRun(reconQ.data?.runs)
    const checkStat = pass
        ? (lastPassBrief(pass) ?? `${pass.scanned.toLocaleString()} checked · all in sync`)
        : 'No check has run yet'
    const actStat = pass
        ? `${pass.actions.toLocaleString()} rebuilt at the last check`
        : 'Nothing rebuilt yet'
    // No fleet summary means no number — "0 sources watched" is a claim, not a
    // placeholder.
    const detectStat = summary == null
        ? undefined
        : `${summary.total.toLocaleString()} sources`
            + (probeEnabled ? ' watched' : ' — watching is off')
    const dryFindings = dryRun.data?.findings?.length ?? null
    // One footer line, not two competing ones. The dry run is measured against
    // what is STORED, so the sentence says so rather than leaving a second
    // sentence to disclaim the first.
    const footerNote = dryFindings == null
        ? 'Changes take effect within a minute — no restart needed.'
        : dryFindings === 0
            ? 'With the settings as saved, a check right now would rebuild nothing.'
            : `With the settings as saved, a check right now would rebuild `
                + `${dryFindings.toLocaleString()} source${dryFindings === 1 ? '' : 's'}.`

    return createPortal(
        <>
            {/* Plain CSS transition, never inside <AnimatePresence>, and a
                SIBLING of the pointer-events-none wrapper below rather than its
                child — nested, its onClick never receives the click. This pair
                is the house fix for the StrictMode click-shield. */}
            <Backdrop open={open} onClick={requestClose} zClassName="z-[60]" className="bg-black/50" />
            {/* The panel animates out; the ``fixed inset-0`` wrapper is OUTSIDE the
                presence tree, exactly as AssetOnboardingWizard has it, so no exit
                can ever leave a full-viewport node behind. That is not a live bug in
                framer-motion 11, but if one ever stranded, both ways out are already
                gone by then — the Backdrop is opacity-0/pointer-events-none and the
                Escape listener was torn down at ``open=false`` — leaving a visible,
                pointer-events-auto, unclosable panel. This repo has shipped that bug
                three times; keeping the wrapper out of the tree costs nothing. */}
            <div className="fixed inset-0 z-[61] flex items-start sm:items-center justify-center p-3 sm:p-4 pointer-events-none">
                <AnimatePresence>
                    {open && (
                        <motion.div
                            ref={dialogRef}
                            tabIndex={-1}
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="automation-title"
                            initial={{ scale: 0.95, opacity: 0, y: 20 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.95, opacity: 0, y: 20 }}
                            transition={{ duration: 0.12 }}
                            className="pointer-events-auto outline-none w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg overflow-hidden"
                        >
                        {/* Header, rail and footer are flex children of a bounded
                            column, so only the middle scrolls: a settings modal
                            that hides its own Save is the failure mode of the
                            dialog this replaces. */}
                        <header className="flex items-center justify-between gap-4 px-6 sm:px-8 py-5 border-b border-glass-border bg-gradient-to-r from-black/[0.02] to-transparent dark:from-white/[0.02] shrink-0">
                            <div className="flex items-center gap-4 min-w-0">
                                <div className="w-12 h-12 shrink-0 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-md">
                                    <Workflow className="w-6 h-6" />
                                </div>
                                <div className="min-w-0">
                                    <h2 id="automation-title" className="text-xl font-bold text-ink">
                                        Automation
                                    </h2>
                                    <p className="text-sm text-ink-muted">
                                        How the system watches your data and repairs it.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={requestClose}
                                aria-label="Close automation settings"
                                className="p-2 shrink-0 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                            >
                                <X className="w-5 h-5 text-ink-muted" />
                            </button>
                        </header>

                        {/* The pipeline itself, in the slot the wizards give
                            their stepper — but a live diagram, not navigation.
                            It is stated once here so the sections below can get
                            on with being settings.

                            Gated on ``ready`` with everything else: a rail drawn
                            from the initial state would assert three stages are
                            on before anyone has read whether they are. */}
                        {ready && (
                        <div className="px-6 sm:px-8 py-4 bg-black/[0.02] dark:bg-white/[0.02] border-b border-glass-border shrink-0">
                            <PipelineRail
                                detect={probeEnabled}
                                check={checkEnabled}
                                act={driftAuto}
                                starvedIntoCheck={starvedIntoCheck}
                                starvedIntoAct={starvedIntoAct}
                            />
                            <p className="mt-2.5 text-[11px] text-ink-muted leading-snug">
                                One pipeline, in the order it runs. Each stage feeds the next, so
                                turning one off changes what the ones after it can see.
                            </p>
                        </div>
                        )}

                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 sm:px-8 py-5">
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
                                    {/* Run order, top to bottom. The rail above
                                        already carries the dependency between
                                        them, so these are free to be settings. */}
                                    <div className="space-y-6">
                                    <StageRow
                                        stage="detect"
                                        on={probeEnabled}
                                        stat={detectStat}
                                    >
                                        <Ledger>
                                            <SettingRow
                                                label="Watch for changes made outside this app"
                                                htmlFor="automation-probe"
                                            >
                                                <ToggleSwitch
                                                    id="automation-probe"
                                                    size="sm"
                                                    checked={probeEnabled}
                                                    onChange={edit(setProbeEnabled)}
                                                    disabled={!isAdmin}
                                                    aria-label="Watch for changes made outside this app"
                                                />
                                            </SettingRow>
                                            <SettingRow label={CADENCE_LABEL.detect}>
                                                <DurationField
                                                    label={CADENCE_LABEL.detect}
                                                    value={probeSecs}
                                                    onChange={edit(setProbeSecs)}
                                                    presets={DETECT_PRESETS}
                                                    defaultSecs={settingsQ.data?.envProbeIntervalSecs ?? 60}
                                                    min={MIN_PROBE_SECS}
                                                    max={MAX_SECS}
                                                    disabled={!isAdmin || !probeEnabled}
                                                />
                                            </SettingRow>
                                        </Ledger>
                                    </StageRow>

                                    <StageRow
                                        stage="check"
                                        on={checkEnabled}
                                        muted={starvedIntoCheck}
                                        stat={checkStat}
                                    >
                                        <Ledger>
                                            <SettingRow
                                                label="Check every source on a schedule"
                                                htmlFor="automation-check"
                                                disabled={!isAdmin}
                                            >
                                                <ToggleSwitch
                                                    id="automation-check"
                                                    size="sm"
                                                    checked={checkEnabled}
                                                    onChange={edit(setCheckEnabled)}
                                                    disabled={!isAdmin}
                                                    aria-label="Check every source on a schedule"
                                                />
                                            </SettingRow>
                                            <SettingRow label={CADENCE_LABEL.check}>
                                                <DurationField
                                                    label={CADENCE_LABEL.check}
                                                    value={checkSecs}
                                                    onChange={edit(setCheckSecs)}
                                                    presets={CHECK_PRESETS}
                                                    defaultSecs={policy.envCheckIntervalSecs}
                                                    min={MIN_CHECK_SECS}
                                                    max={MAX_SECS}
                                                    disabled={!isAdmin || !checkEnabled}
                                                />
                                            </SettingRow>
                                        </Ledger>

                                        <Advanced
                                            stage="check"
                                            open={checkAdvanced}
                                            onToggle={() => setCheckAdvanced(v => !v)}
                                        >
                                            <SettingRow
                                                label="Allow rollups to shrink by"
                                                htmlFor="automation-shrink"
                                                disabled={!isAdmin}
                                                hint="A smaller drop than this is treated as noise rather than “Rollups shrank”."
                                            >
                                                <span className="flex items-center gap-2">
                                                    <input
                                                        id="automation-shrink"
                                                        aria-describedby={hintIdFor('automation-shrink')}
                                                        type="number" min={0} max={MAX_SHRINK_PCT} step={1}
                                                        value={shrinkPct}
                                                        disabled={!isAdmin}
                                                        onChange={(e) => edit(setShrinkPct)(e.target.value)}
                                                        placeholder={`Default ${policy.envShrinkTolerancePct}`}
                                                        className={NUMBER_BOX}
                                                    />
                                                    <span className="text-[12px] text-ink-muted">percent</span>
                                                </span>
                                            </SettingRow>

                                            {/* Deploy-owned, so it is context and not a
                                                disabled input pretending to be editable. */}
                                            <SettingRow
                                                label="Evidence must be newer than"
                                                hint="Older stored counts are too stale to judge on."
                                            >
                                                <span className="flex items-center gap-2">
                                                    <span className="text-[12px] text-ink-secondary tabular-nums">
                                                        {formatDuration(policy.envStatsMaxAgeSecs)}
                                                    </span>
                                                    <DeployTag />
                                                </span>
                                            </SettingRow>

                                            {/* The detectors decide what COUNTS as a finding,
                                                which is this stage's job. They used to sit under
                                                ③ Act, next to the cap — which decides how many
                                                rebuilds follow a finding, a different question. */}
                                            {/* The <fieldset> is wrapped rather than
                                                being the divided child itself: a
                                                <legend> cuts its own fieldset's top
                                                border, so the ledger hairline came
                                                out running THROUGH the words. */}
                                            <div className="pt-2.5">
                                            <fieldset>
                                                <legend className="text-[13px] font-medium text-ink">
                                                    What counts as a finding
                                                </legend>
                                                <div className="mt-0.5 divide-y divide-glass-border/40">
                                                    {DETECTORS.map(d => (
                                                        <SettingRow
                                                            key={d.key}
                                                            label={d.label}
                                                            htmlFor={`automation-detector-${d.key}`}
                                                            disabled={!isAdmin}
                                                            hint={d.hint}
                                                        >
                                                            <input
                                                                id={`automation-detector-${d.key}`}
                                                                aria-describedby={hintIdFor(`automation-detector-${d.key}`)}
                                                                type="checkbox"
                                                                checked={detectors.includes(d.key)}
                                                                disabled={!isAdmin}
                                                                onChange={(e) => {
                                                                    setDirty(true)
                                                                    setDetectors(prev => e.target.checked
                                                                        ? [...prev, d.key]
                                                                        : prev.filter(k => k !== d.key))
                                                                }}
                                                                className="w-4 h-4 accent-indigo-500 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:cursor-not-allowed"
                                                            />
                                                        </SettingRow>
                                                    ))}
                                                </div>
                                            </fieldset>
                                            </div>
                                        </Advanced>
                                    </StageRow>

                                    <StageRow
                                        stage="act"
                                        on={driftAuto}
                                        muted={starvedIntoCheck || starvedIntoAct}
                                        stat={actStat}
                                    >
                                        <Ledger>
                                            <SettingRow
                                                label="Automatically rebuild a source when drift is detected"
                                                htmlFor="automation-drift-auto"
                                            >
                                                <ToggleSwitch
                                                    id="automation-drift-auto"
                                                    size="sm"
                                                    checked={driftAuto}
                                                    onChange={edit(setDriftAuto)}
                                                    disabled={!isAdmin}
                                                    aria-label="Automatically rebuild a source when drift is detected"
                                                />
                                            </SettingRow>
                                            {/* ``0s`` is the most consequential
                                                chip on the row and sits in its
                                                least conspicuous position, at the
                                                head of an ascending ladder that
                                                should not be reordered. So it
                                                states its consequence once
                                                chosen, rather than being dressed
                                                up before anyone picks it. */}
                                            <SettingRow
                                                label={CADENCE_LABEL.act}
                                                hint={cooldownSecs === 0
                                                    ? 'No wait at all: a source can be rebuilt again the moment the next check finds drift.'
                                                    : undefined}
                                            >
                                                <DurationField
                                                    label={CADENCE_LABEL.act}
                                                    value={cooldownSecs}
                                                    onChange={edit(setCooldownSecs)}
                                                    presets={COOLDOWN_PRESETS}
                                                    defaultSecs={settingsQ.data?.envRebuildMinIntervalSecs ?? 900}
                                                    min={0}
                                                    max={MAX_SECS}
                                                    disabled={!isAdmin}
                                                />
                                            </SettingRow>
                                        </Ledger>

                                        <Advanced
                                            stage="act"
                                            open={actAdvanced}
                                            onToggle={() => setActAdvanced(v => !v)}
                                        >
                                            <SettingRow
                                                label="At most, each check"
                                                htmlFor="automation-cap"
                                                disabled={!isAdmin}
                                                hint="Anything over the cap waits for the next check, so turning this on cannot rebuild the whole fleet at once."
                                            >
                                                <span className="flex items-center gap-2">
                                                    <input
                                                        id="automation-cap"
                                                        aria-describedby={hintIdFor('automation-cap')}
                                                        type="number" min={0} max={MAX_CAP} step={1}
                                                        value={cap}
                                                        disabled={!isAdmin}
                                                        onChange={(e) => edit(setCap)(e.target.value)}
                                                        placeholder={`Default ${policy.envMaxActionsPerRun}`}
                                                        className={NUMBER_BOX}
                                                    />
                                                    <span className="text-[12px] text-ink-muted">rebuilds</span>
                                                </span>
                                            </SettingRow>

                                            {/* Not a toggle: neither state is the absence of the
                                                other, and "off" would have to mean Auto — a mode
                                                with its own behaviour, not a disabled feature. It
                                                sits in Act because it governs what the rebuilds
                                                this stage queues actually write. */}
                                            <SettingRow
                                                label="Rollup storage"
                                                hint={finePairs === true
                                                    ? 'Every combination is pre-created, so no drill comes back thin. A graph whose rollups would exceed the write budget fails instead — and because forcing full detail skips the up-front estimate, it fails part-way through.'
                                                    : 'Full detail wherever it fits what the graph store can hold; above that, the diagonal is stored and finer granularities are derived at read time. Slower drills on the largest graphs, but it degrades instead of failing.'}
                                            >
                                                <span
                                                    className="flex shrink-0 rounded-lg border border-glass-border p-0.5"
                                                    role="radiogroup"
                                                    aria-label="Rollup storage"
                                                >
                                                    {([
                                                        ['auto', 'Auto'] as const,
                                                        ['full', 'Full detail'] as const,
                                                    ]).map(([id, label]) => {
                                                        const selected = (id === 'full') === (finePairs === true)
                                                        return (
                                                            <button
                                                                key={id}
                                                                type="button"
                                                                role="radio"
                                                                aria-checked={selected}
                                                                disabled={!isAdmin}
                                                                onClick={() => edit(setFinePairs)(id === 'full' ? true : 'auto')}
                                                                className={cn(
                                                                    'rounded-md px-2.5 py-1 text-[12px] transition-colors duration-150',
                                                                    'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                                    selected
                                                                        ? 'bg-indigo-500/10 text-ink font-medium'
                                                                        : 'text-ink-muted hover:text-ink-secondary',
                                                                    !isAdmin && 'cursor-not-allowed opacity-60',
                                                                )}
                                                            >
                                                                {label}
                                                            </button>
                                                        )
                                                    })}
                                                </span>
                                            </SettingRow>

                                            {/* The breaker's limit is deploy-owned and the API does
                                                not report it, so this states the rule and the live
                                                count rather than inventing a number. */}
                                            <SettingRow
                                                label="Stop a source that keeps failing"
                                                hint="A source that keeps needing the same rebuild waits for a person instead."
                                            >
                                                <span className="flex items-center gap-2">
                                                    {summary?.suspended != null && (
                                                        <span className="text-[12px] text-ink-secondary tabular-nums">
                                                            {summary.suspended.toLocaleString()} stopped now
                                                        </span>
                                                    )}
                                                    <DeployTag />
                                                </span>
                                            </SettingRow>
                                        </Advanced>
                                    </StageRow>
                                    </div>

                                    {/* A poll that failed AFTER the form was seeded is news, not a
                                        reason to take the form away. */}
                                    {readFailed && (
                                        <p
                                            role="status"
                                            className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[12px] text-ink-secondary leading-snug"
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
                                            className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[12px] text-ink-secondary leading-snug"
                                        >
                                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                                            Someone else changed these settings while you were editing.
                                            Saving will replace theirs with what is on screen; Cancel keeps
                                            theirs.
                                        </p>
                                    )}

                                    {warnings.length > 0 && (
                                        <ul className="mt-4 space-y-1.5">
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
                                </>
                            )}
                        </div>

                        {/* The footer exists only once the real values have landed. A Save
                            painted over the initial state would write `detectors: []` — a
                            real configuration meaning "act on nothing" — on one click.
                            Until then the header × and Esc are the way out. */}
                        {ready && (
                            <footer className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-6 sm:px-8 py-5 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                                {isAdmin ? (
                                    <>
                                        {/* One line, not two competing ones — and
                                            shown at every width. It carries the
                                            modal's only live consequence figure,
                                            which the two lines it replaced did not
                                            both do; inheriting the `sm:` gate from
                                            the one that was merely a reassurance
                                            hid the number on a phone. The footer
                                            wraps, so it takes its own row there. */}
                                        <p className="mr-auto text-[12px] text-ink-muted tabular-nums">
                                            {footerNote}
                                        </p>
                                        {/* Cancel is a labelled button that says what it
                                            does, so it goes straight through. Confirming
                                            an explicit discard is the kind of politeness
                                            that trains people to click past dialogs. */}
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="px-5 py-2.5 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onSave}
                                            disabled={saveRecon.isPending || saveCadence.isPending || saveTuning.isPending}
                                            className={cn(
                                                'flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150',
                                                'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                saveRecon.isPending || saveCadence.isPending || saveTuning.isPending
                                                    ? 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed'
                                                    : 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md',
                                            )}
                                        >
                                            {(saveRecon.isPending || saveCadence.isPending || saveTuning.isPending) && (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            )}
                                            Save
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <p className="mr-auto text-[12px] text-ink-muted">
                                            Only platform admins can change these settings.
                                        </p>
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

            <ConfirmCloseDialog
                open={showCloseConfirm}
                onCancel={() => setShowCloseConfirm(false)}
                onConfirm={() => {
                    setShowCloseConfirm(false)
                    onClose()
                }}
            />
        </>,
        document.body,
    )
}
