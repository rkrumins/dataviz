/**
 * Relative + absolute time formatting — "2h ago", plus a full UTC display.
 *
 * ALL timestamps are normalized to UTC. Backend timestamps are UTC, but many are serialized WITHOUT
 * a timezone designator (e.g. Postgres `2026-07-05T09:24:05.265673`); `new Date()` then parses those
 * as LOCAL time, skewing every relative label by the viewer's offset (the "Updated 1h / Synced 4h"
 * nonsense). `toUtcDate` appends a 'Z' when no offset is present so the instant is unambiguous.
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** Parse a timestamp to a UTC Date. No-timezone strings are treated as UTC (not local). */
export function toUtcDate(ts?: string | null): Date | null {
  if (!ts) return null
  const s = String(ts).trim()
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)
  const d = new Date(hasTz ? s : `${s}Z`)
  return isNaN(d.getTime()) ? null : d
}

/** Absolute UTC display, e.g. "Jul 5, 2026, 12:28 UTC". */
export function formatUtc(ts?: string | null): string {
  const d = toUtcDate(ts)
  if (!d) return ''
  return `${d.toLocaleString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })} UTC`
}

export function timeAgo(dateString: string): string {
  const date = toUtcDate(dateString)
  if (!date) return ''
  const now = Date.now()
  const seconds = Math.floor((now - date.getTime()) / 1000)

  if (seconds < MINUTE) return 'just now'
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE)
    return `${m}m ago`
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR)
    return `${h}h ago`
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY)
    return `${d}d ago`
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK)
    return `${w}w ago`
  }
  if (seconds < YEAR) {
    const m = Math.floor(seconds / MONTH)
    return `${m}mo ago`
  }
  const y = Math.floor(seconds / YEAR)
  return `${y}y ago`
}
