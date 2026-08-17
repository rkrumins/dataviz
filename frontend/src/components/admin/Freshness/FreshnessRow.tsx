/**
 * FreshnessRow — one data source's row in the fleet table, plus the small
 * status/badge primitives the drawer reuses.
 *
 * Each row promotes one state-driven primary action (``primaryAction``)
 * next to a `⋯` overflow (``overflowActions``); the overflow never repeats
 * the primary and never offers another rebuild to a row that is already
 * rebuilding. The overflow trigger and the button-rendered primary are
 * disabled only while this row's own refresh mutation is in flight
 * (``busy``) — a rebuild running elsewhere for the source does not block
 * the row. The link-rendered primary (the ``recomputing`` + ``!canExpand``
 * degradation) is a plain anchor, so it has no disabled state and ignores
 * ``busy``.
 *
 * Copy is plain-language and white-label: the row actions read "Refresh
 * caches" / "Rebuild lineage" / "Full refresh", never the internal scope
 * names.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Link } from 'react-router-dom'
import {
    Activity, AlertTriangle, ArrowUpRight, CheckCircle2, Clock, Database, Eraser, GitBranch, Loader2,
    Minus, MoreHorizontal, PauseCircle, RefreshCw, RotateCcw, Sparkles, StopCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { usePermission } from '@/store/auth'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { ProgressBar } from '@/components/ui/ProgressBar'
import type { FreshnessRow as FreshnessRowData, RefreshScope } from '@/services/freshnessService'
import type { AggregationJobResponse } from '@/services/aggregationService'
import { PHASE_LABELS, PhaseStepper, jobHistoryPath, phaseLabel } from '../job-history/shared'
import { freshnessState, isDrifting, isPlatformMastered, isReconcileSuspended } from './freshnessTriage'
import type { FreshnessState, StatusFacet } from './freshnessTriage'
import {
    AutoReconcileOffBadge, DRIFT_SPEC, DriftStateBadge,
} from './DriftStateBadge'
import { failureBadgeLabel, failureBadgeWhy, relatedFailureCount } from './failureGuidance'
import { SelectionCheckbox } from './SelectionCheckbox'
import { resolveLastActivity, type LastActivityKind } from './lastActivity'

/** A quiet placeholder for an empty cell — muted enough that a never-built
 *  row's blank cells don't read as three shouting dashes. */
function EmptyCell() {
    return <span className="text-[11px] text-ink-muted/40">—</span>
}

// ── Shared derivations ───────────────────────────────────────────────

/** The marker's "since" is not durably recorded, so fall back to the last
 *  accepted refresh event's timestamp — the moment the change was accepted. */
export function deriveStaleSince(row: FreshnessRowData): string | null {
    if (row.staleSince) return row.staleSince
    if (row.lastEvent?.outcome === 'accepted') return row.lastEvent.ts
    return null
}

/** Minutes/hours/days until a future instant, or null if it's already past. */
export function timeUntil(iso?: string | null): string | null {
    if (!iso) return null
    const ms = new Date(iso).getTime() - Date.now()
    if (Number.isNaN(ms) || ms <= 0) return null
    const mins = Math.round(ms / 60000)
    if (mins < 60) return `${mins}m`
    const hours = Math.round(mins / 60)
    if (hours < 24) return `${hours}h`
    return `${Math.round(hours / 24)}d`
}

/** The three reconciliation fields `automationChip` reads off a fleet row —
 *  a `Pick`, not the full row type, so the decision logic is testable with a
 *  bare literal (see FreshnessRow.test.tsx) rather than a fabricated row. */
type AutomationRow = Pick<FreshnessRowData, 'driftState' | 'autoReconcile' | 'pausedUntil'>

/**
 * The automation-state chip for a fleet row. Absence is the signal: a
 * healthy, automated source (in sync, not paused) returns null rather than
 * repeating "everything is fine" on every row — a chip appears only for a
 * state worth interrupting the scan for.
 *
 * Precedence: the breaker (suspended) always wins, even over an active
 * snooze — a person is needed regardless of whether the source is also
 * paused. A snooze only surfaces while it is actually holding back a real
 * drift verdict; pausing a source that never drifts looks identical to
 * automation working normally, so it stays as quiet as any healthy row. An
 * opted-out source is reported unconditionally — that is a standing
 * configuration fact, not a transient condition, so it does not hide just
 * because the source happens to be in sync right now.
 */
export function automationChip(row: AutomationRow): { label: string; tone: string; facet: StatusFacet } | null {
    const neutralTone = 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20'

    if (row.driftState === 'suspended') {
        return { label: 'Needs a person', tone: DRIFT_SPEC.suspended.tone, facet: 'suspended' }
    }
    const drifting = row.driftState === 'drifting' || row.driftState === 'overlayMissing'
    if (drifting && timeUntil(row.pausedUntil)) {
        return { label: 'Paused', tone: neutralTone, facet: 'drifting' }
    }
    if (row.autoReconcile === false) {
        // No StatusFacet filters to "automation off" sources specifically,
        // so this resolves to '' (the existing "all" facet) — the render
        // site treats an empty facet as non-interactive rather than wiring
        // up a click that would silently just clear the status filter.
        return { label: 'Automation off', tone: neutralTone, facet: '' }
    }
    return null
}

function humanizeReason(reason: string): string {
    switch (reason) {
        case 'unmaterialized': return 'Not materialized'
        case 'legacy_cells': return 'Legacy layout'
        case 'degraded': return 'Degraded'
        default: return reason.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
    }
}

// ── Small primitives (reused by the drawer) ──────────────────────────

const STATUS_STYLE: Record<string, { label: string; tone: string; Icon: typeof CheckCircle2; spin?: boolean }> = {
    ready: { label: 'Ready', tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20', Icon: CheckCircle2 },
    running: { label: 'Running', tone: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20', Icon: Loader2, spin: true },
    pending: { label: 'Pending', tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20', Icon: Clock },
    failed: { label: 'Failed', tone: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20', Icon: AlertTriangle },
    skipped: { label: 'Skipped', tone: 'bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20', Icon: Minus },
}

export function MasteryTag({ mastered }: { mastered: boolean }) {
    return mastered
        ? (
            <span
                title="This graph is mastered here and stored in Postgres. Version control maintains its rollups on every publish."
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold shrink-0 bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20"
            >
                <GitBranch className="w-3 h-3 shrink-0" />
                Versioned
            </span>
        )
        : (
            <span
                title="This graph is mastered by an external system. Reconciliation watches its overlay for drift."
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold shrink-0 bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20"
            >
                <Database className="w-3 h-3 shrink-0" />
                External
            </span>
        )
}

export function CacheStatusPill({ cached }: { cached: boolean }) {
    return cached
        ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                <Database className="w-3 h-3" />
                Cached
            </span>
        )
        : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20">
                <Minus className="w-3 h-3" />
                Not cached
            </span>
        )
}

// `in_step` (a routine "checked, nothing to do" outcome) is deliberately
// absent — it renders as quiet muted text instead of a pill (see the Last
// activity cell below), so it never competes for attention with Failed or
// Queued the way an identically-styled pill did.
const ACTIVITY_PILL: Record<Exclude<LastActivityKind, 'in_step'>, { tone: string; Icon: typeof CheckCircle2 }> = {
    verdict: {
        tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        Icon: AlertTriangle,
    },
    rebuild: {
        tone: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
        Icon: Activity,
    },
    refresh: {
        tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        Icon: CheckCircle2,
    },
    queued: {
        tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        Icon: Clock,
    },
    failed: {
        tone: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
        Icon: AlertTriangle,
    },
}

export function LastActivityPill({ kind, label, originLabel }: {
    kind: Exclude<LastActivityKind, 'in_step'>
    label: string
    originLabel?: string | null
}) {
    const { tone, Icon } = ACTIVITY_PILL[kind]
    return (
        <span
            title={originLabel ? `${label} · ${originLabel}` : label}
            className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold',
                tone,
            )}
        >
            <Icon className="w-3 h-3 shrink-0" />
            <span className="uppercase tracking-wide">{label}</span>
            {originLabel && !label.toLowerCase().includes(originLabel.toLowerCase()) && (
                <span className="font-medium normal-case tracking-normal opacity-70">
                    · {originLabel}
                </span>
            )}
        </span>
    )
}

export function AggStatusPill({ status }: { status?: string | null }) {
    const s = (status && STATUS_STYLE[status]) || {
        label: 'Not built', tone: 'bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20', Icon: Minus,
    }
    const { label, tone, Icon } = s
    return (
        <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide', tone)}>
            <Icon className={cn('w-3 h-3', s.spin && 'animate-spin')} />
            {label}
        </span>
    )
}

function Badge({ tone, Icon, spin, label, title }: {
    tone: string; Icon: typeof Clock; spin?: boolean; label: string; title?: string
}) {
    return (
        <span title={title} className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold', tone)}>
            <Icon className={cn('w-3 h-3', spin && 'animate-spin')} />
            {label}
        </span>
    )
}

/** The Freshness column: an honest primary state ("Rebuild failed",
 *  "Recomputing", "Queued", or a structural "stale" reason) derived from real
 *  signals, plus additive "Drift detected" / "Next rebuild in Xm" badges. The
 *  primary state comes from ``freshnessState`` so a source that FAILED with the
 *  stale marker still set never masquerades as "Recomputing". */
export function FreshnessBadges({ row, job, showProgressBar = true }: {
    row: FreshnessRowData
    job?: AggregationJobResponse
    showProgressBar?: boolean
}) {
    const badges: React.ReactNode[] = []
    const state = freshnessState(row)
    // Only a RECOGNIZED phase earns a phase name and a bar. An unknown
    // phase id, a missing job, or a failed jobs query all fall back to the
    // bare badge — never a percentage we cannot substantiate.
    const phase = job?.currentPhase ? PHASE_LABELS[job.currentPhase] : undefined
    const pct = phase && typeof job?.progress === 'number'
        ? Math.min(100, Math.max(0, Math.round(job.progress)))
        : null

    if (state === 'failed') {
        badges.push(
            <Badge key="failed"
                tone="bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20"
                Icon={AlertTriangle}
                label={failureBadgeLabel(row)}
                title={failureBadgeWhy(row)}
            />,
        )
    } else if (state === 'recomputing') {
        badges.push(
            <Link key="recomputing" to={jobHistoryPath({ dataSourceId: row.dataSourceId })}
                className="outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded-full">
                <Badge
                    tone="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20"
                    Icon={Loader2} spin
                    label={pct != null ? `Recomputing · ${phase} · ${pct}%` : 'Recomputing'}
                    title="A lineage rebuild is running now. Open Job History for the full detail."
                />
            </Link>,
        )
    } else if (state === 'queued') {
        const since = deriveStaleSince(row)
        badges.push(
            <Badge key="queued"
                tone="bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20"
                Icon={Clock} label="Queued"
                title={`Source data changed${since ? ` · detected ${timeAgo(since)}` : ''} — a lineage rebuild is queued.`}
            />,
        )
    } else if (state === 'stale') {
        badges.push(
            <Badge key="stale"
                tone="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                Icon={AlertTriangle} label={humanizeReason(row.staleReason as string)}
                title="This source's lineage is out of date and needs a rebuild."
            />,
        )
    } else if (state === 'neverBuilt') {
        badges.push(
            <Badge key="neverBuilt"
                tone="bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20"
                Icon={Minus} label="Never built"
                title="Lineage has never been built for this source."
            />,
        )
    } else if (state === 'upToDate' && !isDrifting(row) && !isReconcileSuspended(row)) {
        badges.push(
            <Badge key="upToDate"
                tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                Icon={CheckCircle2} label="Up to date"
                title="Lineage is built and the last reconcile check found the rollups in sync."
            />,
        )
    }

    // Current overlay verdict — additive on failed/queued rows, and the
    // primary freshness label when a ready source is drifting.
    if (isDrifting(row) || isReconcileSuspended(row)) {
        badges.push(<DriftStateBadge key="driftState" state={row.driftState} />)
    }

    // Drift detected by automation, but automation is switched off here — so
    // say why nothing is happening about it.
    if (row.autoReconcile === false && isDrifting(row)) {
        badges.push(<AutoReconcileOffBadge key="autoOff" />)
    }

    if (row.drifted === true) {
        badges.push(
            <Badge key="drift"
                tone="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                Icon={AlertTriangle} label="Drift detected"
                title="A probe found the live source differs from the last aggregation."
            />,
        )
    }

    const until = timeUntil(row.cooldownUntil)
    if (until) {
        badges.push(
            <Badge key="cooldown"
                tone="bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20"
                Icon={Clock} label={`Next rebuild in ${until}`}
                title="A rebuild recently ran; the next one is held off until this cooldown passes."
            />,
        )
    }

    if (pct != null && state === 'recomputing' && showProgressBar) {
        badges.push(
            <ProgressBar key="bar" value={pct} className="w-full h-1 mt-1"
                label={`Rebuild progress for ${row.name || row.dataSourceId}`} />,
        )
    }

    if (badges.length === 0) {
        return <span className="text-[11px] text-ink-muted">Up to date</span>
    }
    return <div className="flex flex-wrap items-center gap-1">{badges}</div>
}

// ── Row ──────────────────────────────────────────────────────────────

interface Props {
    row: FreshnessRowData
    job?: AggregationJobResponse
    colSpan: number
    workspaceName?: string
    onOpenDrawer: (dsId: string) => void
    onRefresh: (dsId: string, scope: RefreshScope, opts?: { firstBuild?: boolean }) => void
    busy?: boolean
    expanded?: boolean
    onToggleExpand?: (dsId: string) => void
    onCancelJob?: (dsId: string, jobId: string) => void
    /** All visible rows — used for "N more like this" related-failure links. */
    peerRows?: FreshnessRowData[]
    onFilterFailure?: (category: string) => void
    /** Lets the automation chip act as a filter, same as the stat band's
     *  tiles — mirrors `onFilterFailure`'s pattern for the other facet axis. */
    onFilterStatus?: (facet: StatusFacet) => void
    selected?: boolean
    onToggleSelect?: (dsId: string) => void
    selectable?: boolean
}

type RowAction = { scope: RefreshScope; label: string; Icon: typeof RefreshCw; iconClass: string; firstBuild?: boolean; hint?: string }

const BUILT_ACTIONS: RowAction[] = [
    { scope: 'read-caches', label: 'Refresh caches', Icon: RefreshCw, iconClass: 'text-sky-500', hint: 'Re-reads cached figures. Keeps any queued rebuild.' },
    { scope: 'clear', label: 'Clear cache', Icon: Eraser, iconClass: 'text-rose-400', hint: 'Resets cached data — also clears a stuck "recomputing" state. No rebuild, safe to run.' },
    { scope: 'rollups', label: 'Rebuild lineage', Icon: RotateCcw, iconClass: 'text-indigo-500' },
    { scope: 'full', label: 'Full refresh', Icon: Sparkles, iconClass: 'text-emerald-500' },
]

/**
 * The one action a row's state calls for, promoted out of the overflow so
 * an operator never hunts for it. ``recomputing`` deliberately maps to
 * "View progress" (opens the in-place panel) rather than "Cancel": Cancel
 * is destructive and must not be the easiest target on a table where 20+
 * rows can be rebuilding at once. It stays in the overflow.
 */
export function primaryAction(state: FreshnessState): {
    label: string
    kind: 'refresh' | 'expand'
    scope?: RefreshScope
    firstBuild?: boolean
} {
    switch (state) {
        // No `force` here: the `rollups` scope already bypasses the
        // cooldown/dedup gate by construction (a fresh idempotency key on
        // every call) — `force` only has meaning for the change-gated
        // `auto` scope, which this action never sends.
        case 'failed': return { label: 'Retry rebuild', kind: 'refresh', scope: 'rollups' }
        case 'recomputing': return { label: 'View progress', kind: 'expand' }
        case 'queued':
        case 'stale': return { label: 'Rebuild now', kind: 'refresh', scope: 'rollups' }
        case 'neverBuilt': return { label: 'Build lineage', kind: 'refresh', scope: 'rollups', firstBuild: true }
        case 'upToDate':
        default: return { label: 'Refresh caches', kind: 'refresh', scope: 'read-caches' }
    }
}

/** Overflow scopes per state — the primary action's own scope is never
 *  repeated here, and a rebuilding row is not offered another rebuild
 *  (the backend would collapse it onto the running job anyway, so the
 *  menu item would be a lie). */
export function overflowActions(state: FreshnessState): RowAction[] {
    const byScope = (s: RefreshScope) => BUILT_ACTIONS.find(a => a.scope === s)!
    switch (state) {
        case 'neverBuilt':
            return []
        case 'recomputing':
            // `clear` is safe mid-rebuild — it never touches the graph or the
            // job, and the badge still reads "Recomputing" (isRebuilding beats
            // staleReason in freshnessState). But it also removes the stale-
            // marker entry `_reconcile_stale_markers` retries against, and
            // nothing re-marks on failure, so a rebuild that fails after being
            // cleared here loses automatic retry, not visibility.
            return [byScope('read-caches'), byScope('clear')]
        case 'upToDate':
            return [byScope('clear'), byScope('rollups'), byScope('full')]
        case 'failed':
        case 'queued':
        case 'stale':
        default:
            return [byScope('read-caches'), byScope('clear'), byScope('full')]
    }
}

export function FreshnessRow({
    row, job, colSpan, workspaceName, onOpenDrawer, onRefresh, busy, expanded,
    onToggleExpand, onCancelJob, peerRows, onFilterFailure, onFilterStatus, selected,
    onToggleSelect, selectable,
}: Props) {
    const state = freshnessState(row)
    const actions = overflowActions(state)
    // Refresh IS the ds:manage mutation. Hide the menu entirely for viewers
    // who can't manage this row's workspace (RegistryConnections convention) —
    // a disabled item would just 403 on click.
    const canManage = usePermission('workspace:datasource:manage', row.workspaceId)

    // Only a row with a joined running job has anything to expand. No job,
    // no panel — an empty expander would be a dead affordance.
    const canExpand = !!job && !!job.currentPhase && PHASE_LABELS[job.currentPhase] != null
    const pct = job && typeof job.progress === 'number'
        ? Math.min(100, Math.max(0, Math.round(job.progress)))
        : 0

    const severe = state === 'failed' || isReconcileSuspended(row)
    const related = state === 'failed' && peerRows && onFilterFailure
        ? relatedFailureCount(peerRows, row.lastFailureCategory, row.dataSourceId)
        : 0

    return (
        <>
        <tr className={cn(
            'group/row border-t border-glass-border transition-colors duration-150',
            'hover:bg-black/[0.015] dark:hover:bg-white/[0.015]',
            selected
                ? 'bg-indigo-500/[0.07] shadow-[inset_3px_0_0_0] shadow-indigo-500'
                : severe && 'bg-red-500/[0.03] shadow-[inset_3px_0_0_0] shadow-red-500/60',
        )}>
            {/* Selection */}
            <td className="pl-3 pr-1 py-2.5 align-middle w-10">
                {selectable && canManage && state !== 'recomputing' && onToggleSelect ? (
                    <SelectionCheckbox
                        selected={!!selected}
                        onToggle={() => onToggleSelect(row.dataSourceId)}
                        ariaLabel={selected
                            ? `Deselect ${row.name || row.dataSourceId}`
                            : `Select ${row.name || row.dataSourceId}`}
                    />
                ) : (
                    <span className="inline-block w-5" aria-hidden />
                )}
            </td>

            {/* Source */}
            <td className="px-3 py-2.5 align-top">
                <button
                    onClick={() => onOpenDrawer(row.dataSourceId)}
                    className="text-left group outline-none min-w-0"
                >
                    <span className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-semibold text-ink truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 group-focus-visible:underline">
                            {row.name || row.dataSourceId}
                        </span>
                        <MasteryTag mastered={isPlatformMastered(row)} />
                    </span>
                    <span className="block text-[11px] text-ink-muted">
                        {row.providerName || 'Unknown provider'}
                        {workspaceName ? ` · ${workspaceName}` : ''}
                    </span>
                </button>
            </td>

            {/* Aggregation */}
            <td className="px-3 py-2 align-top">
                <div className="flex flex-col gap-1">
                    <AggStatusPill status={row.aggregationStatus} />
                    {row.lastAggregatedAt
                        ? <TimeStamp at={row.lastAggregatedAt} prefix="updated" icon={RefreshCw} />
                        : <EmptyCell />}
                </div>
            </td>

            {/* Cache */}
            <td className="px-3 py-2 align-top">
                <div className="flex flex-col gap-1">
                    <CacheStatusPill cached={row.cacheAsOf != null} />
                    {row.cacheAsOf
                        ? <TimeStamp at={row.cacheAsOf} prefix="updated" icon={Database} />
                        : <EmptyCell />}
                </div>
            </td>

            {/* Freshness */}
            <td className="px-3 py-2 align-top">
                <div className="flex flex-col gap-1 items-start">
                    <FreshnessBadges row={row} job={job} showProgressBar={!expanded} />
                    {related > 0 && onFilterFailure && row.lastFailureCategory && (
                        <button
                            type="button"
                            onClick={() => onFilterFailure(row.lastFailureCategory!)}
                            className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                            {related} more like this
                        </button>
                    )}
                </div>
            </td>

            {/* Last activity */}
            <td className="px-3 py-2 align-top">
                <div className="flex flex-col gap-1 items-start">
                    {(() => {
                        const activity = resolveLastActivity(row)
                        if (!activity) return <EmptyCell />
                        // The routine "checked, nothing to do" outcome loses the
                        // pill entirely — border/fill/uppercase are exactly what
                        // made it compete with Failed/Queued for attention.
                        if (activity.kind === 'in_step') {
                            return (
                                <TimeStamp
                                    at={activity.at}
                                    prefix="checked"
                                    icon={CheckCircle2}
                                    colorByAge={false}
                                />
                            )
                        }
                        return (
                            <>
                                <LastActivityPill
                                    kind={activity.kind}
                                    label={activity.label}
                                    originLabel={activity.originLabel}
                                />
                                <TimeStamp
                                    at={activity.at}
                                    prefix={activity.source === 'check' ? 'checked' : 'updated'}
                                    icon={Activity}
                                />
                            </>
                        )
                    })()}
                    {(() => {
                        const chip = automationChip(row)
                        if (!chip) return null
                        const Icon = chip.facet === 'suspended' ? AlertTriangle
                            : chip.facet === 'drifting' ? PauseCircle
                            : Minus
                        const title = chip.facet === 'suspended' ? DRIFT_SPEC.suspended.title
                            : chip.facet === 'drifting' ? 'An operator paused automatic reconciliation for this source.'
                            : 'Automatic reconciliation is turned off for this source. Drift is still detected and shown, but nothing is rebuilt automatically.'
                        const chipClass = cn(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold',
                            chip.tone,
                        )
                        const content = <><Icon className="w-3 h-3 shrink-0" />{chip.label}</>
                        // Only 'suspended'/'drifting' have a real facet to filter
                        // to — 'Automation off' resolves to '' (see automationChip)
                        // and stays a plain label rather than a click that would
                        // just clear the status filter.
                        return chip.facet && onFilterStatus ? (
                            <button
                                type="button"
                                title={title}
                                onClick={() => onFilterStatus(chip.facet)}
                                className={cn(chipClass, 'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50')}
                            >
                                {content}
                            </button>
                        ) : (
                            <span title={title} className={chipClass}>{content}</span>
                        )
                    })()}
                </div>
            </td>

            {/* Actions */}
            <td className="px-3 py-2 align-top text-right" onClick={(e) => e.stopPropagation()}>
                {canManage && (
                <div className="flex items-center justify-end gap-1">
                    {(() => {
                        const p = primaryAction(state)
                        const primaryClass = 'px-2.5 py-1 rounded-lg text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

                        // Expand only when there is a panel to open; otherwise send them to the
                        // full job view rather than toggling an empty row.
                        if (p.kind === 'expand' && !canExpand) {
                            return <Link to={jobHistoryPath({ dataSourceId: row.dataSourceId })} className={primaryClass}>{p.label}</Link>
                        }

                        return (
                            <button
                                onClick={() => p.kind === 'expand'
                                    ? onToggleExpand?.(row.dataSourceId)
                                    : onRefresh(row.dataSourceId, p.scope as RefreshScope,
                                        p.firstBuild ? { firstBuild: true } : undefined)}
                                disabled={busy}
                                aria-expanded={p.kind === 'expand' ? !!expanded : undefined}
                                aria-controls={p.kind === 'expand' ? `freshness-panel-${row.dataSourceId}` : undefined}
                                className={primaryClass}
                            >
                                {p.label}
                            </button>
                        )
                    })()}
                    <DropdownMenu.Root modal={false}>
                        <DropdownMenu.Trigger asChild>
                            <button
                                aria-label={`More actions for ${row.name || row.dataSourceId}`}
                                disabled={busy}
                                className="p-1.5 rounded-lg text-ink-muted/60 hover:text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 disabled:opacity-40 disabled:cursor-not-allowed data-[state=open]:bg-black/[0.04] dark:data-[state=open]:bg-white/[0.04]"
                            >
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MoreHorizontal className="w-4 h-4" />}
                            </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content
                                align="end"
                                sideOffset={4}
                                className="z-[9999] w-44 p-1 bg-canvas border border-glass-border rounded-xl shadow-xl animate-in fade-in slide-in-from-top-1 duration-100"
                            >
                                {actions.map(({ scope, label, Icon, iconClass, firstBuild, hint }) => (
                                    <DropdownMenu.Item
                                        key={label}
                                        title={hint}
                                        onSelect={() => onRefresh(row.dataSourceId, scope, firstBuild ? { firstBuild: true } : undefined)}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink rounded-lg cursor-pointer outline-none transition-colors data-[highlighted]:bg-black/[0.04] dark:data-[highlighted]:bg-white/[0.04]"
                                    >
                                        <Icon className={cn('w-3.5 h-3.5', iconClass)} />
                                        {label}
                                    </DropdownMenu.Item>
                                ))}
                                {job?.id && state === 'recomputing' && (
                                    <DropdownMenu.Item
                                        onSelect={() => onCancelJob?.(row.dataSourceId, job.id)}
                                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 rounded-lg cursor-pointer outline-none transition-colors data-[highlighted]:bg-black/[0.04] dark:data-[highlighted]:bg-white/[0.04]"
                                    >
                                        <StopCircle className="w-3.5 h-3.5" />
                                        Cancel job
                                    </DropdownMenu.Item>
                                )}
                                <DropdownMenu.Item asChild
                                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink rounded-lg cursor-pointer outline-none transition-colors data-[highlighted]:bg-black/[0.04] dark:data-[highlighted]:bg-white/[0.04]"
                                >
                                    <Link to={jobHistoryPath({ dataSourceId: row.dataSourceId })}>
                                        <ArrowUpRight className="w-3.5 h-3.5 text-ink-muted" />
                                        Open in Job History
                                    </Link>
                                </DropdownMenu.Item>
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                </div>
                )}
            </td>
        </tr>
        {expanded && canExpand && job && (
            <tr id={`freshness-panel-${row.dataSourceId}`}>
                <td colSpan={colSpan} className="p-0">
                    <div className="mx-3 my-2 rounded-xl border border-indigo-500/20 bg-canvas-elevated p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold text-ink">
                                {phaseLabel(job.currentPhase)}
                            </span>
                            <span className="text-[12px] font-bold text-indigo-400 tabular-nums">{pct}%</span>
                        </div>
                        <ProgressBar value={pct} className="h-2"
                            label={`Rebuild progress for ${row.name || row.dataSourceId}`} />
                        <PhaseStepper
                            currentPhase={job.currentPhase}
                            runStats={job.runStats}
                            status={job.status}
                        />
                        <div className="flex justify-end">
                            <Link
                                to={jobHistoryPath({ dataSourceId: row.dataSourceId })}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                            >
                                Open in Job History
                                <ArrowUpRight className="w-3 h-3" />
                            </Link>
                        </div>
                    </div>
                </td>
            </tr>
        )}
        </>
    )
}
