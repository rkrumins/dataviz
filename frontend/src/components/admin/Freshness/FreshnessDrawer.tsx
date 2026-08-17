/**
 * FreshnessDrawer — per-source detail: the full freshness doc, an on-demand
 * live "Probe now", and the recent refresh-event history.
 *
 * The base doc loads without a probe (no provider/FalkorDB work). "Probe now"
 * re-fetches with ``probe=true`` — one bounded provider call — and reveals the
 * live fingerprint/counts and the drift verdict.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
    Activity, AlertTriangle, ArrowUpRight, CheckCircle2, ChevronRight, Database, Eraser,
    RefreshCw, Radar, RotateCcw, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useToast } from '@/components/ui/toast'
import { Backdrop } from '@/components/ui/Backdrop'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { DurationField, formatDuration } from '@/components/ui/DurationField'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'
import { jobHistoryPath } from '../job-history/shared'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import {
    FRESHNESS_KEYS,
    useReconcileNow, useRefreshSource, useSetFreshnessSettings, useSourceFreshness,
} from './useFreshness'
import { checkNowToast } from './reconcileHealth'
import { DRIFT_SPEC, DriftStateBadge, REASON_LABEL, type DriftState } from './DriftStateBadge'
import { OverlayIntegrityMeter } from './OverlayIntegrityMeter'
import { EvidencePair, ReconcileWhy, reconcileEvidenceRows } from './reconcileEvidence'
import {
    CADENCE_LABEL, CHECK_PRESETS, COOLDOWN_PRESETS, DETECT_PRESETS,
    MAX_SECS, MIN_CHECK_SECS, MIN_PROBE_SECS, hintIdFor,
} from './automationCopy'
import { SettingRow, StageRow } from './StageRow'
import { useActiveJobs } from './useActiveJobs'
import { AggStatusPill, FreshnessBadges, MasteryTag, timeUntil } from './FreshnessRow'
import { isPlatformMastered } from './freshnessTriage'
import { activityFromEvent, recentActivityEvents } from './lastActivity'
import type {
    FailureCategory, FreshnessDoc, FreshnessSettingsPatch, RefreshEventSummary,
} from '@/services/freshnessService'

function shortFp(fp?: string | null): string {
    if (!fp) return '—'
    return fp.length > 14 ? `${fp.slice(0, 14)}…` : fp
}

// Friendly names for the cache endpoint segments; anything else is sentence-
// cased (matching the casing of these — "Aggregated lineage", not Title Case).
const ENDPOINT_LABELS: Record<string, string> = {
    aggregated: 'Aggregated lineage',
    'children-with-edges': 'Hierarchy children',
    children: 'Hierarchy children',
    'top-level': 'Top-level roots',
}

function endpointLabel(key: string): string {
    if (ENDPOINT_LABELS[key]) return ENDPOINT_LABELS[key]
    const spaced = key.replace(/-/g, ' ')
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-ink-muted mb-0.5">{label}</div>
            <div className="text-sm text-ink truncate">{children}</div>
        </div>
    )
}

function fmtInterval(secs?: number | null): string {
    if (secs == null) return '—'
    // Zero is a real cadence with a consequence worth spelling out, so it is
    // the one duration this does not hand to the shared formatter.
    if (secs === 0) return 'Off (rebuild every change)'
    return formatDuration(secs)
}

const SOURCE_LABEL: Record<string, string> = {
    custom: 'Custom',
    global: 'Global default',
    default: 'System default',
}

const SAVE_BTN = 'inline-flex items-center h-7 px-2.5 rounded-lg text-[11px] font-semibold '
    + 'text-white bg-indigo-600 hover:bg-indigo-700 transition-colors '
    + 'motion-reduce:transition-none disabled:opacity-50 outline-none '
    + 'focus-visible:ring-2 focus-visible:ring-indigo-500/50'

const QUIET_BTN = 'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold '
    + 'text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 '
    + 'transition-colors motion-reduce:transition-none disabled:opacity-50 outline-none '
    + 'focus-visible:ring-2 focus-visible:ring-indigo-500/50'

const SELECT_BOX = 'h-7 px-2 rounded-lg border border-glass-border bg-canvas text-[12px] text-ink '
    + 'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:opacity-50'

/** How long an operator can hold this source's rebuilds for. Hours and days,
 *  because a snooze is measured in "until I have looked at it", never in
 *  seconds — which is why this is a list of choices and not a DurationField. */
const SNOOZE_CHOICES: { label: string; secs: number }[] = [
    { label: '1 hour', secs: 3600 },
    { label: '8 hours', secs: 8 * 3600 },
    { label: '24 hours', secs: 24 * 3600 },
    { label: '7 days', secs: 7 * 24 * 3600 },
]

/** The verdicts that mean the sweep found something. ``suspended`` is here
 *  too: the breaker stopped acting on the source, but the finding that got it
 *  there is exactly what the operator opened this drawer to read. */
const FINDING_STATES = new Set<string>([
    'drifting', 'overlayMissing', 'neverBuilt', 'suspended',
])

/**
 * One stage's cadence: what it resolves to, where that value came from, and —
 * for anyone who can manage the source — a staged editor for the override.
 *
 * Staged rather than saved on change because ``DurationField``'s custom cell
 * fires ``onChange`` per keystroke: typing "300" would PATCH 3, then 30, and
 * the first two are below the server's floor. Committing the presets
 * immediately and the box on Save would give one control two commit rules,
 * which is worse than one Save button.
 */
function CadenceEditor({
    stage, stored, resolved, source, presets, min, max,
    editable, pending, saveLabel, onSave,
}: {
    stage: keyof typeof CADENCE_LABEL
    /** The stored per-source override; null = inherit. */
    stored?: number | null
    /** The effective value after override → global → default resolution. */
    resolved?: number | null
    source?: string | null
    presets: number[]
    min: number
    max: number
    editable: boolean
    pending: boolean
    /** Three Save buttons live in this drawer; each must announce which
     *  setting it commits or a screen-reader user cannot tell them apart. */
    saveLabel: string
    onSave: (secs: number | null) => void
}) {
    const { showToast } = useToast()
    const [value, setValue] = useState<number | null>(stored ?? null)
    const label = CADENCE_LABEL[stage]

    const save = () => {
        if (value != null && (!Number.isFinite(value) || value < min || value > max)) {
            // formatDuration, not fmtInterval: this is a bound, and a floor of
            // zero reads "0s" here rather than "Off (rebuild every change)".
            showToast('error',
                `Choose a time between ${formatDuration(min)} and ${formatDuration(max)}.`)
            return
        }
        onSave(value)
    }

    return (
        <SettingRow label={label} hint={SOURCE_LABEL[source ?? 'default'] ?? source}>
            {editable ? (
                <span className="flex flex-wrap items-center justify-end gap-2">
                    <DurationField
                        label={label}
                        value={value}
                        onChange={setValue}
                        presets={presets}
                        // Honest while nothing is overridden. Once something is,
                        // the resolved value IS the override — the doc is never
                        // told what this source would inherit instead — so the
                        // caption only misreads for the moment between pressing
                        // Reset and pressing Save.
                        defaultSecs={resolved ?? presets[0]}
                        min={min}
                        max={max}
                    />
                    <button
                        type="button"
                        onClick={save}
                        disabled={pending}
                        aria-label={saveLabel}
                        className={SAVE_BTN}
                    >
                        Save
                    </button>
                </span>
            ) : (
                <span className="text-[12px] text-ink-secondary tabular-nums">
                    {fmtInterval(resolved)}
                </span>
            )}
        </SettingRow>
    )
}

/**
 * ① Detect — is anything watching this source for changes made outside the
 * app, and how often. The per-source override existed on the server with no
 * UI anywhere, so until now the only way to quieten one noisy source was to
 * turn detection off for the whole fleet.
 *
 * The snooze lives here, at the head of the pipeline, because it is the
 * control an operator opens this drawer to reach in a hurry. What it actually
 * holds is ③ Act, which the hint says in as many words.
 */
function DetectSection({ doc }: { doc: FreshnessDoc }) {
    const { showToast } = useToast()
    const canManage = usePermission('workspace:datasource:manage', doc.workspaceId ?? undefined)
    const setSettings = useSetFreshnessSettings()

    // null means "follow the fleet setting", which this drawer cannot read —
    // a ds:manage reader is not a platform admin. Treating inherit as on
    // mirrors the reconciliation toggle in ③ Act, which has always done this.
    const on = doc.probeEnabled !== false
    const pausedFor = timeUntil(doc.pausedUntil)

    const patch = (body: FreshnessSettingsPatch, ok: string) => {
        setSettings.mutate({ dsId: doc.dataSourceId, ...body }, {
            onSuccess: () => showToast('success', ok),
            onError: (e) => showToast('error', e.message || 'Could not update the setting.'),
        })
    }

    const snooze = (secs: number, label: string) => {
        patch(
            { pausedUntil: new Date(Date.now() + secs * 1000).toISOString() },
            `Automation paused for ${label}.`,
        )
    }

    return (
        <StageRow
            stage="detect"
            on={on}
            stat={doc.statsAsOf
                ? <>Counts last read <TimeStamp at={doc.statsAsOf} icon={null} colorByAge={false} /></>
                : undefined}
        >
            <div className="mt-2.5 border-t border-glass-border/50 divide-y divide-glass-border/50">
                <SettingRow
                    label="Watch this source for changes made outside the app"
                    htmlFor="freshness-probe"
                    disabled={!canManage}
                >
                    <ToggleSwitch
                        id="freshness-probe"
                        size="sm"
                        checked={on}
                        onChange={(next) => patch(
                            { probeEnabled: next },
                            next ? 'Now watching this source for changes.'
                                : 'No longer watching this source for changes.',
                        )}
                        disabled={!canManage || setSettings.isPending}
                        aria-label="Watch this source for changes made outside the app"
                    />
                </SettingRow>

                <CadenceEditor
                    stage="detect"
                    stored={doc.probeIntervalSecs}
                    resolved={doc.resolvedProbeIntervalSecs}
                    source={doc.probeIntervalSource}
                    presets={DETECT_PRESETS}
                    min={MIN_PROBE_SECS}
                    max={MAX_SECS}
                    editable={canManage}
                    pending={setSettings.isPending}
                    saveLabel="Save detect frequency"
                    onSave={(secs) => patch(
                        { probeIntervalSecs: secs },
                        secs == null ? 'Detect frequency reset to the default.'
                            : 'Detect frequency updated.',
                    )}
                />

                {canManage && (pausedFor ? (
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
                        <div className="min-w-0 flex-1">
                            <p className="text-[13px] text-ink-secondary leading-snug">
                                Paused — automation resumes in {pausedFor}.
                            </p>
                            <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">
                                {new Date(doc.pausedUntil as string).toLocaleString()}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => patch({ pausedUntil: null }, 'Automation resumed.')}
                            disabled={setSettings.isPending}
                            className={cn(QUIET_BTN, 'shrink-0 ml-auto')}
                        >
                            <RotateCcw className="w-3.5 h-3.5" /> Resume now
                        </button>
                    </div>
                ) : (
                    <SettingRow
                        label="Pause automation for"
                        htmlFor="freshness-snooze"
                        hint="Changes are still detected and checked — only rebuilds are held, so a source can be left alone without losing sight of it."
                    >
                        <select
                            id="freshness-snooze"
                            aria-describedby={hintIdFor('freshness-snooze')}
                            disabled={setSettings.isPending}
                            // Always empty: this picks an action, not a stored
                            // value. What was chosen reads back as the expiry,
                            // which replaces this row entirely.
                            value=""
                            onChange={(e) => {
                                const choice = SNOOZE_CHOICES
                                    .find(c => String(c.secs) === e.target.value)
                                if (choice) snooze(choice.secs, choice.label)
                            }}
                            className={SELECT_BOX}
                        >
                            <option value="">Choose…</option>
                            {SNOOZE_CHOICES.map(c => (
                                <option key={c.secs} value={c.secs}>{c.label}</option>
                            ))}
                        </select>
                    </SettingRow>
                ))}
            </div>
        </StageRow>
    )
}

/**
 * ② Check — does this source's rolled-up lineage still match its data, when
 * was that last judged, and what was found.
 *
 * Everything shown here is read off the state row: the sweep stamps it, this
 * section never recomputes it, and the freshness read path makes no graph call.
 */
function CheckSection({ doc }: { doc: FreshnessDoc }) {
    const { showToast } = useToast()
    const canManage = usePermission('workspace:datasource:manage', doc.workspaceId ?? undefined)
    const isAdmin = usePermission('system:admin')
    const setSettings = useSetFreshnessSettings()
    const reconcileNow = useReconcileNow()

    const state = (doc.driftState ?? undefined) as DriftState | undefined
    const spec = state ? DRIFT_SPEC[state] : undefined
    // A versioned graph is mastered in Postgres with FalkorDB as a rebuildable
    // read cache, so version control maintains its rollups on every publish and
    // this section's controls would be inert. Explain that instead of offering
    // switches that do nothing.
    const isManaged = state === 'managed'
    // ``blocked`` is the one verdict that means this stage is genuinely not
    // running for this source — there is no ontology to judge against.
    const on = state !== 'blocked'

    return (
        <StageRow stage="check" on={on} muted={doc.probeEnabled === false}>
            <div className="mt-2 flex flex-wrap items-center gap-2">
                <DriftStateBadge state={doc.driftState} />
                {spec && <p className="text-[11px] text-ink-muted leading-relaxed">{spec.title}</p>}
            </div>

            {isManaged ? (
                <div className="mt-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.05] p-2.5 space-y-1.5">
                    <p className="text-[11px] text-ink-secondary leading-relaxed">
                        This graph is mastered here and stored in Postgres. FalkorDB
                        holds a rebuildable copy of it, so counting rollups in the
                        graph would measure the copy rather than the source of
                        truth — which is why no integrity meter is shown.
                    </p>
                    <p className="text-[11px] text-ink-secondary leading-relaxed">
                        Version control rebuilds the rolled-up lineage itself as each
                        change is published, and falls back to a full rebuild when it
                        cannot do that incrementally. Nothing here needs to.
                    </p>
                    {doc.workspaceId && (
                        <Link
                            to={`/workspaces/${doc.workspaceId}`}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:underline"
                        >
                            Open version control for this source
                            <ArrowUpRight className="w-3 h-3" />
                        </Link>
                    )}
                </div>
            ) : (
                <OverlayIntegrityMeter
                    observed={doc.observedAggregatedEdges}
                    expected={doc.expectedAggregatedEdges}
                    statsAsOf={doc.statsAsOf}
                    unobservable={doc.driftState === 'unobservable'}
                    className="pt-1.5"
                />
            )}

            {/* Why it's drifting. The sweep has stamped this on every
                evaluation — including the ones it deliberately did not act on
                — and until now nothing displayed it, so a paused or opted-out
                source showed a verdict word and no reason for it. */}
            {state && FINDING_STATES.has(state) && doc.lastFindingReason && (
                <ReconcileWhy
                    mode="open"
                    reason={doc.lastFindingReason}
                    evidence={doc.lastFindingEvidence}
                    foundAt={doc.lastFindingAt}
                    // No ``dataSourceId``: its link opens this source in
                    // Freshness, and this IS Freshness.
                    className="mt-2.5"
                />
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-2.5">
                <Fact label="Last checked">
                    {doc.lastCheckedAt
                        ? <TimeStamp at={doc.lastCheckedAt} icon={null} colorByAge={false} />
                        : <span className="text-ink-muted">Not yet</span>}
                </Fact>
                <Fact label="Next check">
                    {doc.nextCheckAt
                        ? (timeUntil(doc.nextCheckAt) ?? 'Due now')
                        : <span className="text-ink-muted">Due now</span>}
                </Fact>
                <Fact label="Last reconciled">
                    {doc.lastReconciledAt
                        ? <TimeStamp at={doc.lastReconciledAt} icon={null} colorByAge={false} />
                        : <span className="text-ink-muted">Never</span>}
                </Fact>
                <Fact label="Why">
                    {doc.lastReconcileReason
                        ? (
                            <span>
                                {REASON_LABEL[doc.lastReconcileReason] ?? doc.lastReconcileReason}
                                {doc.lastReconcileMode && (
                                    <span className="text-ink-muted">
                                        {' · '}{doc.lastReconcileMode === 'auto' ? 'Automatic' : 'Manual'}
                                    </span>
                                )}
                            </span>
                        )
                        : <span className="text-ink-muted">—</span>}
                </Fact>
            </div>

            {/* Hidden, not disabled, for a versioned source: the cadence
                governs a sweep that will never act on it. */}
            {!isManaged && (
                <div className="mt-2.5 border-t border-glass-border/50">
                    <CadenceEditor
                        stage="check"
                        stored={doc.reconcileIntervalOverrideSecs}
                        resolved={doc.resolvedReconcileIntervalSecs}
                        source={doc.reconcileIntervalSource}
                        presets={CHECK_PRESETS}
                        min={MIN_CHECK_SECS}
                        max={MAX_SECS}
                        editable={canManage}
                        pending={setSettings.isPending}
                        saveLabel="Save check frequency"
                        onSave={(secs) => setSettings.mutate(
                            // Send ONLY this field: an explicit null clears an
                            // override, so a full-object PATCH would wipe the
                            // settings we did not mean to touch.
                            { dsId: doc.dataSourceId, reconcileCheckIntervalSecs: secs },
                            {
                                onSuccess: () => showToast('success', secs == null
                                    ? 'Check frequency reset to the default.'
                                    : 'Check frequency updated.'),
                                onError: (e) => showToast('error',
                                    e.message || 'Could not update the check frequency.'),
                            },
                        )}
                    />

                    {isAdmin && (
                        <button
                            type="button"
                            onClick={() => reconcileNow.mutate(
                                { dataSourceIds: [doc.dataSourceId] },
                                {
                                    onSuccess: (res) => showToast('success', checkNowToast(res)),
                                    onError: (e) => showToast('error',
                                        e.message || 'Could not run reconciliation.'),
                                },
                            )}
                            disabled={reconcileNow.isPending}
                            className={cn(QUIET_BTN, 'my-2')}
                        >
                            <RefreshCw className={cn('w-3.5 h-3.5', reconcileNow.isPending && 'animate-spin')} />
                            {reconcileNow.isPending ? 'Checking…' : 'Check now'}
                        </button>
                    )}
                </div>
            )}
        </StageRow>
    )
}

/**
 * ③ Act — may a finding rebuild this source, and how often at most.
 *
 * Both settings were split across two panels that never named each other: the
 * "Automatic reconciliation" switch sat with the check cadence, and the
 * rebuild window sat in a box of its own above it. They are one decision.
 */
function ActSection({ doc }: { doc: FreshnessDoc }) {
    const { showToast } = useToast()
    const canManage = usePermission('workspace:datasource:manage', doc.workspaceId ?? undefined)
    const setSettings = useSetFreshnessSettings()

    const isManaged = doc.driftState === 'managed'
    const auto = doc.autoReconcile !== false
    // The rebuild-interval override lives on the aggregation state row, which
    // only exists once a source has been built — a never-aggregated source
    // would 404 the PATCH. (① Detect and the snooze upsert instead, so they
    // stay editable here.) Detect that and say so, rather than showing a
    // control that cannot succeed.
    const neverBuilt = !doc.lastAggregatedAt
        && (doc.aggregationStatus == null || doc.aggregationStatus === 'none')
    const pausedFor = timeUntil(doc.pausedUntil)

    return (
        <StageRow
            stage="act"
            on={!isManaged && auto}
            // Two ways this stage delivers less than its settings claim: the
            // stage before it is off, or a person is holding it. Both dim what
            // it delivers and neither touches its controls.
            muted={doc.probeEnabled === false || pausedFor != null}
        >
            {pausedFor && (
                <p className="mt-2 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                    Paused for another {pausedFor} — nothing will be rebuilt until then.
                </p>
            )}
            {isManaged ? (
                <p className="mt-2 text-[11px] text-ink-secondary leading-relaxed">
                    Version control rebuilds this source's rolled-up lineage on every
                    publish, so automation never acts on it.
                </p>
            ) : (
                <div className="mt-2.5 border-t border-glass-border/50 divide-y divide-glass-border/50">
                    <SettingRow
                        label="Rebuild this source automatically when a check finds drift"
                        htmlFor="freshness-auto-reconcile"
                        disabled={!canManage}
                        hint={auto
                            ? undefined
                            : 'Off — drift is still detected and shown here, but nothing is rebuilt automatically.'}
                    >
                        <ToggleSwitch
                            id="freshness-auto-reconcile"
                            size="sm"
                            checked={auto}
                            onChange={(next) => setSettings.mutate(
                                { dsId: doc.dataSourceId, autoReconcileEnabled: next },
                                {
                                    onSuccess: () => showToast('success', next
                                        ? 'Automatic reconciliation on for this source.'
                                        : 'Automatic reconciliation off for this source.'),
                                    onError: (e) => showToast('error',
                                        e.message || 'Could not update the setting.'),
                                },
                            )}
                            disabled={!canManage || setSettings.isPending}
                            aria-label="Rebuild this source automatically when a check finds drift"
                        />
                    </SettingRow>

                    {canManage && neverBuilt ? (
                        <p className="py-2.5 text-[11px] text-ink-muted">
                            You can set a custom cadence once this source has been built
                            for the first time.
                        </p>
                    ) : (
                        <CadenceEditor
                            stage="act"
                            stored={doc.rebuildOverrideSecs}
                            resolved={doc.resolvedRebuildIntervalSecs}
                            source={doc.rebuildIntervalSource}
                            presets={COOLDOWN_PRESETS}
                            min={0}
                            max={MAX_SECS}
                            editable={canManage}
                            pending={setSettings.isPending}
                            saveLabel="Save rebuild cadence"
                            onSave={(secs) => setSettings.mutate(
                                { dsId: doc.dataSourceId, rebuildMinIntervalSecs: secs },
                                {
                                    onSuccess: () => showToast('success', secs == null
                                        ? 'Rebuild cadence reset to the default.'
                                        : 'Rebuild cadence updated.'),
                                    onError: (e) => showToast('error',
                                        e.message || 'Could not update rebuild cadence.'),
                                },
                            )}
                        />
                    )}
                </div>
            )}
        </StageRow>
    )
}

/** One row of the refresh history.
 *
 *  Was ``origin · outcome``, which asked the reader to decode a vocabulary.
 *  Now it says whether it was automatic or a person, what set it off, and —
 *  on click — the counts that justified it, which is the "why did this
 *  rebuild happen" question the whole audit trail exists to answer. */
function ActivityRow({ event }: { event: RefreshEventSummary }) {
    const [open, setOpen] = useState(false)
    const evidence = event.evidence as Record<string, unknown> | null | undefined
    const hasEvidence = !!evidence && Object.keys(evidence).length > 0
    const activity = activityFromEvent(event)
    const automatic = event.mode === 'automatic'
    const showMode = event.mode === 'automatic' || event.mode === 'manual'

    // Shared with Job History's ReconcileWhy — the two surfaces reach the same
    // fact from opposite ends and must never disagree about what it says.
    const rows = reconcileEvidenceRows(evidence)

    return (
        <li className="text-xs">
            <button
                type="button"
                onClick={() => hasEvidence && setOpen(v => !v)}
                aria-expanded={hasEvidence ? open : undefined}
                className={cn(
                    'w-full flex items-center justify-between gap-3 py-1 text-left rounded-lg',
                    hasEvidence && 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] px-1 -mx-1',
                )}
            >
                <span className="min-w-0 flex items-center gap-1.5">
                    <span className="text-ink truncate">{activity.label}</span>
                    {activity.originLabel && !activity.label.toLowerCase().includes(activity.originLabel.toLowerCase()) && (
                        <span className="text-[10px] text-ink-muted shrink-0">
                            · {activity.originLabel}
                        </span>
                    )}
                    {showMode && (
                    <span
                        title={automatic
                            ? 'Started by automatic reconciliation'
                            : `Started by ${event.actor && event.actor !== 'internal' ? event.actor : 'a person'}`}
                        className={cn(
                            'shrink-0 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold',
                            automatic
                                ? 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20'
                                : 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
                        )}
                    >
                        {automatic ? 'Auto' : 'Manual'}
                    </span>
                    )}
                </span>
                <TimeStamp at={event.ts} icon={null} colorByAge={false} />
            </button>
            {open && rows.length > 0 && (
                <dl className="mt-0.5 mb-1.5 ml-1 pl-2 border-l border-glass-border space-y-0.5">
                    {rows.map(r => (
                        <div key={r.label} className="flex items-baseline justify-between gap-3">
                            <dt className="text-[10px] uppercase tracking-wide text-ink-muted">{r.label}</dt>
                            <dd><EvidencePair before={r.before} after={r.after} /></dd>
                        </div>
                    ))}
                    {/* The other half of the trail: this event decided on a
                        rebuild, and that rebuild is a job someone can inspect. */}
                    {event.jobId && (
                        <div className="pt-0.5">
                            <Link
                                to={jobHistoryPath({ search: event.jobId })}
                                className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                            >
                                View the rebuild it started
                                <ArrowUpRight className="w-2.5 h-2.5" />
                            </Link>
                        </div>
                    )}
                </dl>
            )}
        </li>
    )
}

/**
 * "Cache contents" — the source's live-cache footprint: total entries, a
 * per-endpoint breakdown, and the last-known-good fallback the cache serves
 * when a live rebuild fails. ``cacheKeyCount`` null = the cache couldn't be
 * read (unavailable); 0 = nothing cached yet — two distinct states.
 */
function CacheContents({ doc }: { doc: FreshnessDoc }) {
    const count = doc.cacheKeyCount
    const byEndpoint = Object.entries(doc.cacheKeyCountByEndpoint ?? {})
        .sort((a, b) => b[1] - a[1] || endpointLabel(a[0]).localeCompare(endpointLabel(b[0])))
    const lkg = doc.lkgCount != null
        ? `${doc.lkgCount.toLocaleString()} cached${doc.lkgOldestAgeSecs != null ? ` · oldest ${Math.round(doc.lkgOldestAgeSecs / 60)}m` : ''}`
        : '—'

    return (
        <div className="rounded-xl border border-glass-border bg-glass-base/30 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Database className="w-4 h-4 text-violet-500" /> Cache contents
                </div>
                {count != null && count > 0 && (
                    <span className="text-[11px] tabular-nums text-ink-muted">
                        {count.toLocaleString()} {count === 1 ? 'entry' : 'entries'}
                    </span>
                )}
            </div>

            {count == null ? (
                <p className="text-[11px] text-ink-muted">
                    Cache contents unavailable — the cache could not be read.
                </p>
            ) : count === 0 ? (
                <p className="text-[11px] text-ink-muted">Nothing cached yet.</p>
            ) : (
                <ul className="space-y-1">
                    {byEndpoint.map(([key, n]) => (
                        <li key={key} className="flex items-center justify-between gap-3 text-xs">
                            <span className="text-ink-secondary truncate">{endpointLabel(key)}</span>
                            <span className="tabular-nums text-ink-muted shrink-0">{n.toLocaleString()}</span>
                        </li>
                    ))}
                </ul>
            )}

            {/* Last known good: the snapshot served if a live rebuild fails. */}
            <div className="flex items-center justify-between gap-3 text-xs pt-1.5 border-t border-glass-border/60">
                <span className="text-ink-muted">Last known good</span>
                <span className="tabular-nums text-ink-muted shrink-0">{lkg}</span>
            </div>
        </div>
    )
}

/**
 * Category-specific resolution guidance for a failed rebuild (spec §9c). Each
 * entry supplies the plain-language WHY, the HOW-to-resolve steps, and which
 * CTAs to offer — with the *recommended* action as the filled primary. Copy is
 * white-label and non-alarmist: it explains and directs, it doesn't apologize.
 */
interface CategoryGuidance {
    why: string
    how: string
    /** Extra directive that isn't itself a button (e.g. "assign an ontology"). */
    note?: string
    showClear: boolean
    showRetry: boolean
    /** Which CTA is the recommended, filled primary. */
    primary: 'clear' | 'retry'
    /** Inline caution shown under Retry when a retry is likely to fail again. */
    retryWarning?: string
}

const GUIDANCE: Record<FailureCategory, CategoryGuidance> = {
    out_of_memory: {
        why: 'The graph store ran out of memory while building aggregated lineage for this large source.',
        how: 'Free up memory in the graph store (remove unused graphs) or raise its memory limit, then retry the rebuild.',
        showClear: true, showRetry: true, primary: 'clear',
        retryWarning: 'may fail again until memory is freed.',
    },
    provider_unavailable: {
        why: 'The graph store was unreachable during the rebuild.',
        how: 'Check that the graph store is back online, then retry the rebuild.',
        showClear: true, showRetry: true, primary: 'retry',
    },
    ontology: {
        why: "This data source has no ontology assigned, so its lineage can't be aggregated.",
        how: 'Assign an ontology to this data source, then rebuild its lineage.',
        note: "Set an ontology in this source's settings before rebuilding — a retry will fail until then.",
        showClear: true, showRetry: false, primary: 'clear',
    },
    timeout: {
        why: 'The rebuild took longer than the allowed time.',
        how: 'Retry the rebuild. If it keeps timing out, the source may be too large for the current limit.',
        showClear: true, showRetry: true, primary: 'retry',
    },
    conflict: {
        why: 'Another rebuild for this source was already running.',
        how: 'Wait for the running rebuild to finish, then retry if the lineage is still out of date.',
        showClear: true, showRetry: true, primary: 'retry',
    },
    unknown: {
        why: "The rebuild didn't complete.",
        how: 'Retry the rebuild. If it keeps failing, check the technical details below.',
        showClear: true, showRetry: true, primary: 'retry',
    },
}

/**
 * The resolution-guidance panel: what happened → why → how to resolve, plus
 * the Clear-cache / Retry-rebuild CTAs and a muted verbatim-error disclosure.
 * Guidance renders for everyone; the CTAs are ds:manage-gated (``canManage``).
 */
function ResolutionGuidance({ doc, canManage, busy, onClear, onRetry }: {
    doc: FreshnessDoc
    canManage: boolean
    busy: boolean
    onClear: () => void
    onRetry: () => void
}) {
    const category: FailureCategory = doc.lastFailureCategory ?? 'unknown'
    // ?? unknown: a future backend category we don't map yet must not throw.
    const g = GUIDANCE[category] ?? GUIDANCE.unknown
    const attempts = doc.retryCount != null && doc.retryCount > 1 ? doc.retryCount : null

    const primaryCls = 'text-white bg-indigo-600 hover:bg-indigo-700'
    const secondaryCls = 'text-ink-muted border border-glass-border hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
    const clearBtn = g.showClear ? (
        <button
            key="clear" type="button" onClick={onClear} disabled={busy}
            className={cn('inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50', g.primary === 'clear' ? primaryCls : secondaryCls)}
        >
            <Eraser className="w-3.5 h-3.5" /> Clear cache
        </button>
    ) : null
    const retryBtn = g.showRetry ? (
        <button
            key="retry" type="button" onClick={onRetry} disabled={busy}
            className={cn('inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50', g.primary === 'retry' ? primaryCls : secondaryCls)}
        >
            <RotateCcw className="w-3.5 h-3.5" /> Retry rebuild
        </button>
    ) : null
    const buttons = g.primary === 'clear' ? [clearBtn, retryBtn] : [retryBtn, clearBtn]

    return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4 space-y-3">
            {/* What */}
            <div className="flex items-start gap-2.5">
                <span className="shrink-0 mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                </span>
                <div className="min-w-0">
                    <h3 className="text-sm font-bold text-ink">Lineage rebuild failed</h3>
                    {attempts && (
                        <p className="text-[11px] text-ink-muted">Failed after {attempts} attempts</p>
                    )}
                </div>
            </div>

            {/* Why */}
            <p className="text-xs text-ink-secondary leading-relaxed">{g.why}</p>

            {/* How */}
            <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-ink-muted">How to resolve</div>
                <p className="text-xs text-ink-secondary leading-relaxed">{g.how}</p>
                {g.note && <p className="text-xs text-ink-secondary leading-relaxed">{g.note}</p>}
            </div>

            {/* CTAs */}
            {canManage && (
                <div className="space-y-2 pt-0.5">
                    <div className="flex flex-wrap items-center gap-2">{buttons}</div>
                    {g.showClear && (
                        <p className="text-[11px] text-ink-muted">
                            Clear cache resets cached data and the stuck state — safe to run now. It doesn't rebuild lineage.
                        </p>
                    )}
                    {g.showRetry && g.retryWarning && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
                            <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> Retry rebuild {g.retryWarning}
                        </p>
                    )}
                </div>
            )}

            {/* Details — the verbatim error, for operators. */}
            {doc.lastFailureReason && (
                <details className="group pt-1">
                    <summary className="flex items-center gap-1 cursor-pointer select-none list-none text-[11px] text-ink-muted hover:text-ink-secondary transition-colors">
                        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" /> Details
                    </summary>
                    <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-glass-border bg-black/[0.03] dark:bg-white/[0.03] p-2 text-[10px] font-mono text-ink-muted whitespace-pre-wrap break-words">
                        {doc.lastFailureReason}
                    </pre>
                </details>
            )}
        </div>
    )
}

export function FreshnessDrawer({ dsId, isOpen, onClose, workspaceName }: {
    dsId: string | null
    isOpen: boolean
    onClose: () => void
    workspaceName?: string
}) {
    // The host keys this component on ``dsId``, so each open remounts fresh
    // and probe starts false — no reset effect needed.
    const [probe, setProbe] = useState(false)
    const [retryOpen, setRetryOpen] = useState(false)

    const { data: doc, isLoading, isFetching, error } = useSourceFreshness(dsId, probe, isOpen)
    const activityFeed = recentActivityEvents(doc?.events ?? [], doc?.lastCheckedAt)
    const probing = probe && isFetching
    const { byDataSource } = useActiveJobs()
    const qc = useQueryClient()

    // Probe writes the counts facet — fleet meter + recon due-ness share it.
    useEffect(() => {
        if (!probe || probing || error || !doc?.liveFingerprint) return
        void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.fleetPrefix })
        void qc.invalidateQueries({ queryKey: FRESHNESS_KEYS.reconciliation })
    }, [probe, probing, error, doc?.liveFingerprint, qc])

    const { showToast } = useToast()
    const canManage = usePermission('workspace:datasource:manage', doc?.workspaceId ?? undefined)
    const isAdmin = usePermission('system:admin')
    const refresh = useRefreshSource()
    const reconcileNow = useReconcileNow()
    const name = doc?.name || dsId || 'this source'

    // Clear cache is the safe reset — no confirm; Retry rebuilds (may fail
    // again for OOM) so it confirms first. Both invalidate fleet + doc via the
    // mutation's onSuccess, so the panel updates in place.
    const doClear = () => {
        if (!dsId) return
        refresh.mutate({ dsId, scope: 'clear' }, {
            onSuccess: () => showToast('success', `Cache cleared for ${name}.`),
            onError: (e) => showToast('error', e.message || 'Could not clear the cache.'),
        })
    }
    const doRetry = () => {
        if (!dsId) return
        refresh.mutate({ dsId, scope: 'rollups' }, {
            onSuccess: () => showToast('success', `Lineage rebuild queued for ${name}.`),
            onError: (e) => showToast('error', e.message || 'Could not start the rebuild.'),
        })
        setRetryOpen(false)
    }
    const doRebuildLineage = () => {
        if (!dsId) return
        refresh.mutate({ dsId, scope: 'rollups' }, {
            onSuccess: () => showToast('success', `Lineage rebuild queued for ${name}.`),
            onError: (e) => showToast('error', e.message || 'Could not start the rebuild.'),
        })
    }
    const doReconcileThisSource = () => {
        if (!dsId) return
        reconcileNow.mutate(
            { dataSourceIds: [dsId] },
            {
                onSuccess: (res) => showToast('success', checkNowToast(res)),
                onError: (e) => showToast('error', e.message || 'Could not run reconciliation.'),
            },
        )
    }
    const retryMessage = doc?.lastFailureCategory === 'out_of_memory'
        ? 'Retries the aggregated-lineage rebuild for this source. It may fail again until memory is freed in the graph store.'
        : 'Retries the aggregated-lineage rebuild for this source. This can take a while.'

    const mastered = doc ? isPlatformMastered(doc) : false

    return createPortal(
        <>
            <Backdrop open={isOpen && !!dsId} onClick={onClose} />
            {/* No AnimatePresence: this portaled popover unmounts instantly on close so an interrupted exit can't strand an invisible click-blocker over the page. It still animates in. */}
            <>
                {isOpen && dsId && (
                    <motion.div
                        role="dialog" aria-label="Data source freshness"
                        initial={{ x: '100%' }} animate={{ x: 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 40 }}
                        className="fixed right-0 top-0 z-50 h-full w-full max-w-xl overflow-y-auto bg-canvas border-l border-glass-border shadow-2xl"
                    >
                        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 p-4 bg-canvas/80 backdrop-blur border-b border-glass-border">
                            <div className="min-w-0">
                                <h2 className="text-base font-bold text-ink truncate">
                                    {doc?.name || dsId}
                                </h2>
                                {dsId && (
                                    <Link
                                        to={jobHistoryPath({ dataSourceId: dsId })}
                                        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                                    >
                                        Open in Job History
                                        <ArrowUpRight className="w-3 h-3" />
                                    </Link>
                                )}
                                <p className="text-[11px] text-ink-muted truncate">
                                    {doc?.providerName || 'Unknown provider'}
                                    {workspaceName ? ` · ${workspaceName}` : ''}
                                </p>
                            </div>
                            <button onClick={onClose} aria-label="Close" className="shrink-0 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="p-4 space-y-5">
                            {isLoading && (
                                <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center">
                                    <RefreshCw className="w-4 h-4 animate-spin" /> Loading freshness…
                                </div>
                            )}

                            {error && !doc && (
                                <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                                    Could not load this source's freshness.
                                </div>
                            )}

                            {doc && (
                                <>
                                    {/* Status + badges */}
                                    <div className="flex flex-wrap items-center gap-2">
                                        <AggStatusPill status={doc.aggregationStatus} />
                                        <MasteryTag mastered={isPlatformMastered(doc)} />
                                        <FreshnessBadges row={doc} job={byDataSource.get(dsId ?? '')} />
                                    </div>

                                    {/* Resolution guidance — leads for a failed source. */}
                                    {(doc.aggregationStatus === 'failed' || doc.lastFailureCategory != null) && (
                                        <ResolutionGuidance
                                            doc={doc}
                                            canManage={canManage}
                                            busy={refresh.isPending}
                                            onClear={doClear}
                                            onRetry={() => setRetryOpen(true)}
                                        />
                                    )}

                                    {/* Key facts */}
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                                        <Fact label="Lineage updated">
                                            {doc.lastAggregatedAt ? <TimeStamp at={doc.lastAggregatedAt} prefix="updated" /> : '—'}
                                        </Fact>
                                        <Fact label="Cache as of">
                                            {doc.cacheAsOf ? <TimeStamp at={doc.cacheAsOf} prefix="as of" icon={Database} /> : '—'}
                                        </Fact>
                                        <Fact label="Generation">{doc.generation ?? '—'}</Fact>
                                        <Fact label="Next rebuild">{timeUntil(doc.cooldownUntil) ? `in ${timeUntil(doc.cooldownUntil)}` : 'ready now'}</Fact>
                                        <Fact label="Stored fingerprint"><span className="font-mono text-xs">{shortFp(doc.storedFingerprint)}</span></Fact>
                                    </div>

                                    {/* Cache contents (live footprint + last-known-good) */}
                                    <CacheContents doc={doc} />

                                    {/* Automation for this one source, in the
                                        order it runs — the same three stages,
                                        words and ladders as the fleet-wide
                                        Automation modal, narrowed to here. */}
                                    <div className="space-y-6">
                                        <p className="text-[11px] text-ink-muted leading-snug">
                                            Automation runs in three stages. Each one feeds the
                                            next, so a setting here changes what the stages after
                                            it can see.
                                        </p>
                                        <DetectSection doc={doc} />
                                        <CheckSection doc={doc} />
                                        <ActSection doc={doc} />
                                    </div>

                                    {/* Live probe */}
                                    <div className="rounded-xl border border-glass-border bg-glass-base/30 p-3">
                                        <div className="flex items-center justify-between gap-2 mb-2">
                                            <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                                                <Radar className="w-4 h-4 text-indigo-500" /> Live check
                                            </div>
                                            <button
                                                onClick={() => setProbe(true)}
                                                disabled={probing}
                                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 transition-colors disabled:opacity-50"
                                            >
                                                <RefreshCw className={cn('w-3.5 h-3.5', probing && 'animate-spin')} />
                                                {probing ? 'Probing…' : 'Probe now'}
                                            </button>
                                        </div>
                                        {!probe && (
                                            <p className="text-[11px] text-ink-muted">
                                                Compare the last aggregation against the live source. This makes one bounded call to the provider.
                                            </p>
                                        )}
                                        {probe && probing && (
                                            <p className="text-[11px] text-ink-muted flex items-center gap-1.5">
                                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                                Reading live fingerprint…
                                            </p>
                                        )}
                                        {probe && !probing && error && (
                                            <p className="text-[11px] text-red-600 dark:text-red-400">
                                                Probe failed — {error.message || 'could not reach the live source.'}
                                            </p>
                                        )}
                                        {probe && !probing && !error && doc && (
                                            <div className="space-y-2">
                                                {doc.drifted === true && mastered && (
                                                    <div className="space-y-2">
                                                        <div className="flex items-start gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                                                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                                            <span>
                                                                FalkorDB is a rebuildable copy — the live fingerprint differs from the last aggregation, but version control owns the rollups. Check now will not queue a rebuild for this source.
                                                            </span>
                                                        </div>
                                                        {doc.workspaceId && (
                                                            <Link
                                                                to={`/workspaces/${doc.workspaceId}`}
                                                                className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:underline"
                                                            >
                                                                Open version control for this source
                                                                <ArrowUpRight className="w-3 h-3" />
                                                            </Link>
                                                        )}
                                                    </div>
                                                )}
                                                {doc.drifted === true && !mastered && (
                                                    <div className="space-y-2">
                                                        <div className="flex items-start gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                                                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                                            <span>
                                                                The live graph does not match the last aggregation. Counts were refreshed — if Watching is on, overlay integrity will evaluate and rebuild on the next sweep (within a minute). Probe does not queue a rebuild itself.
                                                            </span>
                                                        </div>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            {canManage && (
                                                                <button
                                                                    type="button"
                                                                    onClick={doRebuildLineage}
                                                                    disabled={refresh.isPending}
                                                                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50"
                                                                >
                                                                    <RotateCcw className={cn('w-3.5 h-3.5', refresh.isPending && 'animate-spin')} />
                                                                    Rebuild lineage now
                                                                </button>
                                                            )}
                                                            {isAdmin && (
                                                                <button
                                                                    type="button"
                                                                    onClick={doReconcileThisSource}
                                                                    disabled={reconcileNow.isPending}
                                                                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 transition-colors disabled:opacity-50"
                                                                >
                                                                    <RefreshCw className={cn('w-3.5 h-3.5', reconcileNow.isPending && 'animate-spin')} />
                                                                    Reconcile this source
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                                {doc.drifted === false && (
                                                    <div className="space-y-1.5">
                                                        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                                                            <CheckCircle2 className="w-3.5 h-3.5" /> In sync — the live fingerprint matches the last aggregation.
                                                        </div>
                                                        <p className="text-[11px] text-ink-muted">
                                                            Counts were refreshed for this source.
                                                        </p>
                                                    </div>
                                                )}
                                                <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
                                                    <Fact label="Live fingerprint"><span className="font-mono text-xs">{shortFp(doc.liveFingerprint)}</span></Fact>
                                                    <Fact label="Live nodes">{doc.liveNodeCount ?? '—'}</Fact>
                                                    <Fact label="Live edges">{doc.liveEdgeCount ?? '—'}</Fact>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Recent activity */}
                                    <div>
                                        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink mb-2">
                                            <Activity className="w-4 h-4 text-ink-muted" /> Recent activity
                                        </div>
                                        {activityFeed.length === 0 ? (
                                            <p className="text-[11px] text-ink-muted">No refresh activity recorded yet.</p>
                                        ) : (
                                            <ul className="space-y-1">
                                                {activityFeed.map((e, i) => (
                                                    <ActivityRow key={`${e.ts}-${e.origin}-${i}`} event={e} />
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </motion.div>
                )}
            </>

            {/* Retry-rebuild confirm — gates the OOM "may fail again" case. */}
            <ConfirmDialog
                open={retryOpen}
                title="Retry rebuild"
                message={retryMessage}
                confirmLabel="Retry rebuild"
                confirmColor="bg-indigo-600 hover:bg-indigo-700 shadow-md"
                confirmIcon={RotateCcw}
                loading={refresh.isPending}
                onConfirm={doRetry}
                onCancel={() => setRetryOpen(false)}
            />
        </>,
        document.body,
    )
}
