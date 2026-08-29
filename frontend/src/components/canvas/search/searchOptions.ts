/**
 * The one request shape every view search sends.
 *
 * Shared because the header box and the panel's QueryCard must ask the
 * backend the same question — a badge that says "42 inside" from one
 * surface and "8 inside" from the other is worse than no badge.
 */
import type { SearchQuery } from '@/types/search'


/**
 * Search page size. Also the point at which we stop claiming the canvas
 * spotlight is complete and start telling the user to refine.
 *
 * Was 5000 (the backend's CANDIDATE_CAP) on the theory that the panel wanted
 * every match URN in one round-trip. In practice a broad query ("name")
 * matches thousands of nodes, and shipping all of them — each with a full
 * ancestor spine — into a Set plus two rollup maps on every debounced
 * keystroke is itself what makes the panel feel like it's grinding. A result
 * set that large wants refining, not painting.
 */
const SEARCH_PAGE_SIZE = 1000

/**
 * Ask for hits AND aggregates in one round-trip.
 *
 * `results: 'both'` costs one extra MATCH + GROUP BY over the candidate set
 * the backend has already capped — it is the cheapest response mode it has —
 * and it buys the thing that makes a 600-match result comprehensible: an exact
 * per-container match count. "612 matches in 4 groups" is an answer the user
 * can act on; 612 rows is a pile.
 *
 * Crucially the bucket counts are computed server-side over the FULL candidate
 * set, so they stay exact even when the hit list itself is capped at
 * SEARCH_PAGE_SIZE. Further hits are pulled on demand via the cursor
 * (useAdvancedSearch.loadMore).
 *
 * NOTE on `by: 'parent'`: buckets group by IMMEDIATE parent, so a match that is
 * itself a root has no bucket. The buckets therefore need not sum to
 * candidateCount — don't render them as a partition of the total.
 *
 * `candidateCap` is raised over the deployment default (10 000) so a broad
 * word in a large view still counts every match rather than reporting a
 * capped scan; `softDeadlineMs` sits below the client's 30 s fetch timeout so
 * a slow query comes back as partial rows the user can read, not as an abort.
 */
export const SEARCH_OPTIONS: SearchQuery['options'] = {
    results: 'both',
    pageSize: SEARCH_PAGE_SIZE,
    // 3 sample hits per bucket: AggregateBucketCard previews them as chips, which
    // is what makes a group card worth reading ("what's actually in here?").
    aggregations: [{ by: 'parent', maxBuckets: 200, sampleHitsPerBucket: 3 }],
    includeAncestorPath: true,
    candidateCap: 50000,
    softDeadlineMs: 20000,
}
