/**
 * Shared vocabulary for the counts-history surface.
 *
 * One definition each for the things every panel here has to agree on: how a
 * number is abbreviated, what colour a delta is, and what a lane is called.
 * Three components rendering "+12.4k" three slightly different ways is how a
 * page stops reading as one thing.
 */
import type { LucideIcon } from 'lucide-react'
import { Activity, Gauge, Layers, PencilLine, Radar } from 'lucide-react'

import type { HistoryEvent } from '@/types/insights'
import { toUtcDate } from '@/lib/timeAgo'

/** Abbreviated count. Matches `DataSourceProfile.compactNum` so a number does
 *  not change shape between the profile and the history it links to. */
export function compactNum(n: number | null | undefined): string {
    if (n == null) return '—'
    const abs = Math.abs(n)
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
    if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
    return String(n)
}

/** Signed, abbreviated. `0` renders as "0", not "+0" — a no-change is not a
 *  movement and should not be dressed as one. */
export function signedNum(n: number | null | undefined): string {
    if (n == null) return '—'
    if (n === 0) return '0'
    return `${n > 0 ? '+' : '−'}${compactNum(Math.abs(n))}`
}

export function formatPct(pct: number | null | undefined): string | null {
    if (pct == null) return null
    const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10
    return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}%`
}

/** Growth is emerald, loss is red, flat is muted.
 *
 *  Loss is red rather than amber on purpose: on this page a negative number is
 *  usually the thing you came to find, and amber reads as "degraded", not as
 *  "entities disappeared". */
export function deltaTone(delta: number | null | undefined): string {
    if (!delta) return 'text-ink-muted bg-black/5 dark:bg-white/5'
    return delta > 0
        ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
        : 'text-red-600 dark:text-red-400 bg-red-500/10'
}

export interface LaneMeta {
    label: string
    hint: string
    icon: LucideIcon
    tint: string
}

/** The five collection lanes, named as the docs name them. Surfaced because
 *  "only the hourly sweep ever observes this source" is a real diagnosis, and
 *  it is invisible without this. */
export const LANE_META: Record<string, LaneMeta> = {
    probe: {
        label: 'Probe',
        hint: 'Constant-time counter read — the 60s drift probe',
        icon: Radar,
        tint: 'text-indigo-600 dark:text-indigo-400 bg-indigo-500/10',
    },
    poll: {
        label: 'Poll',
        hint: 'Full counts scan on the stats poll',
        icon: Gauge,
        tint: 'text-violet-600 dark:text-violet-400 bg-violet-500/10',
    },
    deep: {
        label: 'Deep',
        hint: 'Deep schema profile — labels, samples and edge types',
        icon: Layers,
        tint: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10',
    },
    sweep: {
        label: 'Sweep',
        hint: 'Observed by the reconciliation sweep',
        icon: Activity,
        tint: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
    },
    write: {
        label: 'Write',
        hint: 'Recorded by an application write path',
        icon: PencilLine,
        tint: 'text-slate-600 dark:text-slate-400 bg-slate-500/10',
    },
}

export function laneMeta(lane: string): LaneMeta {
    return LANE_META[lane] ?? LANE_META.write
}

/** Time-of-day for a point, in UTC — the same clock the timestamps are in.
 *  Rendering these in local time would put a snapshot on the wrong day for
 *  half the world. */
export function clockUtc(ts: string): string {
    const d = toUtcDate(ts)
    if (!d) return ''
    return d.toLocaleTimeString('en-US', {
        timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    })
}

/** `Today` / `Yesterday` / `12 Aug` — the day-grouping vocabulary
 *  `ViewActivityTimeline` established. */
export function dayLabel(ts: string): string {
    const d = toUtcDate(ts)
    if (!d) return ''
    const today = new Date()
    const dayStart = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
    const diffDays = Math.round((dayStart(today) - dayStart(d)) / 86_400_000)
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    return d.toLocaleDateString('en-US', {
        timeZone: 'UTC', day: 'numeric', month: 'short',
        ...(d.getUTCFullYear() !== today.getUTCFullYear() ? { year: 'numeric' } : {}),
    })
}

/** Axis label for a bucket key or ISO instant. Day buckets get a date, hour
 *  buckets and raw instants get a time. */
export function axisLabel(ts: string, grain: string): string {
    const d = toUtcDate(ts.length === 10 ? `${ts}T00:00:00` : ts)
    if (!d) return ''
    if (grain === 'day') {
        return d.toLocaleDateString('en-US', {
            timeZone: 'UTC', day: 'numeric', month: 'short',
        })
    }
    return d.toLocaleTimeString('en-US', {
        timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    })
}

/**
 * Categorical series colours.
 *
 * Hand-picked rather than generated: these have to stay distinguishable when
 * stacked as adjacent areas, in both themes, and a hue-rotation generator
 * produces neighbouring bands that differ by less than the fill opacity does.
 * Nine plus a muted "Other", which is one more than the eight labels the chart
 * shows — so "Other" is never mistaken for a real series.
 */
export const SERIES_COLORS = [
    '#6366f1', // indigo — the platform accent, so the largest label leads
    '#10b981', // emerald
    '#f59e0b', // amber
    '#06b6d4', // cyan
    '#ec4899', // pink
    '#8b5cf6', // violet
    '#14b8a6', // teal
    '#f97316', // orange
    '#3b82f6', // blue
] as const

export const OTHER_COLOR = '#94a3b8' // slate-400 — reads as "not a series"

export function seriesColor(index: number): string {
    return SERIES_COLORS[index % SERIES_COLORS.length]
}


/** How the platform names the thing that emitted a refresh event.
 *
 *  The wire values are terse and two of them look alike: `reconcile` is the
 *  stale-marker reconciler, `reconcile-sweep` is the drift/overlay sweep. They
 *  are different subsystems and a reader chasing a drop needs to know which
 *  one acted, so they get different names here rather than both reading
 *  "reconcile". */
export const ORIGIN_LABEL: Record<string, string> = {
    script: 'Load script',
    connector: 'Connector',
    api: 'API request',
    drift: 'Drift signal',
    reconcile: 'Stale-marker reconcile',
    'reconcile-sweep': 'Reconciliation sweep',
}

export const OUTCOME_TONE: Record<string, string> = {
    completed: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
    accepted: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
    noop: 'text-ink-muted bg-black/5 dark:bg-white/5',
    deferred: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
    conflict: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
    error: 'text-red-600 dark:text-red-400 bg-red-500/10',
    failed: 'text-red-600 dark:text-red-400 bg-red-500/10',
}

/**
 * How far either side of an observation a platform event counts as "at the
 * same moment", in milliseconds.
 *
 * Lives here rather than on the backend because the matching is per-entry and
 * the UI already holds every event in the window — the API returns the window,
 * this decides what is "near".
 *
 * Generous on purpose, and matching the backend's own window. An event is
 * emitted when an operation is DECIDED and the snapshot written when the
 * result is next observed; on the 900s poll lane those are minutes apart for
 * the same cause, and a tight window would report "nothing was running" for a
 * change our own sweep had just caused.
 */
export const EVENT_CORRELATION_WINDOW_MS = 15 * 60 * 1000

/** Platform events close enough in time to this observation to be plausibly
 *  related, newest first. */
export function nearbyEvents(
    events: HistoryEvent[], at: string,
): HistoryEvent[] {
    const anchor = toUtcDate(at)?.getTime()
    if (anchor == null) return []
    return events
        .filter((event) => {
            const ts = toUtcDate(event.ts)?.getTime()
            return ts != null && Math.abs(ts - anchor) <= EVENT_CORRELATION_WINDOW_MS
        })
        .sort((a, b) => (b.ts > a.ts ? 1 : -1))
}
