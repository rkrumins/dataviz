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
import type { FreshnessRow } from '@/services/freshnessService'

// ── Status facets (tile ⇄ filter) ────────────────────────────────────

/** The status facet carried in the URL (``?fstatus=``). Empty string = all. */
export type StatusFacet = '' | 'ready' | 'pending' | 'needsAttention' | 'notBuilt' | 'cacheStamped'

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

/** Marker present OR the last run failed. Mirrors ``needsAttention`` — a
 *  per-row OR, so a row that is both counts once. (Fleet rows never carry a
 *  probe verdict, so ``drifted`` is intentionally not part of this.) */
export function needsAttention(row: FreshnessRow): boolean {
    return hasStaleMarker(row) || row.aggregationStatus === 'failed'
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
        case '':
        default:
            return true
    }
}

// ── Severity ordering (triage-first sort) ─────────────────────────────

/**
 * Where a row sits in the triage queue — lower is more urgent. The cascade
 * is first-match-wins, so a row that is both failed and stale ranks as failed:
 *
 *   0 failed → 1 recomputing (stale marker) → 2 pending (rebuild in flight)
 *   → 3 cooldown-active → 4 ready → 5 not built / other.
 */
export function severityRank(row: FreshnessRow): number {
    if (row.aggregationStatus === 'failed') return 0
    if (hasStaleMarker(row)) return 1
    if (isRebuilding(row)) return 2
    if (isCooldownActive(row)) return 3
    if (row.aggregationStatus === 'ready') return 4
    return 5
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

/** A group wants attention when any of its rows is failed, recomputing, or
 *  rebuilding — the set that forces a provider group to render expanded. */
export function isGroupAttention(row: FreshnessRow): boolean {
    return row.aggregationStatus === 'failed' || hasStaleMarker(row) || isRebuilding(row)
}
