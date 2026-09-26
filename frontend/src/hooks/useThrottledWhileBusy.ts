/**
 * useThrottledWhileBusy — follow a value, but while `busy`, at most once per
 * `intervalMs`: a THROTTLE (the latest value lands on a steady beat), never
 * a debounce (which would freeze the picture for as long as updates keep
 * arriving).
 *
 * WHY. A streaming walk merges a page into the Lens's model about once a
 * second, and every new model re-derives the whole board — subgraph, edge
 * projection, layout, crossings — over everything walked so far. Measured on
 * a full-flow walk of a 600-column table (2026-09-21): ~350 MB allocated per
 * model, ~7 GB every twenty seconds, which is how a browser tab climbed past
 * 3 GB. The board cannot usefully redraw faster than a reader can read it;
 * adopting the model on a beat while pages stream in cuts that work by the
 * number of pages per beat, and the last page always lands.
 *
 * Adopted at once — no beat — when not busy (the walk has stopped: the
 * finished picture must not wait), or when the value belongs to a different
 * stream (`sameStream` false — a new focal must never show the previous
 * one's board for a beat).
 */
import { useEffect, useRef, useState } from 'react'

export function useThrottledWhileBusy<T>(
  value: T,
  busy: boolean,
  intervalMs: number,
  sameStream: (a: T, b: T) => boolean,
): T {
  const [held, setHeld] = useState(value)
  const adoptNow = held !== value && (!busy || !sameStream(held, value))
  if (adoptNow) setHeld(value)

  /** When the held value last changed — the beat is measured from it. */
  const lastRef = useRef(0)
  useEffect(() => {
    lastRef.current = Date.now()
  }, [held])

  useEffect(() => {
    if (held === value || adoptNow) return
    const wait = Math.max(0, lastRef.current + intervalMs - Date.now())
    const id = window.setTimeout(() => setHeld(value), wait)
    return () => window.clearTimeout(id)
  }, [value, held, adoptNow, intervalMs])

  return adoptNow ? value : held
}
