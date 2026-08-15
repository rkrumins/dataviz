/**
 * freshnessTriage — the single source of truth for how a fleet row is
 * classified, filtered, and ordered in the Freshness cockpit.
 *
 * WHY ONE FILE: the stat-band tile counts come from the server
 * (``FreshnessSummary``), but clicking a tile filters the fetched rows on the
 * client. For a tile's number to mean the same thing as the rows its facet
 * produces, the client predicate MUST match the predicate the backend counted
 * with. Those predicates live here — next to the severity ordering that drives
 * the triage-first sort — so the two can never drift apart. Each predicate is
 * annotated with the ``_summarize_freshness`` counter it mirrors.
 */
import type { FailureCategory, FreshnessRow } from '@/services/freshnessService'
import { asFailureCategory } from './failureGuidance'

// ── Status facets (tile ⇄ filter) ────────────────────────────────────

/** The status facet carried in the URL (``?fstatus=``). Empty string = all. */
export type StatusFacet = '' | 'ready' | 'pending' | 'needsAttention' | 'notBuilt' | 'cacheStamped' | 'drifting' | 'suspended'

/** Failure-cause facet (``?ffail=``). Empty = any cause. */
export type FailureFacet = '' | FailureCategory

/** Drift verdicts that mean the rollups no longer match the data. Both count
 *  toward the ``drifting`` tile; the split is only about which detector saw
 *  it. Mirrors ``_DRIFTING_STATES`` in service.py. */
const DRIFTING_STATES = new Set(['drifting', 'overlayMissing'])

/** The last reconciliation check found this source's rollups out of step.
 *  Mirrors the summary's ``drifting`` count. */
export function isDrifting(row: FreshnessRow): boolean {
    return DRIFTING_STATES.has(row.driftState ?? '')
}

/** Automation gave up on this source after repeated rebuilds that never
 *  cleared the problem — it needs a person. */
export function isReconcileSuspended(row: FreshnessRow): boolean {
    return row.driftState === 'suspended'
}

/** A source that has never produced an aggregation: no state row, or an
 *  explicit ``none``/``skipped``. Mirrors the summary's ``notBuilt`` count. */
export function isNeverBuilt(row: FreshnessRow): boolean {
    const s = row.aggregationStatus
    return s == null || s === 'none' || s === 'skipped'
}

/** A stale marker is present (``staleReason`` set). Mirrors ``recomputing``. */
export function hasStaleMarker(row: FreshnessRow): boolean {
    return !!row.staleReason
}

/** A rebuild job is in flight for the source. Mirrors ``pending`` (the summary
 *  counts a live job, not ``aggregationStatus === 'pending'``). */
export function isRebuilding(row: FreshnessRow): boolean {
    return row.runningJobId != null
}

/** Marker present, the last run failed, OR the rollups are out of step with
 *  the data. Mirrors ``needsAttention`` — a per-row OR, so a row that is more
 *  than one of those counts once. (Fleet rows never carry a probe verdict, so
 *  ``drifted`` is intentionally not part of this; ``driftState`` is the
 *  stored verdict from the reconciliation sweep, which is.) */
export function needsAttention(row: FreshnessRow): boolean {
    return hasStaleMarker(row)
        || row.aggregationStatus === 'failed'
        || isDrifting(row)
        || isReconcileSuspended(row)
}

/** A cooldown is holding the next rebuild off (``cooldownUntil`` in the future). */
export function isCooldownActive(row: FreshnessRow): boolean {
    if (!row.cooldownUntil) return false
    const t = Date.parse(row.cooldownUntil)
    return !Number.isNaN(t) && t > Date.now()
}

/**
 * Does ``row`` belong to ``facet``? The one place the tile→filter mapping
 * lives. Every branch matches the identically-named ``FreshnessSummary``
 * count, so a tile's value equals the number of rows its facet reveals
 * (within the fetched page).
 */
export function matchesFacet(row: FreshnessRow, facet: StatusFacet): boolean {
    switch (facet) {
        case 'ready':
            return row.aggregationStatus === 'ready'
        case 'pending':
            return isRebuilding(row)
        case 'needsAttention':
            return needsAttention(row)
        case 'notBuilt':
            return isNeverBuilt(row)
        case 'cacheStamped':
            return row.cacheAsOf != null
        case 'drifting':
            return isDrifting(row)
        case 'suspended':
            return isReconcileSuspended(row)
        case '':
        default:
            return true
    }
}

/** Does ``row`` match the failure-cause facet? Healthy rows never match a
 *  non-empty cause filter. */
export function matchesFailureFacet(
    row: FreshnessRow, facet: FailureFacet,
): boolean {
    if (!facet) return true
    if (row.aggregationStatus !== 'failed') return false
    return (asFailureCategory(row.lastFailureCategory) ?? 'unknown') === facet
}

// ── Freshness state (the honest freshness-column badge) ───────────────

/**
 * The single honest state for a row's freshness badge. Derived from real
 * signals in strict precedence — a failed run wins over a stale MARKER, so a
 * source that failed with the marker still set never reads "Recomputing":
 *
 *   failed (last run failed) → recomputing (a job is genuinely running)
 *   → queued (marker set, no job, not failed) → stale (other marker reasons)
 *   → neverBuilt → upToDate.
 *
 * This is the fix for the marker-only badge that showed "Recomputing" forever
 * on a source whose rebuild had actually failed with no job running.
 */
export type FreshnessState =
    | 'failed'
    | 'recomputing'
    | 'queued'
    | 'stale'
    | 'neverBuilt'
    | 'upToDate'

export function freshnessState(row: FreshnessRow): FreshnessState {
    if (row.aggregationStatus === 'failed') return 'failed'
    if (isRebuilding(row)) return 'recomputing'
    if (row.staleReason === 'source_changed') return 'queued'
    if (row.staleReason) return 'stale'
    if (isNeverBuilt(row)) return 'neverBuilt'
    return 'upToDate'
}

// ── Severity ordering (triage-first sort) ─────────────────────────────

/**
 * Where a row sits in the triage queue — lower is more urgent. The cascade
 * is first-match-wins, so a row that is both failed and stale ranks as failed:
 *
 *   0 failed → 1 drifting → 2 recomputing (stale marker)
 *   → 3 pending (rebuild in flight) → 4 cooldown-active → 5 ready
 *   → 6 not built / other.
 *
 * Drifting outranks recomputing because a recomputing source is already on
 * its way to correct, while a drifting one is serving a picture that no
 * longer matches its data and nothing is yet in flight for it.
 */
export function severityRank(row: FreshnessRow): number {
    if (row.aggregationStatus === 'failed') return 0
    if (isDrifting(row) || isReconcileSuspended(row)) return 1
    if (hasStaleMarker(row)) return 2
    if (isRebuilding(row)) return 3
    if (isCooldownActive(row)) return 4
    if (row.aggregationStatus === 'ready') return 5
    return 6
}

function lastAggregatedMs(row: FreshnessRow): number {
    if (!row.lastAggregatedAt) return -Infinity
    const t = Date.parse(row.lastAggregatedAt)
    return Number.isNaN(t) ? -Infinity : t
}

/** Sort comparator: severity asc, then most-recently-aggregated first, then
 *  name. Missing ``lastAggregatedAt`` sorts last within its severity band. */
export function compareSeverity(a: FreshnessRow, b: FreshnessRow): number {
    const ra = severityRank(a)
    const rb = severityRank(b)
    if (ra !== rb) return ra - rb
    const ta = lastAggregatedMs(a)
    const tb = lastAggregatedMs(b)
    if (ta !== tb) return tb - ta
    return (a.name || a.dataSourceId).localeCompare(b.name || b.dataSourceId)
}

/** A group wants attention when any of its rows is failed, drifting,
 *  recomputing, or rebuilding — the set that forces a provider group to
 *  render expanded, so a single bad source is never hidden inside a
 *  collapsed healthy group. */
export function isGroupAttention(row: FreshnessRow): boolean {
    return row.aggregationStatus === 'failed'
        || hasStaleMarker(row)
        || isRebuilding(row)
        || isDrifting(row)
        || isReconcileSuspended(row)
}
