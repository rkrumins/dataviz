/**
 * Number formatting for the Analytics dashboard.
 *
 * Scoped to analytics on purpose. A `compactNum` already exists in four places
 * (AdminInfrastructure/meta.ts, AdminOverview, AdminTelemetry, WorkspaceCard),
 * each rounding slightly differently. Consolidating them means touching six
 * unrelated files, which is a separate change; importing one admin panel's
 * internals into a top-level page is the wrong kind of coupling. This module
 * is the analytics section's own contract.
 */

/** `1,284` → `1.3k`, `4,200,000` → `4.2M`. `null` renders as an em dash. */
export function compact(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '—'
    const abs = Math.abs(value)
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (abs >= 10_000) return `${Math.round(value / 1_000)}k`
    if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
    return String(Math.round(value))
}

/** Full precision with separators — for tooltips and table cells. */
export function exact(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '—'
    return value.toLocaleString()
}

/** A ratio in [0, 1] as a percentage. `null` when there is nothing to divide. */
export function percent(ratio: number | null | undefined, digits = 0): string {
    if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—'
    return `${(ratio * 100).toFixed(digits)}%`
}

/** A signed period-over-period change, e.g. `+18.4%`. */
export function signedPercent(change: number | null | undefined): string | null {
    if (change === null || change === undefined || Number.isNaN(change)) return null
    const sign = change > 0 ? '+' : ''
    return `${sign}${change.toFixed(1)}%`
}

/** `2026-06-15` → `15 Jun`, or `15 Jun 26` when the year is worth saying. */
export function shortDate(iso: string, withYear = false): string {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        ...(withYear ? { year: '2-digit' } : {}),
        timeZone: 'UTC',
    })
}

/**
 * Axis ticks want round numbers, not `1,247.333`.
 *
 * `integer` forces whole-number steps. Everything this dashboard plots is a
 * COUNT — signups, opens, data sources — and an axis reading 0 / 0.5 / 1 / 1.5
 * for "data sources onboarded" invites the reader to wonder what half a data
 * source is.
 */
export function niceTicks(max: number, count = 4, integer = true): number[] {
    if (max <= 0) return [0]
    const raw = max / count
    const mag = 10 ** Math.floor(Math.log10(raw))
    let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10
    if (integer) step = Math.max(1, Math.round(step))
    const ticks: number[] = []
    for (let t = 0; t <= max + step * 0.001; t += step) ticks.push(Math.round(t * 1000) / 1000)
    return ticks
}
