/**
 * Times as a reader wants them, at every age.
 *
 * "3w ago" answers nothing in a log: was that before or after the outage? A
 * label should say what is most useful at its age — how recently, while that
 * is the question ("12 min ago"); the clock time, once it is today's or
 * yesterday's ("Today 09:41"); the weekday for this week; then the date. The
 * exact instant — in the reader's zone, in UTC, and as ISO — is one hover away
 * (see `DateTime`), because "when exactly" is the question an investigation
 * ends on.
 *
 * Calendar words (today, yesterday) are the reader's calendar: the local zone.
 * Formatting follows the reader's locale, so 24- or 12-hour clocks and the
 * order of day and month are theirs.
 */
import { toUtcDate } from './timeAgo'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export { toUtcDate }

function startOfDay(t: number): number {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}

// A page can hold hundreds of times, each re-labelled on every tick: build
// each formatter once (locale and zone are fixed for the page's life).
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = JSON.stringify(options)
    let f = formatters.get(key)
    if (!f) {
        f = new Intl.DateTimeFormat(undefined, options)
        formatters.set(key, f)
    }
    return f
}

const clockFmt = () => formatter({ hour: '2-digit', minute: '2-digit' })
let relative: Intl.RelativeTimeFormat | undefined

/** "Today", "Yesterday" or the weekday, while one of those says which day; else null. */
function dayWord(at: Date, now: number): string | null {
    const today = startOfDay(now)
    const day = startOfDay(at.getTime())
    if (day === today) return 'Today'
    if (day === startOfDay(today - 1)) return 'Yesterday'
    if (day > today - 6 * DAY && day < today) return formatter({ weekday: 'short' }).format(at)
    return null
}

function dateLabel(at: Date, now: number): string {
    const sameYear = new Date(now).getFullYear() === at.getFullYear()
    return formatter(sameYear
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' }).format(at)
}

/** The label for scanning a list: relative while recent, then a clock time, then a date. */
export function smartTime(at: Date, now: number): string {
    const diff = now - at.getTime()
    if (diff < 0) {
        // A clock a little ahead of ours is "just now", not "in 2 s".
        if (-diff < MINUTE) return 'just now'
        if (-diff < HOUR) return `in ${Math.round(-diff / MINUTE)} min`
    } else {
        if (diff < 45_000) return 'just now'
        if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))} min ago`
        if (diff < 6 * HOUR) return `${Math.floor(diff / HOUR)} h ago`
    }
    const day = dayWord(at, now)
    return day ? `${day} ${clockFmt().format(at)}` : dateLabel(at, now)
}

/** A moment on the calendar, never relative: "Today 09:41", "Mon 18:02",
 *  "12 Oct 09:41". For a sequence of moments — a run's timeline — where
 *  "3 h ago" three times over says nothing. */
export function calendarTime(at: Date, now: number): string {
    return `${dayWord(at, now) ?? dateLabel(at, now)} ${clockFmt().format(at)}`
}

/** For a list already grouped by day: how recently while that is the
 *  question (under an hour), and otherwise the clock time alone. */
export function clockTime(at: Date, now: number): string {
    const diff = now - at.getTime()
    return diff > -MINUTE && diff < HOUR ? smartTime(at, now) : clockFmt().format(at)
}

/** "12 minutes ago", "yesterday", "in 3 hours" — the hover card's lead. */
export function relativeLong(at: Date, now: number): string {
    const diff = at.getTime() - now
    const abs = Math.abs(diff)
    const rtf = (relative ??= new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }))
    if (abs < 45_000) return 'just now'
    if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), 'minute')
    if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour')
    if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), 'day')
    if (abs < 365 * DAY) return rtf.format(Math.round(diff / (30 * DAY)), 'month')
    return rtf.format(Math.round(diff / (365 * DAY)), 'year')
}

/** "+01:00" for the reader's zone at that instant (zones change offset). */
function utcOffset(at: Date): string {
    const minutes = -at.getTimezoneOffset()
    const sign = minutes >= 0 ? '+' : '−'
    const abs = Math.abs(minutes)
    return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

export interface Instant {
    /** "Monday, 12 October 2026" */
    date: string
    /** "09:41:07" */
    time: string
    /** "BST" or "GMT+1": the zone's short name where the locale has one. */
    zone: string
    /** "UTC+01:00" */
    offset: string
    /** "08:41:07 UTC" */
    utcTime: string
    /** "12 Oct 2026" in UTC — differs from the local date near midnight. */
    utcDate: string
    /** "2026-10-12T08:41:07.000Z" */
    iso: string
}

/** One instant, spelled out every way an investigation needs it. */
export function describeInstant(at: Date): Instant {
    const zonePart = formatter({ timeZoneName: 'short' })
        .formatToParts(at).find((p) => p.type === 'timeZoneName')
    return {
        date: formatter({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(at),
        time: formatter({ hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(at),
        zone: zonePart?.value ?? '',
        offset: utcOffset(at),
        utcTime: `${formatter({
            hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', hour12: false,
        }).format(at)} UTC`,
        utcDate: formatter({ day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at),
        iso: at.toISOString(),
    }
}

/** A span of time, compact and exact enough: "<1 s", "45 s", "3 min 12 s", "2 h 05 min", "3 d 4 h". */
export function formatSpan(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    const s = Math.round(ms / 1000)
    if (ms < 1000) return '<1 s'
    if (s < 60) return `${s} s`
    if (s < 3600) {
        const m = Math.floor(s / 60)
        const rest = s % 60
        return rest ? `${m} min ${rest} s` : `${m} min`
    }
    if (s < 86_400) {
        const h = Math.floor(s / 3600)
        const m = Math.floor((s % 3600) / 60)
        return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`
    }
    const d = Math.floor(s / 86_400)
    const h = Math.floor((s % 86_400) / 3600)
    return h ? `${d} d ${h} h` : `${d} d`
}
