/**
 * usePlacementChains — the containment chains of loaded entities whose parent the canvas has not
 * loaded, for the One Placement Contract (lib/placement): with them, a hand placement on an ancestor
 * the canvas never loaded still cascades down to the entity (see placeCanvasNodes). Flag-on only —
 * the canvas hands it no URNs otherwise.
 *
 * URNs only, no names. Batched through the provider's bulk chain lookup, CHUNK URNs per request and
 * CONCURRENCY requests at a time. Each URN is asked once; one the provider could not answer is asked
 * again on the next change. A reader without the containment walk (501) is not asked again. A new
 * provider is a new graph, so everything is forgotten.
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

export function usePlacementChains(urns: readonly string[]): Chains {
  const provider = useGraphProvider()
  // Keyed by the provider it was answered for, so a switch never shows the old graph's chains.
  const [known, setKnown] = useState<{ provider: GraphDataProvider | null; chains: Chains }>({ provider: null, chains: NONE })
  const providerRef = useRef<GraphDataProvider | null>(null)
  const askedRef = useRef(new Set<string>())
  const unsupportedRef = useRef(false)

  useEffect(() => {
    if (providerRef.current !== provider) {
      providerRef.current = provider
      askedRef.current = new Set()
      unsupportedRef.current = false
    }
    if (unsupportedRef.current || typeof provider.getAncestorChains !== 'function') return
    const asked = askedRef.current
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
            else asked.delete(urn)                             // unknown: asked again later
          }
        } else if ((result.reason as { status?: number } | undefined)?.status === 501) {
          unsupportedRef.current = true                        // no containment walk on this reader
        } else {
          chunks[i].forEach(urn => asked.delete(urn))
        }
      })
      if (found.size === 0) return
      setKnown(prev => ({
        provider,
        chains: new Map([...(prev.provider === provider ? prev.chains : NONE), ...found]),
      }))
    })
  }, [provider, urns])

  return known.provider === provider ? known.chains : NONE
}
