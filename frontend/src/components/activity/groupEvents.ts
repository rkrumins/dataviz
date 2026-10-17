/**
 * How the timeline reads a page of events: a day at a time, with runs of the
 * same fact folded into one row.
 */
import { toUtcDate } from '@/lib/timeAgo'
import type { ActivityEvent } from '@/services/activityService'

export interface TimelineRow {
    event: ActivityEvent
    /** How many identical events this row stands for. */
    count: number
}

export interface TimelineDay {
    key: string
    label: string
    rows: TimelineRow[]
}

function dayKey(d: Date): string {
    return d.toDateString()
}

function dayLabel(d: Date, now: Date): string {
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    if (d.toDateString() === now.toDateString()) return 'Today'
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
    return d.toLocaleDateString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    })
}

/** Two events are the same fact when the same person did the same thing to
 *  the same target, for the same stated reason. */
function sameFact(a: ActivityEvent, b: ActivityEvent): boolean {
    return a.eventType === b.eventType
        && (a.actor?.id ?? a.actorKind) === (b.actor?.id ?? b.actorKind)
        && (a.target?.id ?? null) === (b.target?.id ?? null)
        && (a.workspaceId ?? null) === (b.workspaceId ?? null)
        && (a.statedReason ?? null) === (b.statedReason ?? null)
        && a.summary === b.summary
}

/**
 * Group by the reader's local day, folding runs of identical adjacent events.
 * Events arrive newest first, so a folded row keeps the NEWEST occurrence and
 * counts the older ones behind it.
 */
export function groupEvents(events: ActivityEvent[], now: Date = new Date()): TimelineDay[] {
    const days: TimelineDay[] = []
    for (const event of events) {
        const at = toUtcDate(event.occurredAt) ?? now
        const key = dayKey(at)
        let day = days[days.length - 1]
        if (!day || day.key !== key) {
            day = { key, label: dayLabel(at, now), rows: [] }
            days.push(day)
        }
        const last = day.rows[day.rows.length - 1]
        if (last && sameFact(last.event, event)) last.count += 1
        else day.rows.push({ event, count: 1 })
    }
    return days
}
