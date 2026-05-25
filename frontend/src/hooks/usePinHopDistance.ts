/**
 * usePinHopDistance — shortest lineage-hop distance from a trace focus to
 * every reachable URN. Powers the "{label} · N hops from focus" tooltip
 * in the pin chip lists across all three canvases.
 *
 * Algorithm: BFS in each direction over the lineage adjacency, then
 * `min(forward, reverse)` per URN — orientation-agnostic so it works for
 * pins downstream OR upstream of the focus.
 *
 * O(V+E), memoized on `(adjacency, focusUrn, skip)`. Returns an empty
 * map when there's no focus, or when `skip` is true (no pins → no chip
 * needs hop info, so don't pay for the BFS).
 */

import { useMemo } from 'react'
import { useLineageAdjacency, type LineageAdjacency } from './useLineageAdjacency'
import type { LineageEdge } from '@/store/canvas'

export function usePinHopDistance(params: {
  edges: LineageEdge[]
  isContainmentEdge: (normalizedEdgeType: string) => boolean
  focusUrn: string | null
  /** When true, skip the BFS entirely and return an empty map. Caller
   *  passes `pinnedTargetUrns.length === 0` — there are no chips that
   *  need a hop tooltip, so the work would be wasted. */
  skip?: boolean
}): Map<string, number> {
  const { edges, isContainmentEdge, focusUrn, skip = false } = params
  const adjacency: LineageAdjacency = useLineageAdjacency({ edges, isContainmentEdge })
  return useMemo(() => {
    const m = new Map<string, number>()
    if (skip || !focusUrn) return m

    const bfs = (adj: Map<string, string[]>): Map<string, number> => {
      const dist = new Map<string, number>([[focusUrn, 0]])
      const queue: string[] = [focusUrn]
      while (queue.length) {
        const cur = queue.shift()!
        const d = dist.get(cur)!
        for (const next of adj.get(cur) ?? []) {
          if (!dist.has(next)) { dist.set(next, d + 1); queue.push(next) }
        }
      }
      return dist
    }

    const df = bfs(adjacency.fwd)
    const db = bfs(adjacency.bwd)
    const seen = new Set<string>([...df.keys(), ...db.keys()])
    for (const u of seen) {
      const a = df.get(u) ?? Infinity
      const b = db.get(u) ?? Infinity
      m.set(u, Math.min(a, b))
    }
    return m
  }, [adjacency, focusUrn, skip])
}
