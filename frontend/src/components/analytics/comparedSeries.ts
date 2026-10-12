/**
 * Pair a measure with the same measure over the previous period, ready for a
 * chart that lays both periods on ONE time axis.
 *
 * Returns `null` when the previous period cannot be PLACED — no dates, or a
 * count of dates that does not match its values. That is not a hypothetical:
 * analytics documents are precomputed into Redis and outlive the code that
 * wrote them, so a deploy that adds a field will keep handing freshly-loaded
 * clients the older shape until every entry expires. A client that spread a
 * missing array took the whole tab down with it.
 *
 * Dropping the comparison degrades the chart to a single period, which is the
 * honest answer when we do not know WHEN the older numbers happened. The one
 * thing we must never do is fall back to placing them by index — that is the
 * bug this entire layout exists to remove, and it fails silently rather than
 * loudly.
 */
export interface ComparedSeries {
    buckets: string[]
    values: number[]
}

export function comparedSeries(
    buckets: string[] | undefined,
    values: number[] | undefined,
): ComparedSeries | null {
    if (!Array.isArray(buckets) || !Array.isArray(values)) return null
    if (buckets.length === 0 || buckets.length !== values.length) return null
    return { buckets, values }
}
