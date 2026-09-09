/**
 * Shared failure vocabulary for the fleet table and the drawer.
 *
 * Labels are what an operator scans; ``why`` is the one-line tip on the
 * badge. Full how-to-resolve copy stays in the drawer.
 */
import type { FailureCategory, FreshnessRow } from '@/services/freshnessService'

export const FAILURE_CATEGORY_LABEL: Record<FailureCategory, string> = {
    write_budget: 'Would not fit',
    out_of_memory: 'Out of memory',
    query_memory: 'Query too large',
    provider_unavailable: 'Graph store offline',
    ontology: 'No ontology',
    timeout: 'Timed out',
    conflict: 'Rebuild conflict',
    unknown: 'Rebuild failed',
}

export const FAILURE_CATEGORY_WHY: Record<FailureCategory, string> = {
    write_budget:
        'The rebuild measured the graph-store shard that owns this graph and refused before writing: the rollups would not fit in its free memory.',
    out_of_memory:
        'The graph store ran out of memory while building aggregated lineage for this large source.',
    query_memory:
        'A single row of one rebuild scan is larger than the graph store’s per-query limit, even after the rebuild narrowed its scans as far as they go.',
    provider_unavailable:
        'A graph store node stopped answering during the rebuild — usually a shard restarting or failing over. Everything already written was kept.',
    ontology:
        "This data source has no ontology assigned, so its lineage can't be aggregated.",
    timeout: 'The graph store stopped answering, or the rebuild made no progress for longer than its stall window.',
    conflict: 'Another rebuild for this source was already running.',
    unknown: "The rebuild didn't complete. Open this source for details.",
}

const KNOWN = new Set<string>(Object.keys(FAILURE_CATEGORY_LABEL))

/**
 * The graph store node named in a connection failure, or null.
 *
 * A rebuild that gave up on an unreachable node says so in words ("the graph
 * store node host:port did not answer for …"); a run the circuit breaker cut
 * short carries the reason that started it instead ("… First failure: Error
 * 111 connecting to host:port"). Either way the endpoint is the one fact an
 * operator needs, and it is the fact the breaker's own text loses.
 */
export function graphStoreNodeFromReason(
    reason: string | null | undefined,
): string | null {
    if (!reason) return null
    // A host:port whose host holds a dot — an address, never a clock time.
    const match = /\b((?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+:\d{2,5})\b/.exec(reason)
    return match ? match[1] : null
}

export function asFailureCategory(
    raw: string | null | undefined,
): FailureCategory | null {
    if (!raw || !KNOWN.has(raw)) return null
    return raw as FailureCategory
}

export function failureBadgeLabel(row: FreshnessRow): string {
    const cat = asFailureCategory(row.lastFailureCategory) ?? 'unknown'
    return FAILURE_CATEGORY_LABEL[cat]
}

export function failureBadgeWhy(row: FreshnessRow): string {
    const cat = asFailureCategory(row.lastFailureCategory) ?? 'unknown'
    return FAILURE_CATEGORY_WHY[cat]
}

/** Count failed rows by category over the visible page — feeds Start here
 *  and "N more like this" without a second server round-trip. */
export function countFailuresByCategory(
    rows: FreshnessRow[],
): { category: FailureCategory; count: number }[] {
    const tallies = new Map<FailureCategory, number>()
    for (const row of rows) {
        if (row.aggregationStatus !== 'failed') continue
        const cat = asFailureCategory(row.lastFailureCategory) ?? 'unknown'
        tallies.set(cat, (tallies.get(cat) ?? 0) + 1)
    }
    return [...tallies.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
}

export function relatedFailureCount(
    rows: FreshnessRow[],
    category: FailureCategory | null | undefined,
    exceptId?: string,
): number {
    if (!category) return 0
    return rows.filter(
        r =>
            r.aggregationStatus === 'failed'
            && (asFailureCategory(r.lastFailureCategory) ?? 'unknown') === category
            && r.dataSourceId !== exceptId,
    ).length
}
