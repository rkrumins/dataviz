/**
 * useAncestorChains — where the canvas's UNLOADED lineage endpoints live.
 *
 * A lineage edge arrives naming both of its ends, but the canvas only loads
 * what the reader has opened. An end it never loaded — a partner inside a
 * collapsed container — cannot be drawn to, so the edge projection counted
 * the flow "outside this view" even when that partner sat inside a
 * container on screen. Measured live: 909 of 998 loaded lineage edges.
 *
 * This asks the server for each such end's containment chain (parent first,
 * root last; URNs only — nothing is loaded, no row appears) so the
 * projection can roll the line up to the nearest container the reader CAN
 * see: the roll-up an expanded tree already gets, and what materialized
 * AGGREGATED edges give a source whose aggregation has run.
 *
 * Contract (as useExternalDegrees): a URN absent from the map is UNKNOWN
 * and resolves nothing. A failed chunk is re-queued for the next settle; a
 * provider that cannot answer at all (501) is not asked again.
 */
import { useEffect, useRef, useState } from 'react'

import { useGraphProvider } from '@/providers'
import { useCanvasStore, useCanvasVersion } from '@/store/canvas'
import { normalizeEdgeType } from '@/store/schema'

const CHUNK_SIZE = 500
/** Shorter than the degree cue's settle: this one decides whether a line is
 *  drawn at all, not a badge beside it. */
const SETTLE_MS = 300

const NO_CHAINS: ReadonlyMap<string, readonly string[]> = new Map()

export function useAncestorChains(
  enabled: boolean,
  isContainmentEdge: (edgeType: string) => boolean,
): ReadonlyMap<string, readonly string[]> {
  const provider = useGraphProvider()
  const canvasVersion = useCanvasVersion()
  const [chains, setChains] = useState<ReadonlyMap<string, readonly string[]>>(NO_CHAINS)
  // Asked for (or answered): never asked again. Cleared per URN on failure.
  const askedRef = useRef<Set<string>>(new Set())
  const unsupportedRef = useRef(false)
  // Bumped on a provider switch. A chain is a fact about ONE graph: an
  // answer that lands after the switch is dropped, and nothing else is —
  // a settle that re-runs mid-request must not throw away what the
  // request brings back, or those URNs, already marked asked, are lost.
  const generationRef = useRef(0)

  // Provider switch — every chain belongs to another graph.
  useEffect(() => {
    generationRef.current += 1
    askedRef.current = new Set()
    unsupportedRef.current = false
    const raf = requestAnimationFrame(() => setChains(NO_CHAINS))
    return () => cancelAnimationFrame(raf)
  }, [provider])

  useEffect(() => {
    if (!enabled || unsupportedRef.current) return
    if (typeof provider.getAncestorChains !== 'function') return
    const timer = setTimeout(async () => {
      const generation = generationRef.current
      const { nodes, edges } = useCanvasStore.getState()
      const loaded = new Set(nodes.map(n => n.id))
      const wanted = new Set<string>()
      for (const edge of edges) {
        if (isContainmentEdge(normalizeEdgeType(edge))) continue
        for (const end of [edge.source, edge.target]) {
          if (!loaded.has(end) && !askedRef.current.has(end) && !end.startsWith('logical:')) wanted.add(end)
        }
      }
      if (wanted.size === 0) return
      const urns = [...wanted]
      urns.forEach(u => askedRef.current.add(u))
      for (let i = 0; i < urns.length; i += CHUNK_SIZE) {
        const chunk = urns.slice(i, i + CHUNK_SIZE)
        try {
          const res = await provider.getAncestorChains!(chunk)
          if (generation !== generationRef.current) return
          setChains(prev => {
            const next = new Map(prev)
            for (const [urn, chain] of Object.entries(res)) next.set(urn, chain)
            return next
          })
        } catch (err) {
          if (generation !== generationRef.current) return
          if ((err as { status?: number }).status === 501) {
            // This reader has no containment walk (a draft on a stale
            // projection): nothing to gain from asking every settle.
            unsupportedRef.current = true
            return
          }
          // Unknown, not rootless — re-queue the chunk for the next settle.
          chunk.forEach(u => askedRef.current.delete(u))
        }
      }
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [enabled, provider, canvasVersion, isContainmentEdge])

  return chains
}
