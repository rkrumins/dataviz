/**
 * When this source was checked, and how it went.
 *
 * The counts series answers "what did this source contain, and when did that
 * change". It cannot answer "was anybody watching": capture is change-gated,
 * and a failed collection writes nothing at all, so a source that has been
 * steady for a day and a source nobody has been able to reach for a day are
 * the same picture there — a flat line. Reading liveness out of the absence of
 * movement is exactly the inference that hides an outage, and this card is
 * what replaces it.
 *
 * ONE ROW PER LANE, not one row in total. The lanes run at wildly different
 * cadences — a drift probe every minute, a poll every fifteen, a reconcile
 * sweep on its own interval — and merging them produces a solid bar that is
 * healthy-looking precisely because the fastest lane fills every gap the
 * others leave. Separated, "the probe is fine but the deep profile has not
 * run since Tuesday" is visible at a glance, and that is the diagnosis.
 *
 * TIME-POSITIONED, not evenly spaced. Every column is a fixed slice of the
 * window, so a gap occupies the width of the time it covers. Laying the checks
 * out end to end would close every gap by construction and make an outage look
 * like a slightly shorter row.
 */
import { useMemo } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { CheckEvent, CheckLane, ChecksPayload } from '@/types/profiling'
import {
    CHECK_LANE_LABEL, checkOutcomeMeta, formatInstant, TIME_ZONE_NOTE,
} from './shared'

/** 96 slices spans a day at fifteen-minute resolution — the cadence people
 *  actually ask about — and stays legible at drawer width. */
const SLOTS = 96

interface Slot {
    ok: number
    error: number
    skipped: number
    from: number
    to: number
}

type LaneRow = { lane: CheckLane; slots: Slot[]; total: number; failed: number }

function emptySlots(from: number, to: number): Slot[] {
    const width = (to - from) / SLOTS
    return Array.from({ length: SLOTS }, (_, i) => ({
        ok: 0, error: 0, skipped: 0,
        from: from + i * width, to: from + (i + 1) * width,
    }))
}

/** Group into (lane x time slot). A slot takes the WORST outcome it holds:
 *  one failure inside fifteen minutes of successes is the thing worth seeing,
 *  and averaging it away is how a strip becomes decoration. */
function toLanes(checks: CheckEvent[], from: number, to: number): LaneRow[] {
    const byLane = new Map<CheckLane, LaneRow>()
    const width = Math.max(1, (to - from) / SLOTS)

    for (const check of checks) {
        const at = new Date(check.checkedAt).getTime()
        if (Number.isNaN(at)) continue
        let row = byLane.get(check.lane)
        if (!row) {
            row = { lane: check.lane, slots: emptySlots(from, to), total: 0, failed: 0 }
            byLane.set(check.lane, row)
        }
        row.total += 1
        if (check.outcome === 'error') row.failed += 1
        const index = Math.min(SLOTS - 1, Math.max(0, Math.floor((at - from) / width)))
        row.slots[index][check.outcome] += 1
    }

    // Busiest lane first: the one with the most evidence is the one a reader
    // should calibrate the others against.
    return [...byLane.values()].sort((a, b) => b.total - a.total)
}

function slotOutcome(slot: Slot): 'error' | 'skipped' | 'ok' | null {
    if (slot.error) return 'error'
    if (slot.ok) return 'ok'
    if (slot.skipped) return 'skipped'
    return null
}

function slotTitle(slot: Slot, lane: CheckLane): string {
    const when = formatInstant(new Date(slot.from).toISOString())
    const outcome = slotOutcome(slot)
    if (!outcome) return `${when} — no check recorded`
    const parts = [
        slot.ok && `${slot.ok} healthy`,
        slot.error && `${slot.error} failed`,
        slot.skipped && `${slot.skipped} not validated`,
    ].filter(Boolean)
    return `${when} — ${CHECK_LANE_LABEL[lane]}: ${parts.join(', ')}`
}

function humanInterval(secs: number): string {
    if (secs >= 3600) return `${Math.round(secs / 360) / 10}h`
    if (secs >= 60) return `${Math.round(secs / 60)} min`
    return `${secs}s`
}

interface Props {
    payload: ChecksPayload | undefined
    isLoading?: boolean
    isError?: boolean
    windowLabel: string
    className?: string
}

export function CheckPulse({
    payload, isLoading, isError, windowLabel, className,
}: Props) {
    const lanes = useMemo(() => {
        if (!payload) return []
        const from = new Date(payload.from).getTime()
        const to = new Date(payload.to).getTime()
        if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return []
        return toLanes(payload.checks, from, to)
    }, [payload])

    if (isLoading) {
        return (
            <div className={cn(
                'flex items-center gap-2 rounded-xl border border-glass-border',
                'bg-canvas-elevated px-4 py-3.5 text-xs text-ink-muted', className,
            )}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                Reading this source's check history…
            </div>
        )
    }

    // A read that failed is not "never checked". Saying so is the difference
    // between a reader chasing an outage and a reader retrying a request.
    if (isError) {
        return (
            <div className={cn(
                'flex items-center gap-2 rounded-xl border border-glass-border',
                'bg-canvas-elevated px-4 py-3.5 text-xs text-ink-muted', className,
            )}>
                <TriangleAlert className="w-3.5 h-3.5 text-amber-500" aria-hidden />
                The check history could not be read — this says nothing about
                whether the source was checked.
            </div>
        )
    }

    const summary = payload?.summary
    const total = summary?.total ?? 0

    return (
        <figure className={cn(
            'rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3.5',
            className,
        )}>
            <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                    Checked
                </span>
                <span className="text-[11px] text-ink-muted">
                    {total === 0
                        ? `Nothing recorded in the last ${windowLabel.toLowerCase()}`
                        : (
                            <>
                                <strong className="text-ink font-semibold">
                                    {total.toLocaleString()}
                                </strong>
                                {' '}checks over {windowLabel.toLowerCase()} ·{' '}
                                {summary?.error
                                    ? (
                                        <span className="text-rose-600 dark:text-rose-400 font-semibold">
                                            {summary.error.toLocaleString()} failed
                                        </span>
                                    )
                                    : <span className="text-emerald-600 dark:text-emerald-400 font-semibold">all healthy</span>}
                            </>
                        )}
                </span>
            </figcaption>

            {total === 0 ? (
                <p className="text-xs text-ink-secondary">
                    No lane has recorded a check for this source in this window.
                    That is a statement about the record, not about the source —
                    check history begins when a lane first runs against it.
                </p>
            ) : (
                <div className="space-y-1.5">
                    {lanes.map((row) => {
                        const laneLabel = CHECK_LANE_LABEL[row.lane] ?? row.lane
                        return (
                            <div key={row.lane} className="flex items-center gap-2.5">
                                <span className="w-28 shrink-0 text-[11px] font-medium text-ink-secondary truncate">
                                    {laneLabel}
                                </span>
                                <span
                                    className="flex-1 flex items-stretch gap-px h-3 rounded-sm overflow-hidden"
                                    role="img"
                                    aria-label={
                                        `${laneLabel}: ${row.total} checks, `
                                        + (row.failed
                                            ? `${row.failed} failed`
                                            : 'all healthy')
                                    }
                                >
                                    {row.slots.map((slot, i) => {
                                        const outcome = slotOutcome(slot)
                                        return (
                                            <span
                                                key={i}
                                                title={slotTitle(slot, row.lane)}
                                                className={cn(
                                                    'flex-1 min-w-px rounded-[1px]',
                                                    outcome
                                                        ? checkOutcomeMeta(outcome).mark
                                                        // A gap is drawn, not omitted: an
                                                        // absent column has to read as
                                                        // "nothing looked", which a blank
                                                        // does not.
                                                        // Plain token, no alpha suffix: an
                                                        // alpha on a CSS-variable token emits no
                                                        // CSS at all, and an invisible gap is
                                                        // the one thing this strip cannot have.
                                                        : 'bg-glass-border',
                                                )}
                                            />
                                        )
                                    })}
                                </span>
                                <span className={cn(
                                    'w-20 shrink-0 text-right text-[11px] tabular-nums',
                                    row.failed
                                        ? 'text-rose-600 dark:text-rose-400 font-semibold'
                                        : 'text-ink-muted',
                                )}>
                                    {row.failed
                                        ? `${row.failed.toLocaleString()} failed`
                                        : row.total.toLocaleString()}
                                </span>
                            </div>
                        )
                    })}
                </div>
            )}

            {/*
              What a gap MEANS. Without this the strip overstates its own
              precision: a check that found nothing new inside the sampling
              interval is coalesced away, so a one-column gap is not evidence
              that nothing ran.
            */}
            <p className="mt-3 text-[10px] leading-relaxed text-ink-muted">
                Each column is {' '}
                {payload ? humanInterval(
                    Math.max(
                        1,
                        Math.round(
                            (new Date(payload.to).getTime()
                                - new Date(payload.from).getTime()) / 1000 / SLOTS,
                        ),
                    ),
                ) : 'a slice'}{' '}
                of the window; {TIME_ZONE_NOTE}. Repeat checks that found
                nothing new are recorded at most every{' '}
                {humanInterval(summary?.sample_secs ?? 300)}, so a short gap is
                not evidence that nothing ran — a long one is.
                {payload?.truncated && ' Showing the most recent checks only.'}
            </p>
        </figure>
    )
}
