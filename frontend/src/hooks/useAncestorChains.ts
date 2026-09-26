/**
 * useAncestorChains — where the lineage endpoints the canvas does not draw
 * live.
 *
 * A lineage edge arrives naming both of its ends, but the canvas only draws
 * what the reader has opened. An end it does not draw — a partner inside a
 * collapsed container, a row of an anchored column past its loaded page —
 * cannot be drawn to, so the edge projection counted the flow "outside this
 * view" even when that partner sat inside a container on screen. Measured
 * live: 909 of 998 loaded lineage edges.
 *
 * This asks the server for each such end's containment chain (parent first,
 * root last; URNs only — nothing is loaded, no row appears) so the
 * projection can roll the line up to the nearest container the reader CAN
 * see, or into the column whose anchor the chain reaches. The ends asked
 * for are those of the store's lineage edges and of the aggregated roll-ups
 * that are not rendered, not an anchor (drawn as its column) and not a
 * logical group; and the drawn rows whose parent is not loaded, since
 * another drawn row may hold one further up.
 *
 * Contract: an end missing from the map is PENDING, still being asked, and
 * the projection holds it back rather than flash a stub. One the server
 * left out, or whose request failed, is asked again on this hook's own
 * backoff (lookupRetryDelayMs), not on the next canvas change; after
 * MAX_ATTEMPTS it is published as NO_PLACE_FOUND, and asked once more every
 * NO_PLACE_RETRY_MS: a passing overload (a shed chain query) must not leave
 * a partner in the view without a place for the session. A 403 is asked
 * again the same way: the route is always answered now, so a refusal is
 * passing (a rolling deploy), not a verdict for the session. `undefined`
 * means there is no chain source at all — the hook is off, the provider
 * has no chain route, or it answered 501 — and the projection then reads an
 * end it cannot place as leading outside, as it did before.
 */
import { useEffect, useRef, useState } from 'react'

import { lookupRetryDelayMs } from '@/config/polling'
import { mapWithConcurrency } from '@/lib/concurrency'
import { useGraphProvider } from '@/providers'
import { useCanvasStore, useCanvasVersion } from '@/store/canvas'
import { normalizeEdgeType } from '@/store/schema'

const CHUNK_SIZE = 500
/** Chunks in flight at once: a big view opens in parallel without flooding
 *  the route. */
const CONCURRENCY = 2
/** Shorter than the degree cue's settle: this one decides whether a line is
 *  drawn at all, not a badge beside it. */
const SETTLE_MS = 300
/** Asks per end before its place is given up on. */
const MAX_ATTEMPTS = 5
/** How long a given-up end waits before it is asked once more. */
const NO_PLACE_RETRY_MS = 5 * 60_000

const NO_CHAINS: ReadonlyMap<string, readonly string[]> = new Map()
const NO_ROWS: readonly string[] = []

/** The chain published for an end the server never placed in MAX_ATTEMPTS
 *  asks: no ancestors. Its own identity, so the projection tells "could not
 *  be placed" from a real root: its place is unknown, never outside. */
export const NO_PLACE_FOUND: readonly string[] = Object.freeze([])

type AggregatedEnds = ReadonlyMap<string, {
  aggregated: { sourceUrn: string; targetUrn: string }
  detailedEdges?: ReadonlyArray<{ sourceUrn: string; targetUrn: string }>
}>

export function useAncestorChains(
  enabled: boolean,
  isContainmentEdge: (edgeType: string) => boolean,
  /** Every node the canvas renders (its displayMap): these need no chain. */
  placed: ReadonlyMap<string, unknown>,
  /** Anchors drawn as their column (useLayerAssignment). */
  promotedAnchors: ReadonlyMap<string, string>,
  aggregatedEdges: AggregatedEnds,
  /** Drawn rows whose containment parent is not loaded (unparentedRows). */
  unparented: readonly string[] = NO_ROWS,
): ReadonlyMap<string, readonly string[]> | undefined {
  const provider = useGraphProvider()
  const canvasVersion = useCanvasVersion()
  const [chains, setChains] = useState<ReadonlyMap<string, readonly string[]>>(NO_CHAINS)
  // The provider that answered 501. Keyed on it, so a switch clears it.
  const [unsupportedBy, setUnsupportedBy] = useState<unknown>(null)
  // Bumped to run the settle again: a retry is due, or a change arrived
  // while a settle was in flight.
  const [wake, setWake] = useState(0)
  // Asked for (or answered): never asked again. Cleared per URN to retry.
  const askedRef = useRef<Set<string>>(new Set())
  const attemptsRef = useRef<Map<string, number>>(new Map())
  const runningRef = useRef(false)
  const againRef = useRef(false)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // One per batch of ends given up on, until it asks them again.
  const givenUpTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  // Bumped on a provider switch. A chain is a fact about ONE graph: an
  // answer that lands after the switch is dropped.
  const generationRef = useRef(0)

  // Provider switch — every chain belongs to another graph.
  useEffect(() => {
    generationRef.current += 1
    askedRef.current = new Set()
    attemptsRef.current = new Map()
    const raf = requestAnimationFrame(() => setChains(NO_CHAINS))
    const givenUpTimers = givenUpTimersRef.current
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = undefined
      givenUpTimers.forEach(clearTimeout)
      givenUpTimers.clear()
    }
  }, [provider])

  const supported = enabled && typeof provider.getAncestorChains === 'function' && unsupportedBy !== provider

  useEffect(() => {
    if (!supported) return
    const timer = setTimeout(async () => {
      // One settle at a time; this one runs again when it is done.
      if (runningRef.current) { againRef.current = true; return }
      const wanted = new Set<string>()
      const want = (end: string) => {
        if (!placed.has(end) && !promotedAnchors.has(end) && !end.startsWith('logical:')
          && !askedRef.current.has(end)) wanted.add(end)
      }
      for (const edge of useCanvasStore.getState().edges) {
        if (isContainmentEdge(normalizeEdgeType(edge))) continue
        want(edge.source)
        want(edge.target)
      }
      aggregatedEdges.forEach(({ aggregated, detailedEdges }) => {
        want(aggregated.sourceUrn)
        want(aggregated.targetUrn)
        detailedEdges?.forEach(e => { want(e.sourceUrn); want(e.targetUrn) })
      })
      for (const row of unparented) if (!askedRef.current.has(row)) wanted.add(row)
      if (wanted.size === 0) return

      const generation = generationRef.current
      const urns = [...wanted]
      urns.forEach(u => askedRef.current.add(u))
      const chunks: string[][] = []
      for (let i = 0; i < urns.length; i += CHUNK_SIZE) chunks.push(urns.slice(i, i + CHUNK_SIZE))
      runningRef.current = true
      try {
        const results = await mapWithConcurrency(chunks, CONCURRENCY, chunk => provider.getAncestorChains!(chunk))
        if (generation !== generationRef.current) return
        const found = new Map<string, readonly string[]>()
        const unanswered: string[] = []
        let unsupported = false
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            for (const urn of chunks[i]) {
              const chain = result.value[urn]
              if (chain) found.set(urn, chain)
              else unanswered.push(urn)
            }
          } else {
            // No containment walk on this reader (501): nothing to gain from
            // asking again. Anything else, a 403 included, is asked again.
            if ((result.reason as { status?: number }).status === 501) unsupported = true
            else unanswered.push(...chunks[i])
          }
        })
        if (unsupported) { setUnsupportedBy(provider); return }

        // Unknown, not rootless: asked again after a wait, until given up on,
        // and then once more after a long one.
        let failures = 0
        const givenUp: string[] = []
        for (const urn of unanswered) {
          const attempts = (attemptsRef.current.get(urn) ?? 0) + 1
          attemptsRef.current.set(urn, attempts)
          if (attempts >= MAX_ATTEMPTS) { found.set(urn, NO_PLACE_FOUND); givenUp.push(urn); continue }
          askedRef.current.delete(urn)
          failures = Math.max(failures, attempts)
        }
        if (givenUp.length > 0) {
          const timer = setTimeout(() => {
            givenUpTimersRef.current.delete(timer)
            givenUp.forEach(urn => askedRef.current.delete(urn))
            setWake(n => n + 1)
          }, NO_PLACE_RETRY_MS)
          givenUpTimersRef.current.add(timer)
        }
        if (found.size > 0) {
          setChains(prev => {
            const next = new Map(prev)
            found.forEach((chain, urn) => next.set(urn, chain))
            return next
          })
        }
        if (failures > 0 && retryTimerRef.current === undefined) {
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = undefined
            setWake(n => n + 1)
          }, lookupRetryDelayMs(failures))
        }
      } finally {
        runningRef.current = false
        if (againRef.current) { againRef.current = false; setWake(n => n + 1) }
      }
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [supported, provider, canvasVersion, isContainmentEdge, placed, promotedAnchors, aggregatedEdges, unparented, wake])

  return supported ? chains : undefined
}
