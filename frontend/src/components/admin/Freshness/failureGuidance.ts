/**
 * Shared failure vocabulary for the fleet table and the drawer.
 *
 * Labels are what an operator scans; ``why`` is the one-line tip on the
 * badge. Full how-to-resolve copy stays in the drawer.
 */
import type { FailureCategory, FreshnessRow } from '@/services/freshnessService'

export const FAILURE_CATEGORY_LABEL: Record<FailureCategory, string> = {
    out_of_memory: 'Out of memory',
    query_memory: 'Query too large',
    provider_unavailable: 'Graph store offline',
    ontology: 'No ontology',
    timeout: 'Timed out',
    conflict: 'Rebuild conflict',
    unknown: 'Rebuild failed',
}

export const FAILURE_CATEGORY_WHY: Record<FailureCategory, string> = {
    out_of_memory:
        'The graph store ran out of memory while building aggregated lineage for this large source.',
    query_memory:
        'One rebuild query asked the graph store for more rows than a single query is allowed to hold.',
    provider_unavailable:
        'The graph store was unreachable during the rebuild.',
    ontology:
        "This data source has no ontology assigned, so its lineage can't be aggregated.",
    timeout: 'The rebuild took longer than the allowed time.',
    conflict: 'Another rebuild for this source was already running.',
    unknown: "The rebuild didn't complete. Open this source for details.",
}

const KNOWN = new Set<string>(Object.keys(FAILURE_CATEGORY_LABEL))

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
