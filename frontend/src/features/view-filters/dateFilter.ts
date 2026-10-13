/**
 * Date rules — how the view filters say "when".
 *
 * A rule is a short string kept in the page address (`created=7d`,
 * `updated=2026-09-01..2026-09-15`), never a pair of timestamps. A bookmark or a
 * saved filter for "the past 7 days" has to mean the past 7 days on the day it is
 * opened, and a timestamp baked into the address would freeze it on the day it was
 * made. It also keeps the React Query key stable all day: the old "recently added"
 * cutoff was `Date.now()` and had to be rounded to five minutes to stop the key —
 * and the fetch — changing on every render.
 *
 * Rules are CALENDAR days in the reader's own time zone. "Past 7 days" is today and
 * the six days before it, and a range includes its end day, which is what a person
 * picking 1–15 September on a calendar means. A rule resolves to the half-open
 * instant range [local midnight of the first day, local midnight after the last),
 * sent as UTC; the server compares those against its UTC timestamps.
 *
 * Grammar:
 *   today | yesterday | <N>d (1–3650: today and the N−1 days before)
 *   this-month | last-month | this-quarter | last-quarter | this-year
 *   YYYY | YYYY-MM | YYYY-MM-DD             one whole year, month or day
 *   A..B | A.. | ..B                        days, both ends included; either may be open
 *   visit                                   since your last visit — not days but the
 *                                           instants this browser remembers (see
 *                                           store/visitWindows), passed in to resolve
 */

export const MAX_ROLLING_DAYS = 3650

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^(\d{4})-(\d{2})$/
const YEAR_RE = /^\d{4}$/
const ROLLING_RE = /^(\d{1,4})d$/

/** Inclusive local calendar days; `null` = open on that side. */
export interface DaySpan { from: string | null; to: string | null }

/** ISO instants: `after` inclusive, `before` exclusive; `null` = unbounded. */
export interface RuleBounds { after: string | null; before: string | null }

export const VISIT_RULE = 'visit'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** A date's LOCAL calendar day as `YYYY-MM-DD`. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Shift a calendar day by whole days. Done on the label in UTC so a DST change in
 *  between can never make a "day" 23 or 25 hours long and land on the wrong date. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** The instant a calendar day starts in the reader's time zone. */
export function localMidnight(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

function monthSpan(y: number, m: number): { from: string; to: string } {
  // `m` is 0-based and may run past either end of the year; Date.UTC normalises it.
  const first = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  const last = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10)
  return { from: first, to: last }
}

function clampTo(span: { from: string; to: string }, today: string): DaySpan {
  return { from: span.from, to: span.to > today ? today : span.to }
}

/**
 * The calendar days a rule covers, as of `today` (a local `YYYY-MM-DD`). `null` for
 * an unknown rule. Periods that run past today stop at today, so "this month" never
 * claims days that have not happened.
 */
export function ruleDays(rule: string, today: string): DaySpan | null {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7)) - 1
  switch (rule) {
    case 'today': return { from: today, to: today }
    case 'yesterday': { const d = addDays(today, -1); return { from: d, to: d } }
    case 'this-month': return clampTo(monthSpan(y, m), today)
    case 'last-month': return monthSpan(y, m - 1)
    case 'this-quarter': {
      const q = Math.floor(m / 3) * 3
      return clampTo({ from: monthSpan(y, q).from, to: monthSpan(y, q + 2).to }, today)
    }
    case 'last-quarter': {
      const q = Math.floor(m / 3) * 3 - 3
      return { from: monthSpan(y, q).from, to: monthSpan(y, q + 2).to }
    }
    case 'this-year': return { from: `${y}-01-01`, to: today }
  }
  const rolling = ROLLING_RE.exec(rule)
  if (rolling) {
    const n = Number(rolling[1])
    if (n < 1 || n > MAX_ROLLING_DAYS) return null
    return { from: addDays(today, -(n - 1)), to: today }
  }
  if (YEAR_RE.test(rule)) return { from: `${rule}-01-01`, to: `${rule}-12-31` }
  const month = MONTH_RE.exec(rule)
  if (month) {
    const mm = Number(month[2])
    if (mm < 1 || mm > 12) return null
    return monthSpan(Number(month[1]), mm - 1)
  }
  if (DAY_RE.test(rule)) return isRealDay(rule) ? { from: rule, to: rule } : null
  const range = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/.exec(rule)
  if (range) {
    const [, a, b] = range
    if (!a && !b) return null
    if ((a && !isRealDay(a)) || (b && !isRealDay(b))) return null
    if (a && b && a > b) return null
    return { from: a ?? null, to: b ?? null }
  }
  return null
}

export function isValidRule(rule: string | null | undefined): rule is string {
  // Any fixed day works for validation: whether a rule parses never depends on it.
  return rule === VISIT_RULE || (typeof rule === 'string' && ruleDays(rule, '2000-01-01') !== null)
}

/**
 * The instants a rule covers: [local midnight of its first day, local midnight
 * after its last). `visit` covers the remembered window; with none (a first
 * visit, or after "Mark as seen") it covers nothing — an empty range rather than
 * no range, so the label never claims a filter the list isn't applying.
 */
export function ruleBounds(
  rule: string, today: string, visit?: { from: string; to: string } | null,
): RuleBounds | null {
  if (rule === VISIT_RULE) {
    const never = localMidnight(addDays(today, 1)).toISOString()
    return visit ? { after: visit.from, before: visit.to } : { after: never, before: never }
  }
  const span = ruleDays(rule, today)
  if (!span) return null
  return {
    after: span.from ? localMidnight(span.from).toISOString() : null,
    before: span.to ? localMidnight(addDays(span.to, 1)).toISOString() : null,
  }
}

/** Whole days in an inclusive span. */
export function spanLength(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

/** `12 Sep`, with the year added when it isn't this year's. */
export function formatDay(day: string, today: string): string {
  const d = localMidnight(day)
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short',
    ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
  })
}

const NAMED_LABELS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  'this-month': 'This month',
  'last-month': 'Last month',
  'this-quarter': 'This quarter',
  'last-quarter': 'Last quarter',
  'this-year': 'This year',
  [VISIT_RULE]: 'Since your last visit',
}

/** A rule in words, for triggers and chips: "Past 7 days", "1 Sep → 15 Sep". */
export function describeRule(rule: string, today: string): string {
  if (Object.hasOwn(NAMED_LABELS, rule)) return NAMED_LABELS[rule]
  const rolling = ROLLING_RE.exec(rule)
  if (rolling) return Number(rolling[1]) === 1 ? 'Today' : `Past ${Number(rolling[1])} days`
  if (YEAR_RE.test(rule)) return rule
  const month = MONTH_RE.exec(rule)
  if (month) {
    return new Date(Number(month[1]), Number(month[2]) - 1, 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }
  const span = ruleDays(rule, today)
  if (!span) return rule
  if (span.from && span.to) {
    return span.from === span.to
      ? formatDay(span.from, today)
      : `${formatDay(span.from, today)} → ${formatDay(span.to, today)}`
  }
  if (span.from) return `Since ${formatDay(span.from, today)}`
  return `Until ${formatDay(span.to!, today)}`
}

/** The quick choices in the Date menu, in the order they're offered. */
export const DATE_PRESETS: readonly { rule: string; label: string }[] = [
  { rule: 'today', label: 'Today' },
  { rule: '7d', label: 'Past 7 days' },
  { rule: 'yesterday', label: 'Yesterday' },
  { rule: '30d', label: 'Past 30 days' },
  { rule: 'this-month', label: 'This month' },
  { rule: '90d', label: 'Past 90 days' },
  { rule: 'last-month', label: 'Last month' },
  { rule: 'this-quarter', label: 'This quarter' },
  { rule: 'this-year', label: 'This year' },
  { rule: 'last-quarter', label: 'Last quarter' },
]

/** The rule for an inclusive span of days chosen on the calendar. */
export function rangeRule(from: string, to: string): string {
  return from === to ? from : `${from}..${to}`
}
