/**
 * rankHits — put the best match first, whoever found it.
 *
 * The server has no relevance signal. `sort: 'relevance'` is accepted and
 * then falls back to display name (`falkordb_deep_search.py`: "No relevance
 * signal in v1 (no fulltext). Fall back to displayName."), and the page is
 * the first N of that alphabetical list. So a search for "revenue" on a view
 * where 300 things match returns `a_revenue` … `m_revenue`, and
 * `revenue_gross` may never appear.
 *
 * The local tier meanwhile ranks properly through `scoreCandidates`. Merged
 * into one list, that left two halves obeying two different rules.
 *
 * This applies one rule to the whole set, using the same weights and the same
 * scorer the local tier uses, so both tiers agree about what "best" means.
 *
 * **Zero-scorers are kept, not dropped.** `scoreCandidates` filters them out,
 * which would be wrong here: the server can legitimately return a hit that
 * matched on something these fields don't carry — a property value lives in
 * the denormalised `searchableText`, not on the wire node. Dropping it would
 * turn a ranking change into a correctness regression. They sort last, in the
 * order they arrived.
 */
import type { SearchHit } from '@/types/search'
import { scoreCandidate, type FieldSpec } from '@/utils/searchScoring'


/** Mirrors `localNodeIndex.RANK_FIELDS` — the two tiers must not disagree
 *  about which field matters more. */
const HIT_FIELDS: FieldSpec<SearchHit>[] = [
    { get: (h) => h.node?.displayName ?? null, weight: 1.0 },
    { get: (h) => h.node?.qualifiedName ?? null, weight: 0.5 },
    { get: (h) => h.node?.tags ?? null, weight: 0.45 },
    { get: (h) => h.node?.entityType ?? null, weight: 0.3 },
    { get: (h) => h.node?.description ?? null, weight: 0.15 },
]


/**
 * Sort by relevance to `rawQuery`, descending, stable within equal scores.
 *
 * Returns the input array unchanged when there is nothing to rank on, so the
 * caller's memo keeps its identity.
 */
export function rankHits(
    hits: readonly SearchHit[],
    rawQuery: string,
): readonly SearchHit[] {
    const q = rawQuery.trim().toLowerCase()
    if (!q || hits.length < 2) return hits

    const scored = hits.map((hit, idx) => ({
        hit,
        idx,
        score: scoreCandidate(hit, q, HIT_FIELDS),
    }))
    // Original index as the tiebreak keeps the sort stable — local hits stay
    // ahead of server hits that scored identically, so the rows a user is
    // already reading don't reshuffle when the server answers.
    scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    return scored.map((s) => s.hit)
}
