/**
 * usePlacementChains — the containment chains of loaded entities whose parent the canvas has not
 * loaded, for the One Placement Contract (lib/placement): with them, a hand placement on an ancestor
 * the canvas never loaded still cascades down to the entity (see placeCanvasNodes). Flag-on only —
 * the canvas hands it no URNs otherwise.
 *
 * URNs only, no names. Batched through the provider's bulk chain lookup, CHUNK URNs per request and
 * CONCURRENCY requests at a time. Each URN is asked once; one the provider could not answer is asked
 * again on the next change, up to MAX_ATTEMPTS asks in all, and then left unknown, asked once more
 * every NO_PLACE_RETRY_MS: a passing overload (a shed chain query) must not keep a hand placement
 * from reaching it for the session. A reader without the containment walk (501) is not asked again.
 * A new provider is a new graph, so everything is forgotten.
 *
 * Returns urn → its ancestors, PARENT FIRST, root last ([] = a root). An absent urn is UNKNOWN.
 */
import { useEffect, useRef, useState } from 'react'

import { mapWithConcurrency } from '@/lib/concurrency'
import { useGraphProvider } from '@/providers'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

type Chains = ReadonlyMap<string, readonly string[]>

const NONE: Chains = new Map()
/** The route answers up to 1,000 URNs; the same chunk as the other chain readers. */
const CHUNK = 500
const CONCURRENCY = 2
/** Asks per URN before it is given up on, as useAncestorChains gives up. */
const MAX_ATTEMPTS = 5
/** How long a given-up URN waits before it is asked once more, as in useAncestorChains. */
const NO_PLACE_RETRY_MS = 5 * 60_000

export function usePlacementChains(urns: readonly string[]): Chains {
  const provider = useGraphProvider()
  // Keyed by the provider it was answered for, so a switch never shows the old graph's chains.
  const [known, setKnown] = useState<{ provider: GraphDataProvider | null; chains: Chains }>({ provider: null, chains: NONE })
  const providerRef = useRef<GraphDataProvider | null>(null)
  const askedRef = useRef(new Set<string>())
  const attemptsRef = useRef(new Map<string, number>())
  const unsupportedRef = useRef(false)
  // Bumped when given-up URNs are due to be asked once more.
  const [wake, setWake] = useState(0)
  // One per batch of URNs given up on, until it asks them again.
  const givenUpTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())

  // A given-up URN is a fact about one graph: a provider switch or unmount drops its timer.
  useEffect(() => {
    const timers = givenUpTimersRef.current
    return () => {
      timers.forEach(clearTimeout)
      timers.clear()
    }
  }, [provider])

  useEffect(() => {
    if (providerRef.current !== provider) {
      providerRef.current = provider
      askedRef.current = new Set()
      attemptsRef.current = new Map()
      unsupportedRef.current = false
    }
    if (unsupportedRef.current || typeof provider.getAncestorChains !== 'function') return
    const asked = askedRef.current
    const attempts = attemptsRef.current
    // Unknown: asked again on a later change, until it has been asked MAX_ATTEMPTS times; then
    // once more after NO_PLACE_RETRY_MS (and given up on again at once if that fails too).
    const givenUp: string[] = []
    const again = (urn: string) => {
      const n = (attempts.get(urn) ?? 0) + 1
      attempts.set(urn, n)
      if (n < MAX_ATTEMPTS) asked.delete(urn)
      else givenUp.push(urn)
    }
    const wanted = urns.filter(u => !asked.has(u))
    if (wanted.length === 0) return
    wanted.forEach(u => asked.add(u))
    const chunks: string[][] = []
    for (let i = 0; i < wanted.length; i += CHUNK) chunks.push(wanted.slice(i, i + CHUNK))
    void mapWithConcurrency(chunks, CONCURRENCY, chunk => provider.getAncestorChains!(chunk)).then(results => {
      if (providerRef.current !== provider) return            // answered for another graph
      const found = new Map<string, readonly string[]>()
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          for (const urn of chunks[i]) {
            const chain = result.value[urn]
            if (chain) found.set(urn, chain)
            else again(urn)
          }
        } else if ((result.reason as { status?: number } | undefined)?.status === 501) {
          unsupportedRef.current = true                        // no containment walk on this reader
        } else {
          chunks[i].forEach(again)
        }
      })
      if (givenUp.length > 0) {
        const timer = setTimeout(() => {
          givenUpTimersRef.current.delete(timer)
          givenUp.forEach(urn => asked.delete(urn))
          setWake(n => n + 1)
        }, NO_PLACE_RETRY_MS)
        givenUpTimersRef.current.add(timer)
      }
      if (found.size === 0) return
      setKnown(prev => ({
        provider,
        chains: new Map([...(prev.provider === provider ? prev.chains : NONE), ...found]),
      }))
    })
  }, [provider, urns, wake])

  return known.provider === provider ? known.chains : NONE
}
