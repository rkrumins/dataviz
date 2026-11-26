import type { AnalyticsRangeSelection } from '@/services/analyticsService'

/** Search params for a range, in the names the Analytics page reads. */
export function rangeParams(range: AnalyticsRangeSelection): Record<string, string> {
    return range.kind === 'custom' ? { from: range.from, to: range.to } : { range: String(range.days) }
}

/** A person's activity page, carrying the range and the workspace scope with it, so
 *  following a name keeps the slice the reader was looking at. */
export function personActivityHref(
    userId: string, opts: { workspaceId?: string | null; range?: AnalyticsRangeSelection; day?: string } = {},
): string {
    const params = new URLSearchParams(opts.range ? rangeParams(opts.range) : {})
    if (opts.workspaceId) params.set('workspace', opts.workspaceId)
    if (opts.day) params.set('day', opts.day)
    const qs = params.toString()
    return `/analytics/people/${encodeURIComponent(userId)}${qs ? `?${qs}` : ''}`
}

function addDays(iso: string, n: number): string {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
}

/** The custom range a dragged span of buckets covers. A weekly bucket is a week
 *  long, so the span ends six days after its last bucket — but never past the
 *  window it was drawn from. */
export function spanToRange(
    buckets: string[], granularity: 'day' | 'week', first: number, last: number, windowEnd: string,
): AnalyticsRangeSelection {
    const from = buckets[first]
    let to = granularity === 'week' ? addDays(buckets[last], 6) : buckets[last]
    const end = windowEnd.slice(0, 10)
    if (to > end) to = end
    return { kind: 'custom', from, to }
}

export { addDays }
