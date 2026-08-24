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

/**
 * Timestamps, and why they are shaped like this.
 *
 * EVERYTHING HERE IS UTC. Bucket keys are ISO prefixes, so a day bucket IS a
 * UTC day; rendering its hours in the reader's zone would put an observation
 * on a different date from the bucket that contains it. Surfaces show the zone
 * once rather than stamping it on every label — see `TIME_ZONE_NOTE`.
 *
 * The clock is 24-hour, and not as a stylistic preference. `hour: '2-digit'`
 * alone renders "23 Aug, 21", which reads as "23 August 2021" long before it
 * reads as nine in the evening — a bare number after a comma is a year to
 * almost everyone. An explicit `21:00` cannot be misread.
 */
export const TIME_ZONE_LABEL = 'UTC'
export const TIME_ZONE_NOTE = 'times in UTC'

type Grain = 'day' | 'hour' | 'minute'

/** Bucket keys are ISO prefixes: 10 chars is a day, 13 an hour, longer is a
 *  raw instant. The grain is read off the key's own width, so a label never
 *  claims a precision the data does not have. */
function grainOf(bucket: string): Grain {
    if (bucket.length <= 10) return 'day'
    if (bucket.length <= 13) return 'hour'
    return 'minute'
}

function toDate(bucket: string): Date | null {
    const padded = bucket.length <= 10
        ? `${bucket}T00:00:00Z`
        : bucket.length <= 13 ? `${bucket}:00:00Z` : bucket
    const at = new Date(padded)
    return Number.isNaN(at.getTime()) ? null : at
}

function datePart(at: Date): string {
    return at.toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', timeZone: 'UTC',
    })
}

function timePart(at: Date): string {
    return at.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'UTC',
    })
}

/**
 * Full, with the zone named — for anything read on its own.
 *
 * A tooltip, an alert timestamp or a coverage line is read in isolation and
 * often copied into a ticket or compared against another system's log. That
 * reading has to survive leaving this page, and "23 Aug 21:32" does not: the
 * reader supplies their own zone and is wrong by however many hours they are
 * from Greenwich.
 *
 * Lists use `formatBucket` with a zone marker in their header instead —
 * stamping UTC on forty consecutive rows is noise, and the header is where
 * someone's eye already is before they start reading times.
 */
export function formatBucketUtc(bucket: string): string {
    const label = formatBucket(bucket)
    return label ? `${label} ${TIME_ZONE_LABEL}` : label
}

/** An instant from anywhere in the payload, rendered in UTC like every bucket.
 *
 *  Alert timestamps and coverage dates were going through `toLocaleString()`,
 *  so the same event read 22:32 in the findings band and 21:32 in the ledger
 *  one card below. Silently mixing zones is worse than an unlabelled one. */
export function formatInstant(iso: string | null | undefined, withZone = true): string {
    if (!iso) return ''
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return iso
    const label = `${datePart(at)} ${timePart(at)}`
    return withZone ? `${label} ${TIME_ZONE_LABEL}` : label
}

/** A date on its own, in UTC — coverage lines and anything day-grained. */
export function formatDay(iso: string | null | undefined): string {
    if (!iso) return ''
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? iso : datePart(at)
}

/** Full and unambiguous — tooltips, ledger rows, anything read on its own. */
export function formatBucket(bucket: string): string {
    if (!bucket) return ''
    const at = toDate(bucket)
    if (!at) return bucket
    if (grainOf(bucket) === 'day') return datePart(at)
    return `${datePart(at)} ${timePart(at)}`
}

/**
 * Axis labels, with the date carried only where it CHANGES.
 *
 * Six ticks spanning two days were printing the date six times — "23 Aug, 23
 * Aug, 24 Aug, 24 Aug, 24 Aug, 24 Aug". Repetition that dense stops being
 * information and starts being texture, and it crowds out the part that
 * varies. Eliding it also turns the day boundary into something a reader can
 * SEE, because the only labels carrying a date are the ones that start one.
 */
export function axisLabels(buckets: string[]): string[] {
    let lastDate: string | null = null
    return buckets.map((bucket) => {
        const at = toDate(bucket)
        if (!at) return bucket
        const grain = grainOf(bucket)
        const date = datePart(at)
        if (grain === 'day') {
            lastDate = date
            return date
        }
        const time = timePart(at)
        if (date === lastDate) return time
        lastDate = date
        return `${date} ${time}`
    })
}
