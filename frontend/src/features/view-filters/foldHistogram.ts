/**
 * The activity histogram, from the server's UTC buckets to the reader's own days.
 *
 * The server can only cut time in UTC (it slices its ISO timestamps as text), but
 * the Date menu's calendar shows the reader's LOCAL days — the same days the
 * date filter selects. So the server sends small buckets and the client folds each
 * into the local day it starts in. Hour buckets are exact for every whole-hour
 * time zone, DST included; a half-hour zone asks for ten-minute buckets instead,
 * which are exact there too (and within five minutes for the :45 zones).
 */
import { addDays, localDay } from './dateFilter'

export type HistogramGrain = 'hour' | '10min'

export interface HistogramBucket {
  /** `YYYY-MM-DDTHH` (hour) or `YYYY-MM-DDTHH:M` (ten minutes), UTC. */
  t: string
  n: number
}

/** The bucket size that lands exactly on this reader's midnights. */
export function grainFor(date: Date = new Date()): HistogramGrain {
  return date.getTimezoneOffset() % 60 === 0 ? 'hour' : '10min'
}

function bucketStart(t: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(?::(\d))?$/.exec(t)
  if (!m) return null
  const [, y, mo, d, h, tens] = m
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), tens ? Number(tens) * 10 : 0)
}

/** Count per local calendar day. */
export function foldHistogram(buckets: readonly HistogramBucket[]): Map<string, number> {
  const days = new Map<string, number>()
  for (const b of buckets) {
    const start = bucketStart(b.t)
    if (start === null) continue
    const day = localDay(new Date(start))
    days.set(day, (days.get(day) ?? 0) + b.n)
  }
  return days
}

/** Every local day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}
