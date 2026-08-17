/**
 * AutomationPanel — automatic reconciliation as the one pipeline it actually
 * is: ① Detect → ② Check → ③ Act, in the order it runs, inside the page it
 * governs.
 *
 * It replaces a 448px modal that listed the same three policies in the
 * OPPOSITE order, in three unrelated boxes, floating over the table they
 * govern, with units flipping between minutes and seconds from one box to the
 * next. Nothing in that layout showed that Detect feeds Check — so an operator
 * could turn Detect off and still read the Check interval as a promise. Here
 * the stages sit in order, the arrow between them goes amber when the upstream
 * stage is off, every cadence is one control in one unit, and the panel says
 * out loud which combinations contradict each other.
 *
 * The policy and the cadence are two endpoints but ONE stored record, so the
 * two writes are sequenced (policy first, then cadence), never raced.
 *
 * The cadence half is platform-admin only to READ, so a non-admin gets the
 * whole explanation, the live counts, and the policy controls disabled — the
 * explanation is the valuable half, and hiding it teaches nobody anything.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, ChevronRight, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { DurationField } from '@/components/ui/DurationField'
import { useToast } from '@/components/ui/toast'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { aggregationService, type AggregationCadence } from '@/services/aggregationService'
import type { FreshnessSummary } from '@/services/freshnessService'
import { automationWarnings } from './automationCopy'
import { StageCard } from './StageCard'
import { formatCheckInterval, lastPassBrief, pickLastPassRun } from './reconcileHealth'
import { useReconcileNow, useReconciliation, useSetReconciliationPolicy } from './useFreshness'

const SETTINGS_KEY = ['aggregation', 'settings'] as const

/** Backend bounds, in the one unit the panel speaks. */
const MAX_SECS = 86400
const MIN_PROBE_SECS = 15
const MIN_CHECK_SECS = 60
const MAX_CAP = 200

/** Preset ladders per stage. Deliberately disjoint across the three stages:
 *  two stages offering the same chip is exactly the confusion this panel
 *  exists to remove. */
const DETECT_PRESETS = [15, 30, 60, 600]
const CHECK_PRESETS = [300, 1800, 3600, 21600]
const COOLDOWN_PRESETS = [0, 900, 7200, MAX_SECS]

/** How long the edits have to settle before we ask the server what the stored
 *  policy would do to the fleet. The dry run scans every source. */
const IMPACT_DEBOUNCE_MS = 600

/** The four detectors, in the order the backend evaluates them. Each says
 *  what it looks for in the operator's terms, not the detector's. */
const DETECTORS: { key: string; label: string; hint: string }[] = [
    {
        key: 'overlay_missing',
        label: 'Rollups went missing',
        hint: 'A source that had rolled-up lineage now has none — usually a reload wiped it.',
    },
    {
        key: 'overlay_shrunk',
        label: 'Rollups shrank',
        hint: 'Far fewer rollups than the last build produced, with the underlying data unchanged.',
    },
    {
        key: 'never_aggregated',
        label: 'Never built',
        hint: 'An onboarded source with data and an ontology that has never had lineage built.',
    },
    {
        key: 'raw_drift',
        label: 'Counts changed',
        hint: 'Something outside the app changed the node or edge counts.',
    },
]

/** One stage's on/off, worded as the sentence it is rather than a bare label,
 *  so the switch's accessible name is the promise it makes. */
function ToggleRow({ label, checked, onChange, disabled }: {
    label: string
    checked: boolean
    onChange: (v: boolean) => void
    disabled: boolean
}) {
    return (
        <div className="flex items-start justify-between gap-2">
            <span className="text-[12px] text-ink-secondary leading-snug min-w-0">{label}</span>
            <ToggleSwitch
                size="sm"
                checked={checked}
                onChange={onChange}
                disabled={disabled}
                aria-label={label}
            />
        </div>
    )
}

/** The seam between two stages. Amber when the stage upstream is off, because
 *  that is the moment the downstream cadence stops meaning what it says. */
function Connector({ starved }: { starved: boolean }) {
    return (
        <div className="flex items-center justify-center shrink-0" aria-hidden>
            <ArrowRight
                className={cn(
                    'w-4 h-4 rotate-90 md:rotate-0',
                    starved ? 'text-amber-500' : 'text-ink-muted/50',
                )}
            />
        </div>
    )
}

export function AutomationPanel({ open, onToggle, isAdmin, summary }: {
    open: boolean
    onToggle: () => void
    isAdmin: boolean
    summary?: FreshnessSummary | null
}) {
    const qc = useQueryClient()
    const { showToast } = useToast()

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
    const [detectors, setDetectors] = useState<string[]>([])

    // Seed ONCE per opening. The reconciliation query polls every 60s, so
    // re-seeding on every payload would silently discard whatever the operator
    // was in the middle of typing — a modal never stayed open long enough for
    // that to bite, an in-page panel does.
    const seeded = useRef(false)
    useEffect(() => {
        if (!open) seeded.current = false
    }, [open])
    useEffect(() => {
        if (!open || seeded.current || !policy) return
        if (isAdmin && !settingsQ.data) return

        setCheckEnabled(policy.enabled ?? policy.envEnabled)
        setCheckSecs(policy.checkIntervalSecs ?? null)
        setCap(policy.maxActionsPerRun != null ? String(policy.maxActionsPerRun) : '')
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
        seeded.current = true
    }, [open, policy, settingsQ.data, cadence, isAdmin])

    const saveCadence = useMutation({
        mutationFn: (body: AggregationCadence) => aggregationService.putAggregationCadence(body),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: SETTINGS_KEY })
            showToast('success', 'Automation saved. Takes effect within a minute.')
            onToggle()
        },
        onError: (e: Error) => showToast('error', e.message || 'Could not save the cadence.'),
    })
    const saveRecon = useSetReconciliationPolicy()

    // What the STORED policy would do to the fleet right now. Debounced so
    // opening and closing the panel does not set a fleet scan going, and
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

    // ── Collapsed: one sentence, nothing else ─────────────────────────
    const effCheckSecs = policy ? (policy.checkIntervalSecs ?? policy.envCheckIntervalSecs) : null
    const effCap = policy ? (policy.maxActionsPerRun ?? policy.envMaxActionsPerRun) : null
    // Before the policy lands, say only what is true without it — naming the
    // stages here would put a second "Detect" on the page that means something
    // else than the stage card does.
    const summaryLine = !policy
        ? 'How this page keeps rolled-up lineage in step with its sources.'
        : (policy.enabled ?? policy.envEnabled)
            ? `Checking every ${formatCheckInterval(effCheckSecs)}, rebuilding at most `
                + `${effCap?.toLocaleString()} sources per check.`
            : 'Off. Problems are still detected and shown in the table; nothing is rebuilt.'

    const header = (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls="automation-stages"
            className="w-full flex items-center gap-2 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded-xl"
        >
            <span className="text-sm font-semibold text-ink shrink-0">Automation</span>
            <span className="text-[12px] text-ink-muted truncate">{summaryLine}</span>
            <ChevronRight
                aria-hidden
                className={cn(
                    'ml-auto w-4 h-4 shrink-0 text-ink-muted transition-transform duration-200 motion-reduce:transition-none',
                    open && 'rotate-90',
                )}
            />
        </button>
    )

    if (!open) {
        return (
            <section className="rounded-xl border border-glass-border bg-canvas-elevated">
                {header}
            </section>
        )
    }

    // ── Open ──────────────────────────────────────────────────────────
    const loading = reconQ.isLoading || (isAdmin && settingsQ.isLoading)
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
    const dryFindings = dryRun.data?.findings?.length ?? null
    const impact = dryFindings == null
        ? null
        : dryFindings === 0
            ? 'Right now a check would rebuild nothing.'
            : `Right now a check would rebuild ${dryFindings.toLocaleString()} `
                + `source${dryFindings === 1 ? '' : 's'}.`

    return (
        <section className="rounded-xl border border-glass-border bg-canvas-elevated">
            {header}

            <div id="automation-stages" className="px-4 pb-4">
                <p className="text-[12px] text-ink-muted leading-snug mb-3">
                    One pipeline, in the order it runs. Each stage feeds the next, so
                    turning one off changes what the ones after it can see.
                </p>

                {loading ? (
                    <div className="flex items-center gap-2 justify-center py-8 text-sm text-ink-muted">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                    </div>
                ) : (
                    <>
                        <div className="flex flex-col md:flex-row items-stretch gap-2">
                            <StageCard
                                stage="detect"
                                on={isAdmin ? probeEnabled : null}
                                stat={`${(summary?.total ?? 0).toLocaleString()} sources watched`}
                            >
                                {isAdmin ? (
                                    <>
                                        <ToggleRow
                                            label="Watch for changes made outside this app"
                                            checked={probeEnabled}
                                            onChange={setProbeEnabled}
                                            disabled={false}
                                        />
                                        <DurationField
                                            label="Look for changes every"
                                            value={probeSecs}
                                            onChange={setProbeSecs}
                                            presets={DETECT_PRESETS}
                                            defaultSecs={settingsQ.data?.envProbeIntervalSecs ?? 60}
                                            min={MIN_PROBE_SECS}
                                            max={MAX_SECS}
                                            disabled={!probeEnabled}
                                        />
                                    </>
                                ) : (
                                    <p className="text-[11px] text-ink-muted">
                                        Only platform admins can see this cadence.
                                    </p>
                                )}
                            </StageCard>

                            <Connector starved={isAdmin && !probeEnabled} />

                            <StageCard
                                stage="check"
                                on={checkEnabled}
                                muted={isAdmin && checkEnabled && !probeEnabled}
                                stat={checkStat}
                            >
                                <ToggleRow
                                    label="Check every source on a schedule"
                                    checked={checkEnabled}
                                    onChange={setCheckEnabled}
                                    disabled={!isAdmin}
                                />
                                <DurationField
                                    label="Check every"
                                    value={checkSecs}
                                    onChange={setCheckSecs}
                                    presets={CHECK_PRESETS}
                                    defaultSecs={policy?.envCheckIntervalSecs ?? 3600}
                                    min={MIN_CHECK_SECS}
                                    max={MAX_SECS}
                                    disabled={!isAdmin || !checkEnabled}
                                />
                            </StageCard>

                            <Connector starved={!checkEnabled} />

                            <StageCard
                                stage="act"
                                on={isAdmin ? driftAuto : null}
                                muted={isAdmin && driftAuto && !checkEnabled}
                                stat={actStat}
                            >
                                {isAdmin && (
                                    <>
                                        <ToggleRow
                                            label="Automatically rebuild a source when drift is detected"
                                            checked={driftAuto}
                                            onChange={setDriftAuto}
                                            disabled={false}
                                        />
                                        <DurationField
                                            label="Minimum time between rebuilds"
                                            value={cooldownSecs}
                                            onChange={setCooldownSecs}
                                            presets={COOLDOWN_PRESETS}
                                            defaultSecs={settingsQ.data?.envRebuildMinIntervalSecs ?? 900}
                                            min={0}
                                            max={MAX_SECS}
                                        />
                                    </>
                                )}

                                <div className="flex items-center gap-2">
                                    <label className="text-[12px] text-ink-secondary" htmlFor="automation-cap">
                                        At most
                                    </label>
                                    <input
                                        id="automation-cap"
                                        type="number" min={0} max={MAX_CAP} step={1}
                                        value={cap}
                                        disabled={!isAdmin}
                                        onChange={(e) => setCap(e.target.value)}
                                        placeholder={`Default (${policy?.envMaxActionsPerRun ?? 10})`}
                                        className="w-24 h-7 px-2 rounded-lg border border-glass-border bg-canvas text-xs text-ink disabled:opacity-50"
                                    />
                                    <span className="text-[12px] text-ink-muted">rebuilds per check</span>
                                </div>
                                <p className="text-[11px] text-ink-muted -mt-1.5">
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
                                                onChange={(e) => setDetectors(prev => e.target.checked
                                                    ? [...prev, d.key]
                                                    : prev.filter(k => k !== d.key))}
                                                className="accent-indigo-500 mt-0.5"
                                            />
                                            <span className="min-w-0">
                                                {d.label}
                                                <span className="block text-[11px] text-ink-muted">{d.hint}</span>
                                            </span>
                                        </label>
                                    ))}
                                </fieldset>
                            </StageCard>
                        </div>

                        {warnings.length > 0 && (
                            <ul className="mt-3 space-y-1.5">
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
                            <p className="mt-3 text-[12px] text-ink-muted">
                                {impact}{' '}
                                <span className="text-ink-muted/80">
                                    Measured against the saved policy, not these edits.
                                </span>
                            </p>
                        )}

                        {isAdmin ? (
                            <div className="flex items-center justify-end gap-2 mt-4">
                                <button
                                    type="button"
                                    onClick={onToggle}
                                    className="h-8 px-3 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={onSave}
                                    disabled={saveRecon.isPending || saveCadence.isPending}
                                    className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50"
                                >
                                    {(saveRecon.isPending || saveCadence.isPending) && (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    )}
                                    Save
                                </button>
                            </div>
                        ) : (
                            <p className="mt-4 text-[11px] text-ink-muted">
                                Only platform admins can change these settings. Changes take
                                effect within a minute — no restart needed.
                            </p>
                        )}
                    </>
                )}
            </div>
        </section>
    )
}
