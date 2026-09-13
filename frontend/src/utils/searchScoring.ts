/**
 * Weighted, pure scoring for global search.
 *
 * Match tiers (descending strength):
 *   exact          → 100  (entire field equals query)
 *   prefix         →  60  (field starts with query)
 *   word-boundary  →  40  (a word inside the field starts with query)
 *   substring      →  20  (query occurs anywhere)
 *
 * Each match is multiplied by the per-field weight before summing — so a
 * prefix-match on `name` (weight 1.0) outranks an exact-match on a field
 * with weight < 0.6. Zero-score candidates are filtered out by the caller.
 */

export interface FieldSpec<T> {
    /** Read the field from a candidate. May return string, string[], or null. */
    get: (item: T) => string | string[] | undefined | null
    /** Per-field multiplier — 1.0 for primary names, less for ancillary fields. */
    weight: number
}

const EXACT = 100
const PREFIX = 60
const WORD_BOUNDARY = 40
const SUBSTRING = 20

/** True if any word in `value` starts with `query` (after lowercasing). */
function wordStartsWith(value: string, query: string): boolean {
    let i = 0
    const n = value.length
    while (i < n) {
        // Skip non-word characters to find a word boundary.
        while (i < n && !isWordChar(value[i])) i++
        if (i >= n) return false
        if (value.startsWith(query, i)) return true
        // Advance to the end of the current word.
        while (i < n && isWordChar(value[i])) i++
    }
    return false
}

function isWordChar(c: string): boolean {
    return /[A-Za-z0-9]/.test(c)
}

function scoreOne(value: string, query: string): number {
    if (value === query) return EXACT
    if (value.startsWith(query)) return PREFIX
    if (wordStartsWith(value, query)) return WORD_BOUNDARY
    if (value.includes(query)) return SUBSTRING
    return 0
}

/**
 * Score a candidate against a query for a given set of fields.
 *
 * The query is lowercased once by the caller's pipeline (`scoreCandidates`)
 * for performance — pass already-lowercased query when calling directly.
 */
export function scoreCandidate<T>(
    candidate: T,
    query: string,
    fields: FieldSpec<T>[]
): number {
    let total = 0
    for (const f of fields) {
        const raw = f.get(candidate)
        if (raw == null) continue
        if (Array.isArray(raw)) {
            // For tags / array fields, take the best per-element match.
            let best = 0
            for (const v of raw) {
                if (!v) continue
                const s = scoreOne(v.toLowerCase(), query)
                if (s > best) best = s
            }
            total += best * f.weight
        } else {
            total += scoreOne(raw.toLowerCase(), query) * f.weight
        }
    }
    return total
}

/**
 * Score a candidate against a multi-word query as an AND of its tokens: each
 * token must score above zero somewhere in `fields` or the whole match is 0.
 * The literal phrase score is added on top as a bonus, so a candidate that
 * contains the words in query order ranks above one that only matches the
 * tokens individually.
 */
function scoreTokenised<T>(candidate: T, phrase: string, tokens: string[], fields: FieldSpec<T>[]): number {
    let tokenSum = 0
    for (const token of tokens) {
        const s = scoreCandidate(candidate, token, fields)
        if (s === 0) return 0
        tokenSum += s
    }
    return scoreCandidate(candidate, phrase, fields) + tokenSum
}

/**
 * Score and filter a list of candidates against a query, returning the
 * highest-scoring matches sorted descending. Zero-score candidates are dropped.
 *
 * A multi-word query is tokenised on whitespace and matched as an AND of its
 * tokens (see `scoreTokenised`); a single-token query is byte-identical to
 * the original single-needle behaviour.
 *
 * Optionally takes a `tieBreaker` index to keep stable ordering when scores
 * are equal — Map keys preserve insertion order in JS, but tied sorts can
 * still re-shuffle, so callers that care should pass it explicitly.
 */
export function scoreCandidates<T>(
    candidates: readonly T[],
    rawQuery: string,
    fields: FieldSpec<T>[]
): { item: T; score: number }[] {
    const q = rawQuery.trim().toLowerCase()
    if (!q) return []
    const tokens = q.split(/\s+/)
    const out: { item: T; score: number; idx: number }[] = []
    candidates.forEach((item, idx) => {
        const s = tokens.length > 1 ? scoreTokenised(item, q, tokens, fields) : scoreCandidate(item, q, fields)
        if (s > 0) out.push({ item, score: s, idx })
    })
    out.sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    return out.map(({ item, score }) => ({ item, score }))
}
