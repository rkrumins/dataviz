/**
 * How an at-a-glance number moved over the trend window — pure, so the cards
 * and their sheets say the same thing about the same series.
 */

export interface SeriesDelta {
    first: number
    last: number
    change: number
    /** Relative change, or null when it started from nothing. */
    pct: number | null
}

/**
 * From the first known value to the last. `null` entries are days before
 * anything was measured, not zeros; fewer than two known values say nothing.
 */
export function seriesDelta(values: readonly (number | null)[]): SeriesDelta | null {
    const known = values.filter((v): v is number => v !== null)
    if (known.length < 2) return null
    const first = known[0]
    const last = known[known.length - 1]
    return { first, last, change: last - first, pct: first > 0 ? (last - first) / first : null }
}

/**
 * How many of `createdAt` existed at the end of each of `days` ("YYYY-MM-DD",
 * oldest first) — for a total the server does not trend, from the same list
 * the card's number comes from.
 */
export function cumulativeByDay(createdAt: readonly string[], days: readonly string[]): number[] {
    const born = createdAt.map(c => c.slice(0, 10)).sort()
    let i = 0
    return days.map(day => {
        while (i < born.length && born[i] <= day) i++
        return i
    })
}

/** "+3 in 30 days", "−2 in 30 days" — or null when nothing changed. */
export function changePhrase(delta: SeriesDelta | null, days: number): string | null {
    if (!delta || delta.change === 0) return null
    const sign = delta.change > 0 ? '+' : '−'
    return `${sign}${Math.abs(delta.change).toLocaleString()} in ${days} days`
}
