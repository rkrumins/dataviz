/**
 * usePlacementAncestry — where entities sit in the DATA (their ancestors), for saying so wherever a
 * view places them: the canvas's "Placed · Part of …" (only the part above what it has loaded) and
 * the View Wizard's assigned rows (the whole path). One lookup, shared.
 *
 * Batched: the containment-chain endpoint answers up to 500 entities per request; where a reader
 * cannot (it is feature-gated, or an older reader), each entity is asked alone — capped in number
 * and concurrency, so a view with thousands of placements never floods the server. Names come in
 * batches too. Returns urn → its ancestors, ROOT FIRST ([] = a root). An absent urn is UNKNOWN (not
 * answered yet, or the reader could not answer) — callers show "…", never a wrong path.
 */
import { useEffect, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers'
import type { AncestorRef } from '@/types/search'

const NONE: ReadonlyMap<string, readonly AncestorRef[]> = new Map()
const CHAIN_CHUNK = 500
const NAME_CHUNK = 200
/** Without the batched endpoint: at most this many entities asked one by one, this many at a time. */
const SINGLE_CAP = 200
const SINGLE_CONCURRENCY = 6

export function usePlacementAncestry(urns: readonly string[]): ReadonlyMap<string, readonly AncestorRef[]> {
  const provider = useGraphProvider()
  const [known, setKnown] = useState<ReadonlyMap<string, readonly AncestorRef[]>>(NONE)
  const askedRef = useRef<Set<string>>(new Set())
  // Bumped per graph. An answer is dropped only when it belongs to ANOTHER graph — never because the
  // component re-rendered meanwhile: with the asked-set, a dropped answer would never be re-asked.
  const generationRef = useRef(0)
  const noBatchRef = useRef(false)
  const key = [...urns].sort().join('|')

  // A different graph: every answer belongs to the old one.
  useEffect(() => {
    generationRef.current += 1
    askedRef.current = new Set()
    noBatchRef.current = false
    const raf = requestAnimationFrame(() => setKnown(NONE))
    return () => cancelAnimationFrame(raf)
  }, [provider])

  useEffect(() => {
    const wanted = urns.filter((u) => !askedRef.current.has(u) && !u.startsWith('logical:'))
    if (wanted.length === 0) return
    wanted.forEach((u) => askedRef.current.add(u))
    const generation = generationRef.current
    const publish = (entries: Array<[string, AncestorRef[]]>) => {
      if (generation !== generationRef.current || entries.length === 0) return
      setKnown((prev) => new Map([...prev, ...entries]))
    }
    const forget = (list: string[]) => list.forEach((u) => askedRef.current.delete(u))

    ;(async () => {
      // 1. Batched chains (URNs, parent first), then the ancestors' names in batches.
      if (!noBatchRef.current && typeof provider.getAncestorChains === 'function') {
        try {
          for (let i = 0; i < wanted.length; i += CHAIN_CHUNK) {
            const chunk = wanted.slice(i, i + CHAIN_CHUNK)
            const chains = await provider.getAncestorChains(chunk)
            const names = [...new Set(Object.values(chains).flat())]
            const byUrn = new Map<string, { displayName: string; entityType: string }>()
            for (let j = 0; j < names.length; j += NAME_CHUNK) {
              const part = names.slice(j, j + NAME_CHUNK)
              const nodes = await provider.getNodes({ urns: part, limit: part.length } as never)
              nodes.forEach((n) => byUrn.set(n.urn, n))
            }
            publish(Object.entries(chains).map(([urn, chain]) => [urn, [...chain].reverse().map((a) => ({
              urn: a, displayName: byUrn.get(a)?.displayName ?? a, entityType: byUrn.get(a)?.entityType ?? '',
            }) as AncestorRef)]))
            forget(chunk.filter((u) => !(u in chains)))               // unknown: ask again later
          }
          return
        } catch {
          noBatchRef.current = true                                 // this reader can't batch: one by one
        }
      }
      // 2. One by one — capped, a few at a time.
      const single = wanted.slice(0, SINGLE_CAP)
      forget(wanted.slice(SINGLE_CAP))
      let next = 0
      const worker = async () => {
        while (next < single.length) {
          const urn = single[next++]
          try {
            const ancestors = await provider.getAncestors(urn)       // parent first, root last
            publish([[urn, [...ancestors].reverse().map((n) => ({
              urn: n.urn, displayName: n.displayName, entityType: n.entityType,
            }) as AncestorRef)]])
          } catch {
            forget([urn])
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(SINGLE_CONCURRENCY, single.length) }, worker))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, key])

  return known
}
