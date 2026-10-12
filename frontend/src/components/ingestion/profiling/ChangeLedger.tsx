/**
 * What happened, observation by observation — and what didn't.
 *
 * THE GAPS CARRY INFORMATION. The version this replaces dropped heartbeat
 * observations silently, so a stretch where nothing moved looked exactly like
 * a stretch where nothing was watching. Those are opposite facts: one says the
 * source is stable, the other says the pipeline is dead. Silence is now drawn
 * as its own mark, stating how long it lasted and how many checkpoints
 * confirmed it.
 *
 * AND IT SAYS WHICH PERIOD IT IS TALKING ABOUT. Every number here is scoped to
 * the selected window, which is invisible unless the surface says so — a
 * reader who believes they are looking at all of history draws the opposite
 * conclusion from "no movement" than one who knows they picked 24 hours.
 */
import { useMemo, useState } from 'react'
import { CheckCircle2, ChevronRight, Clock, Zap } from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import type { Observation, ObservationsPayload } from '@/types/profiling'
import {
    LANE_LABEL, REASON_LABEL, deltaTone, formatBucket, metricNoun,
    signed, significanceMeta, worstSignificance,
} from './shared'
import { UtcChip } from './UtcChip'

/** How near a refresh event has to be to be offered as an explanation. Wide
 *  enough to survive a slow capture, narrow enough that two unrelated things
 *  an hour apart are not presented as cause and effect. */
const CORRELATION_MS = 15 * 60 * 1000

function nearbyEvents(payload: ObservationsPayload, at: string) {
    const anchor = new Date(at).getTime()
    if (Number.isNaN(anchor)) return []
    return payload.events.filter((e) => {
        const ts = new Date(e.ts).getTime()
        return !Number.isNaN(ts) && Math.abs(ts - anchor) <= CORRELATION_MS
    })
}

function typeMovements(row: Observation, previous?: Observation) {
    if (!previous) return []
    const out: { name: string; before: number; after: number; kind: 'nodes' | 'edges' }[] = []
    for (const kind of ['nodes', 'edges'] as const) {
        const field = kind === 'nodes' ? 'entity_type_counts' : 'edge_type_counts'
        const after = row[field] ?? {}
        const before = previous[field] ?? {}
        for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
            const b = before[name] ?? 0
            const a = after[name] ?? 0
            if (b !== a) out.push({ name, before: b, after: a, kind })
        }
    }
    return out.sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before))
}

/** "3 days", "6 hours", "20 minutes" — the unit a person would use out loud. */
function humanSpan(ms: number): string {
    const minutes = Math.round(ms / 60000)
    if (minutes < 1) return 'under a minute'
    if (minutes < 90) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
    const hours = Math.round(minutes / 60)
    if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
    const days = Math.round(hours / 24)
    return `${days} ${days === 1 ? 'day' : 'days'}`
}

function spanMs(from: string, to: string): number {
    const a = new Date(from).getTime()
    const b = new Date(to).getTime()
    if (Number.isNaN(a) || Number.isNaN(b)) return 0
    return Math.abs(b - a)
}

/** A stretch where nothing moved, drawn between the changes that bracket it. */
function Silence({ span, checkpoints }: { span: string; checkpoints: number }) {
    return (
        <li aria-hidden={false} className="relative px-4 py-1.5">
            <span className="flex items-center gap-2 text-[11px] text-ink-muted">
                <span className="flex-1 border-t border-dashed border-glass-border" />
                <span className="shrink-0 inline-flex items-center gap-1.5">
                    <Clock className="w-3 h-3" aria-hidden />
                    nothing moved for {span}
                    {checkpoints > 0 && (
                        <> · {checkpoints} {checkpoints === 1 ? 'checkpoint' : 'checkpoints'}</>
                    )}
                </span>
                <span className="flex-1 border-t border-dashed border-glass-border" />
            </span>
        </li>
    )
}

function Row({
    row, previous, payload, expanded, onToggle,
}: {
    row: Observation
    previous?: Observation
    payload: ObservationsPayload
    expanded: boolean
    onToggle: () => void
}) {
    const worst = worstSignificance(row.significance?.nodes, row.significance?.edges)
    const meta = significanceMeta(worst)
    const events = expanded ? nearbyEvents(payload, row.at) : []
    const movements = expanded ? typeMovements(row, previous) : []
    const moved = Boolean(row.node_delta || row.edge_delta)

    return (
        <li className="border-b border-glass-border last:border-b-0">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                className={cn(
                    'w-full text-left px-4 py-3 flex items-start gap-3',
                    'hover:bg-canvas transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500',
                )}
            >
                <ChevronRight
                    className={cn(
                        'w-4 h-4 mt-0.5 shrink-0 text-ink-muted transition-transform',
                        expanded && 'rotate-90',
                    )}
                    aria-hidden
                />
                <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold text-ink tabular-nums">
                            {formatBucket(row.at)}
                        </span>
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                            {REASON_LABEL[row.reason]}
                        </span>
                        <span className="text-[11px] text-ink-muted">{LANE_LABEL[row.lane]}</span>
                        {row.refresh_event_id && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">
                                <Zap className="w-3 h-3" aria-hidden /> run
                            </span>
                        )}
                        {worst !== 'normal' && (
                            <span className={cn('text-[11px] font-bold uppercase tracking-wide', meta.tone)}>
                                {meta.label}
                            </span>
                        )}
                    </span>

                    {moved ? (
                        <span className="mt-1 flex flex-wrap gap-x-4 text-xs text-ink-secondary">
                            <span className="tabular-nums">
                                <span className={deltaTone(row.node_delta)}>{signed(row.node_delta)}</span>
                                {' '}{metricNoun('nodes', row.node_delta ?? 0)}
                                <span className="text-ink-muted"> · {exact(row.node_count)} total</span>
                            </span>
                            <span className="tabular-nums">
                                <span className={deltaTone(row.edge_delta)}>{signed(row.edge_delta)}</span>
                                {' '}{metricNoun('edges', row.edge_delta ?? 0)}
                                <span className="text-ink-muted"> · {exact(row.edge_count)} total</span>
                            </span>
                        </span>
                    ) : (
                        // A run that moved nothing is a finding, not a blank
                        // row: the loader ran and produced no change.
                        <span className="mt-1 block text-xs text-ink-muted">
                            {row.reason === 'run'
                                ? `This run changed nothing — still ${exact(row.node_count)} ${metricNoun('nodes', row.node_count)}.`
                                : row.reason === 'first'
                                    ? `The record starts here — ${exact(row.node_count)} ${metricNoun('nodes', row.node_count)}, ${exact(row.edge_count)} ${metricNoun('edges', row.edge_count)}.`
                                    : `No change — still ${exact(row.node_count)} ${metricNoun('nodes', row.node_count)}.`}
                        </span>
                    )}
                </span>
            </button>

            {expanded && (
                <div className="px-11 pb-4 space-y-3">
                    {movements.length > 0 && (
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
                                What moved
                            </p>
                            <ul className="space-y-0.5">
                                {movements.slice(0, 12).map((m) => (
                                    <li key={`${m.kind}-${m.name}`} className="text-xs flex items-baseline gap-2">
                                        <span className="font-medium text-ink">{m.name}</span>
                                        <span className="text-ink-muted tabular-nums">
                                            {exact(m.before)} → {exact(m.after)}
                                        </span>
                                        {!m.after && m.before > 0 && (
                                            <span className="text-rose-600 dark:text-rose-400 font-semibold">
                                                gone
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
                            What else was running
                        </p>
                        {events.length ? (
                            <ul className="space-y-0.5">
                                {events.map((e) => (
                                    <li key={e.id} className="text-xs text-ink-secondary">
                                        <span className="font-medium text-ink">{e.origin}</span>
                                        {' '}· {e.scope} · {e.outcome}
                                        {e.run_id && <span className="text-ink-muted"> · run {e.run_id}</span>}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            // Absence is the informative case, and saying so is
                            // the whole point: if nothing of ours ran, whatever
                            // changed this graph came from outside the platform.
                            <p className="text-xs text-ink-muted">
                                Nothing on this platform was running. Whatever changed this
                                source did so from outside.
                            </p>
                        )}
                    </div>
                </div>
            )}
        </li>
    )
}

export function ChangeLedger({
    payload, onlyNotable, onOnlyNotable, windowLabel,
}: {
    payload: ObservationsPayload
    onlyNotable: boolean
    onOnlyNotable: (next: boolean) => void
    /** The selected period, named. Every count below is scoped to it. */
    windowLabel: string
}) {
    const [open, setOpen] = useState<string | null>(null)

    /**
     * Movements, with the silence between them measured.
     *
     * Computed from the UNFILTERED list so a gap knows how many checkpoints
     * fell inside it. Filtering first would leave the gaps intact but make
     * them uncountable, which is how they became invisible in the first place.
     */
    const { entries, steady } = useMemo(() => {
        const all = payload.observations
        const rows: (
            | { kind: 'row'; row: Observation; previous?: Observation }
            | { kind: 'silence'; span: string; checkpoints: number }
        )[] = []

        const movements = all.filter((o) => o.reason !== 'heartbeat')
        // Newest-first, so "since" is measured from the newest movement to now.
        const newest = all[0]
        const newestMovement = movements[0]
        const steadyFor = newestMovement && newest && newest.id !== newestMovement.id
            ? {
                span: humanSpan(spanMs(newestMovement.at, newest.at)),
                since: newestMovement.at,
                checkpoints: all.findIndex((o) => o.id === newestMovement.id),
            }
            : null

        movements.forEach((row, i) => {
            const previous = movements[i + 1]
            rows.push({ kind: 'row', row, previous })
            if (!previous) return
            const between = all.filter((o) => o.at < row.at && o.at > previous.at)
            const gap = spanMs(previous.at, row.at)
            // Only worth drawing when the quiet is longer than the cadence —
            // a mark on every consecutive pair is noise, not information.
            if (between.length > 0 || gap > 2 * 60 * 60 * 1000) {
                rows.push({
                    kind: 'silence',
                    span: humanSpan(gap),
                    checkpoints: between.length,
                })
            }
        })

        return { entries: rows, steady: steadyFor }
    }, [payload.observations])

    const counts = payload.counts

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden shadow-sm">
            <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 border-b border-glass-border">
                <div className="min-w-0">
                    <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
                        Change ledger
                        {/* Every row below is an instant. The zone belongs
                            where the eye lands before reading them, not
                            stamped on forty consecutive rows. */}
                        <UtcChip />
                    </h3>
                    {/*
                      The period, stated. Without it a reader cannot tell "this
                      source is stable" from "I picked a 24-hour window", and
                      those lead to opposite actions.
                    */}
                    <p className="text-xs text-ink-muted mt-0.5 tabular-nums">
                        {windowLabel}
                        {counts && (
                            <>
                                {' · '}
                                <strong className="font-semibold text-ink-secondary">
                                    {exact(counts.observations)}
                                </strong>{' '}
                                {counts.observations === 1 ? 'observation' : 'observations'}
                                {' · '}
                                <strong className="font-semibold text-ink-secondary">
                                    {exact(counts.moved)}
                                </strong>{' '}
                                moved
                            </>
                        )}
                    </p>
                </div>
                <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer shrink-0">
                    <input
                        type="checkbox"
                        checked={onlyNotable}
                        onChange={(e) => onOnlyNotable(e.target.checked)}
                        className="rounded border-glass-border"
                    />
                    Unusual only
                </label>
            </header>

            {/* "Nothing has changed since then", said rather than implied. */}
            {steady && !onlyNotable && (
                <p className="flex items-start gap-2 px-4 py-2.5 bg-emerald-500/[0.06] border-b border-emerald-500/20 text-xs text-ink-secondary">
                    <CheckCircle2
                        className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                        aria-hidden
                    />
                    <span>
                        Steady for <strong className="font-semibold text-ink">{steady.span}</strong>
                        {steady.checkpoints > 0 && (
                            <> — {steady.checkpoints}{' '}
                                {steady.checkpoints === 1 ? 'checkpoint has' : 'checkpoints have'} confirmed
                                no movement</>
                        )}
                        {' '}since {formatBucket(steady.since)}.
                    </span>
                </p>
            )}

            {entries.length ? (
                <ul>
                    {entries.map((entry, i) => (
                        entry.kind === 'row' ? (
                            <Row
                                key={entry.row.id}
                                row={entry.row}
                                previous={entry.previous}
                                payload={payload}
                                expanded={open === entry.row.id}
                                onToggle={() => setOpen(open === entry.row.id ? null : entry.row.id)}
                            />
                        ) : (
                            <Silence
                                key={`gap-${i}`}
                                span={entry.span}
                                checkpoints={entry.checkpoints}
                            />
                        )
                    ))}
                </ul>
            ) : (
                <div className="px-4 py-8 text-center">
                    <CheckCircle2
                        className="w-7 h-7 mx-auto text-emerald-500/50 mb-2.5"
                        aria-hidden
                    />
                    <p className="text-sm font-semibold text-ink">
                        {onlyNotable
                            ? `Nothing unusual in the ${windowLabel.toLowerCase()}`
                            : `Nothing moved in the ${windowLabel.toLowerCase()}`}
                    </p>
                    <p className="text-xs text-ink-muted mt-1 max-w-sm mx-auto leading-relaxed">
                        {counts?.checkpoints
                            ? `${exact(counts.checkpoints)} ${counts.checkpoints === 1 ? 'checkpoint' : 'checkpoints'} confirmed it — this source was watched and did not change.`
                            : 'No observations were recorded in this period. Widen the window to reach further back.'}
                        {onlyNotable && ' Clear the filter to see every observation.'}
                    </p>
                </div>
            )}
        </section>
    )
}
