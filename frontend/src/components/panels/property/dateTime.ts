/**
 * dateTime — a property that holds a moment (an ISO 8601 date and time): stored one way, picked in
 * the reader's own time.
 *
 * A moment is stored in UTC as `YYYY-MM-DDTHH:MM:SSZ`, with `.sss` when it has milliseconds. The
 * server stores every write that way (`backend/common/moments.py`), and this module writes the same
 * form, so what is edited is what is stored. A moment with no zone reads as UTC, as the app shows
 * one (`toUtcDate`).
 */

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** The instant (ms since the epoch) a moment names — UTC when it says no zone — or null. */
function instantOf(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = INSTANT.exec(v.trim())
  if (!m) return null
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]]
  const s = m[6] ? +m[6] : 0
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0
  let off = 0
  if (m[8] && m[8].toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[8])
    if (!z) return null
    off = (z[1] === '-' ? -1 : 1) * (+z[2] * 60 + +(z[3] ?? 0))
  }
  const at = Date.UTC(y, mo - 1, d, h, mi, s, ms) - off * 60_000
  // 2026-02-30 is not a day.
  const check = new Date(Date.UTC(y, mo - 1, d))
  return check.getUTCDate() === d ? at : null
}

/** A moment in its stored form: UTC, to the second, `.sss` only when it has milliseconds. */
function stored(at: number): string {
  const iso = new Date(at).toISOString()          // 2026-11-18T05:42:00.000Z
  return iso.endsWith('.000Z') ? `${iso.slice(0, 19)}Z` : iso
}

/** A moment: an ISO 8601 date and time, with or without a zone. Not a bare date (`isIsoDate`). */
export function isIsoInstant(v: unknown): v is string {
  return instantOf(v) !== null
}

/** The moment in its stored form (`2026-11-18 07:42+02:00` → `2026-11-18T05:42:00Z`); anything
 *  that isn't a moment as it is. */
export function canonicalInstant<T>(v: T): T | string {
  const at = instantOf(v)
  return at === null ? v : stored(at)
}

/** The moment for a date-and-time picker (`<input type="datetime-local">`), in the reader's time;
 *  '' for anything that isn't a moment. */
export function toLocalInput(v: unknown): string {
  const at = instantOf(v)
  if (at === null) return ''
  const d = new Date(at)
  const ms = d.getMilliseconds()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + (ms ? `.${pad(ms, 3)}` : '')
}

/** What a picker's value (`2026-11-18T06:42`, the reader's time) stores: the moment in its stored
 *  form. Null when it isn't a time. */
export function fromLocalInput(local: string): string | null {
  const m = LOCAL.exec(local.trim())
  if (!m) return null
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, ms).getTime()
  return Number.isNaN(at) ? null : stored(at)
}

/** Now, in its stored form, to the second: a new moment's first value. */
export function nowInstant(): string {
  return stored(Math.floor(Date.now() / 1000) * 1000)
}

/** The reader's time zone, as the picker's hint names it (`Europe/London`). */
export function readerZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your time' } catch { return 'your time' }
}
