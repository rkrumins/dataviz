/**
 * ChangeLedger — every observation where something actually moved, grouped by
 * day.
 *
 * Filters to `changed` and `first` snapshots on purpose. The heartbeat rows
 * exist so the chart has no gaps; putting them in a ledger would bury eleven
 * real changes under seven hundred "nothing happened" entries, which is the
 * opposite of what a ledger is for.
 *
 * Follows the day-grouped shape `ViewActivityTimeline` established: a date
 * heading, then entries with a lane badge, the delta, and the labels behind
 * it, expandable to the full before → after breakdown.
 */
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Minus, TrendingDown, TrendingUp } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { HistoryPoint } from '@/types/insights'
import { clockUtc, compactNum, dayLabel, laneMeta, signedNum } from './shared'

interface TypeDelta {
    added: Record<string, number>
    removed: Record<string, number>
    changed: Record<string, [number, number]>
}

/** The per-label movement behind one snapshot.
 *
 *  Derived on the client from the two adjacent points rather than read from
 *  the row's stored `type_deltas`, because at hour/day grain the adjacent
 *  points are bucket closings and the stored delta describes the raw
 *  neighbour — which is not the comparison the reader is looking at. At raw
 *  grain the two agree.
 */
function deriveDelta(prev: HistoryPoint | undefined, point: HistoryPoint): TypeDelta {
    const before = prev?.entity_type_counts ?? {}
    const after = point.entity_type_counts ?? {}
    const added: Record<string, number> = {}
    const removed: Record<string, number> = {}
    const changed: Record<string, [number, number]> = {}
    for (const [label, count] of Object.entries(after)) {
        if (!before[label] && count) added[label] = count
        else if (before[label] && before[label] !== count) changed[label] = [before[label], count]
    }
    for (const [label, count] of Object.entries(before)) {
        if (count && !after[label]) removed[label] = count
    }
    return { added, removed, changed }
}

function summarise(delta: TypeDelta): string {
    const parts: string[] = []
    const added = Object.keys(delta.added)
    const removed = Object.keys(delta.removed)
    const changed = Object.keys(delta.changed)
    if (added.length) parts.push(`${added.length} label${added.length > 1 ? 's' : ''} appeared`)
    if (removed.length) parts.push(`${removed.length} label${removed.length > 1 ? 's' : ''} disappeared`)
    if (changed.length) parts.push(`${changed.length} changed`)
    return parts.join(' · ') || 'Counts unchanged per label'
}

export function ChangeLedger({ points, highlightAt, className }: {
    points: HistoryPoint[]
    /** Timestamp to expand and scroll into view — set when a drop marker on
     *  the chart is activated. */
    highlightAt?: string | null
    className?: string
}) {
    const [expanded, setExpanded] = useState<string | null>(null)

    // Day headings are computed here rather than tracked with a `lastDay`
    // variable while mapping: reassigning across a render is exactly what
    // breaks when React replays one, and the answer is per-entry data anyway.
    const entries = useMemo(() => {
        const kept: Array<{ point: HistoryPoint; prev?: HistoryPoint }> = []
        points.forEach((point, i) => {
            if (point.capture_reason === 'heartbeat') return
            kept.push({ point, prev: points[i - 1] })
        })
        kept.reverse() // newest first
        let previousDay: string | null = null
        return kept.map((entry) => {
            const day = dayLabel(entry.point.at)
            const startsDay = day !== previousDay
            previousDay = day
            return { ...entry, day, startsDay }
        })
    }, [points])

    if (!entries.length) {
        return (
            <div className={cn('px-4 py-8 text-center', className)}>
                <Minus className="w-5 h-5 text-ink-muted mx-auto mb-2" />
                <p className="text-sm font-semibold text-ink">Nothing changed in this window</p>
                <p className="text-xs text-ink-muted mt-1">
                    Counts were observed and held steady. That is a finding, not a gap.
                </p>
            </div>
        )
    }

    return (
        <div className={className}>
            {entries.map(({ point, prev, day, startsDay }) => {
                const lane = laneMeta(point.lane)
                const delta = deriveDelta(prev, point)
                const isOpen = expanded === point.at || highlightAt === point.at
                const dropped = (point.node_delta ?? 0) < 0
                const Trend = dropped ? TrendingDown : TrendingUp

                return (
                    <div key={point.at} id={`change-${point.at}`}>
                        {startsDay && (
                            <div className="px-4 pt-4 pb-1.5">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                                    {day}
                                </span>
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => setExpanded(isOpen ? null : point.at)}
                            aria-expanded={isOpen}
                            className={cn(
                                'w-full text-left px-4 py-2.5 flex items-start gap-3',
                                'hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
                                highlightAt === point.at && 'bg-red-500/5 ring-1 ring-inset ring-red-500/25',
                            )}
                        >
                            <span className={cn(
                                'mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
                                point.capture_reason === 'first'
                                    ? 'text-ink-muted bg-black/5 dark:bg-white/5'
                                    : dropped
                                        ? 'text-red-600 dark:text-red-400 bg-red-500/10'
                                        : 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
                            )}>
                                {point.capture_reason === 'first'
                                    ? <Minus className="w-3.5 h-3.5" />
                                    : <Trend className="w-3.5 h-3.5" />}
                            </span>

                            <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-bold text-ink tabular-nums">
                                        {clockUtc(point.at)}
                                    </span>
                                    <span
                                        className={cn(
                                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md',
                                            'text-[10px] font-semibold uppercase tracking-wide',
                                            lane.tint,
                                        )}
                                        title={lane.hint}
                                    >
                                        <lane.icon className="w-3 h-3" />{lane.label}
                                    </span>
                                    {point.capture_reason === 'first' && (
                                        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                                            first snapshot
                                        </span>
                                    )}
                                </span>
                                <span className="block text-xs text-ink-secondary mt-0.5 truncate">
                                    {point.capture_reason === 'first'
                                        ? `History starts here — ${compactNum(point.node_count)} entities`
                                        : summarise(delta)}
                                </span>
                            </span>

                            <span className="flex items-center gap-2 shrink-0">
                                <span className="text-right tabular-nums">
                                    <span className={cn(
                                        'block text-sm font-bold',
                                        (point.node_delta ?? 0) > 0
                                            ? 'text-emerald-600 dark:text-emerald-400'
                                            : (point.node_delta ?? 0) < 0
                                                ? 'text-red-600 dark:text-red-400'
                                                : 'text-ink-muted',
                                    )}>
                                        {point.node_delta == null ? '—' : signedNum(point.node_delta)}
                                    </span>
                                    <span className="block text-[10px] text-ink-muted">
                                        {compactNum(point.node_count)} total
                                    </span>
                                </span>
                                {isOpen
                                    ? <ChevronDown className="w-4 h-4 text-ink-muted mt-1" />
                                    : <ChevronRight className="w-4 h-4 text-ink-muted mt-1" />}
                            </span>
                        </button>

                        {isOpen && (
                            <div className="px-4 pb-3 pl-14">
                                <DeltaBreakdown delta={delta} />
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

function DeltaBreakdown({ delta }: { delta: TypeDelta }) {
    const rows: Array<{ label: string; before: number; after: number; kind: string }> = [
        ...Object.entries(delta.removed).map(([label, before]) => ({
            label, before, after: 0, kind: 'removed',
        })),
        ...Object.entries(delta.added).map(([label, after]) => ({
            label, before: 0, after, kind: 'added',
        })),
        ...Object.entries(delta.changed).map(([label, [before, after]]) => ({
            label, before, after, kind: 'changed',
        })),
    ].sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))

    if (!rows.length) {
        return (
            <p className="text-xs text-ink-muted">
                Totals moved without any single label changing — check the relationship
                counts.
            </p>
        )
    }

    return (
        <div className="rounded-xl border border-glass-border bg-canvas-elevated divide-y divide-glass-border">
            {rows.slice(0, 12).map((row) => (
                <div key={row.label} className="flex items-center gap-3 px-3 py-1.5 min-w-0">
                    <span className="text-xs font-semibold text-ink truncate flex-1 min-w-0">
                        {row.label}
                    </span>
                    <span className="text-[11px] text-ink-muted tabular-nums shrink-0">
                        {compactNum(row.before)} → {compactNum(row.after)}
                    </span>
                    <span className={cn(
                        'text-[11px] font-bold tabular-nums shrink-0 w-16 text-right',
                        row.after > row.before
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400',
                    )}>
                        {signedNum(row.after - row.before)}
                    </span>
                </div>
            ))}
            {rows.length > 12 && (
                <p className="px-3 py-1.5 text-[11px] text-ink-muted">
                    +{rows.length - 12} more label{rows.length - 12 > 1 ? 's' : ''}
                </p>
            )}
        </div>
    )
}
