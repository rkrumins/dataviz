/**
 * useResolvedNames — display names from the SERVER, for urns the canvas has
 * not loaded (2026-08-22).
 *
 * The canvas can only name what it has hydrated, which after a reload is the
 * lane roots and nothing else. Anything that outlives a page — the trace
 * history above all — therefore labelled itself from URN tails
 * (`intermediate_t2_17d10688`) and changed its mind later, as the reader
 * happened to expand the containers those entities live in. A name is not a
 * function of what is expanded.
 *
 * So: ask the data source. One batched question per set of unknown urns,
 * each urn asked at most once per session, and a failure that leaves the
 * caller exactly where it was — a missing name falls back to whatever the
 * caller was showing before. Names are a convenience; they never warrant an
 * error state or a retry storm.
 *
 * The CALLER decides what needs resolving (it knows what it can already
 * name), which keeps this hook free of any canvas coupling.
 */
import { useEffect, useRef, useState } from 'react'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

/** Urns per request. The trace history is capped at 50, so one round trip is
 *  the normal case; the chunk only matters for a caller with more. */
const CHUNK = 100

export function useResolvedNames(
  urns: readonly string[],
  provider: GraphDataProvider | null,
): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map())
  /** Every urn already asked about — answered or not. A urn the data source
   *  does not return does not exist; asking again would not change that. */
  const asked = useRef(new Set<string>())

  useEffect(() => {
    if (!provider) return
    const need: string[] = []
    for (const urn of urns) {
      if (urn && !asked.current.has(urn) && !need.includes(urn)) need.push(urn)
    }
    if (need.length === 0) return
    for (const urn of need) asked.current.add(urn)

    // NO TEARDOWN FLAG. The caller's list is derived from a canvas that
    // re-renders all through hydration, so this effect is rebuilt constantly
    // — and an answer already in flight is still the answer. Dropping it on
    // teardown lost the names for good (measured in the browser: the request
    // returned 200 with the names in it and the launcher kept showing urn
    // tails), because the rebuilt effect finds those urns already asked for.
    // React 19 ignores a state write after unmount, so nothing needs guarding.
    void (async () => {
      for (let i = 0; i < need.length; i += CHUNK) {
        const chunk = need.slice(i, i + CHUNK)
        try {
          const fetched = await provider.getNodes({ urns: chunk, limit: chunk.length })
          if (fetched.length === 0) continue
          setNames(prev => {
            const next = new Map(prev)
            for (const n of fetched) if (n.urn && n.displayName) next.set(n.urn, n.displayName)
            return next
          })
        } catch {
          // Un-ask, so a later change can try again — a lookup that never
          // reached the server has not answered anything.
          for (const urn of chunk) asked.current.delete(urn)
        }
      }
    })()
  }, [urns, provider])

  return names
}
