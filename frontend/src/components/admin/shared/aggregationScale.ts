/**
 * Turning aggregation tuning numbers into things an operator can reason about.
 *
 * "25,000,000" tells you nothing about whether it fits. "≈12.5 GB of graph
 * memory · covers a graph of ~12–16M edges" does. These helpers are shared by
 * the tuning form (live readouts under each field) and the job detail (budget
 * meter) so the two never disagree about what a number means.
 *
 * The cost constants live here rather than being re-typed at each call site —
 * they were previously duplicated across presets, placeholders and docs, which
 * is exactly how the frontend ended up overriding a changed backend default.
 */

/** A stored `:AGGREGATED` edge costs ~0.5KB of graph memory. */
export const BYTES_PER_AGG_EDGE = 512

/** An in-flight pair costs ~100 bytes of WORKER memory (5M ≈ 500MB packed). */
export const BYTES_PER_PENDING_PAIR = 100

/**
 * Canonical boundary pairs run roughly 1.5–2x the raw edge count, so a budget
 * of N covers a source graph of about N/2 to N/1.5 edges.
 */
export const PAIRS_PER_SOURCE_EDGE_LO = 1.5
export const PAIRS_PER_SOURCE_EDGE_HI = 2

/** Compact count: 950 → "950", 12_500 → "12.5K", 25_000_000 → "25M". */
export function compactCount(n: number): string {
    if (!Number.isFinite(n)) return '—'
    const abs = Math.abs(n)
    if (abs >= 1_000_000) {
        const v = n / 1_000_000
        return `${v % 1 === 0 ? v : v.toFixed(1)}M`
    }
    if (abs >= 1_000) {
        const v = n / 1_000
        return `${v % 1 === 0 ? v : v.toFixed(1)}K`
    }
    return String(n)
}

/** Byte count as GB/MB, one decimal where it earns its place. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—'
    const gb = bytes / 1e9
    if (gb >= 1) return `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB`
    const mb = bytes / 1e6
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/**
 * Write duty cycle from the pacing ratio. The pipeline sleeps
 * `duration x ratio` after each write, so the share of time actually spent
 * writing is `1 / (1 + ratio)` — which means a HIGHER ratio is slower. That
 * inversion is the single most misread knob in the panel, so the form states
 * the resulting percentage rather than leaving it to be inferred.
 */
export function writeDutyCyclePct(ratio: number): number {
    if (!Number.isFinite(ratio) || ratio < 0) return 100
    return Math.round(100 / (1 + ratio))
}

/** What a write budget of `edges` costs, and roughly what graph it covers. */
export function describeWriteBudget(edges: number): string {
    if (!Number.isFinite(edges) || edges <= 0) return ''
    const lo = compactCount(Math.round(edges / PAIRS_PER_SOURCE_EDGE_HI))
    const hi = compactCount(Math.round(edges / PAIRS_PER_SOURCE_EDGE_LO))
    return `≈${formatBytes(edges * BYTES_PER_AGG_EDGE)} of graph memory · covers a graph of ~${lo}–${hi} edges`
}

/** What an in-memory pair cap costs in worker RSS. */
export function describePendingPairs(pairs: number): string {
    if (!Number.isFinite(pairs) || pairs <= 0) return ''
    return `≈${formatBytes(pairs * BYTES_PER_PENDING_PAIR)} of worker memory before an early flush`
}

/** Severity of a budget utilisation ratio, matching the backend's advisory. */
export type BudgetPressure = 'ok' | 'warning' | 'critical'

export function budgetPressure(used: number, budget: number): BudgetPressure {
    if (!budget || !Number.isFinite(used)) return 'ok'
    const pct = used / budget
    if (pct >= 1) return 'critical'
    // Mirrors _BUDGET_PRESSURE_RATIO in falkordb_materialize.py — the point
    // at which the backend starts emitting a budget_pressure advisory.
    if (pct >= 0.75) return 'warning'
    return 'ok'
}
