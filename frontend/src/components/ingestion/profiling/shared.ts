/**
 * Vocabulary shared across the profiling surface.
 *
 * One place for the words and the tones, because the chart, the board, the
 * ledger and the findings band all describe the same events and a reader who
 * learns "severe" in one must not meet a different meaning in another.
 */
import type { Observation, Significance } from '@/types/profiling'

/** Plain nouns for the two measures. "Nodes" and "edges" are what the graph
 *  calls them; these are what the people who onboard the data call them. */
export const METRIC_NOUN = {
    nodes: { one: 'entity', many: 'entities' },
    edges: { one: 'relationship', many: 'relationships' },
} as const

export function metricNoun(metric: 'nodes' | 'edges', count: number): string {
    const noun = METRIC_NOUN[metric]
    return Math.abs(count) === 1 ? noun.one : noun.many
}

export const SIGNIFICANCE = {
    normal: { rank: 0, label: 'Ordinary', tone: 'text-ink-muted' },
    notable: { rank: 1, label: 'Notable', tone: 'text-amber-600 dark:text-amber-400' },
    severe: { rank: 2, label: 'Severe', tone: 'text-rose-600 dark:text-rose-400' },
    critical: { rank: 3, label: 'Critical', tone: 'text-rose-700 dark:text-rose-300' },
} as const

export function significanceMeta(value: Significance | undefined) {
    return SIGNIFICANCE[value ?? 'normal'] ?? SIGNIFICANCE.normal
}

/** The worst of a set — used wherever one row summarises several measures. */
export function worstSignificance(...values: (Significance | undefined)[]): Significance {
    return values.reduce<Significance>((worst, v) => (
        significanceMeta(v).rank > significanceMeta(worst).rank ? (v ?? worst) : worst
    ), 'normal')
}

/**
 * What produced an observation.
 *
 * `run` is deliberately first-class rather than a flavour of `changed`: a run
 * that moved nothing is itself a finding — the loader ran and produced no
 * movement — and it is the only reason bound to a specific refresh event.
 */
export const LANE_LABEL: Record<Observation['lane'], string> = {
    probe: 'Drift probe',
    poll: 'Scheduled poll',
    deep: 'Deep profile',
    sweep: 'Reconcile sweep',
    write: 'Platform write',
}

export const REASON_LABEL: Record<Observation['reason'], string> = {
    first: 'First observation',
    changed: 'Counts changed',
    heartbeat: 'Checkpoint',
    run: 'Refresh run',
}

/** Signed, and stillness is not a movement. `+0` reads as a change; `—` does
 *  not, and the difference matters on a ledger of things that happened. */
export function signed(value: number | null | undefined): string {
    if (value === null || value === undefined || value === 0) return '—'
    return `${value > 0 ? '+' : '−'}${Math.abs(value).toLocaleString()}`
}

export function deltaTone(value: number | null | undefined): string {
    if (!value) return 'text-ink-muted'
    return value > 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-rose-600 dark:text-rose-400'
}

/** Bucket keys are ISO prefixes: 10 chars is a day, 13 an hour, longer is a
 *  raw instant. Formatted from the key's own width so the axis never claims
 *  a precision the data does not have. */
export function formatBucket(bucket: string): string {
    if (!bucket) return ''
    if (bucket.length <= 10) {
        return new Date(`${bucket}T00:00:00Z`).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', timeZone: 'UTC',
        })
    }
    if (bucket.length <= 13) {
        return new Date(`${bucket}:00:00Z`).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', timeZone: 'UTC',
        })
    }
    const at = new Date(bucket)
    return Number.isNaN(at.getTime()) ? bucket : at.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        timeZone: 'UTC',
    })
}
