/**
 * usePinHopDistance — shortest lineage-hop distance from a trace focus to
 * every reachable URN. Powers the "{label} · N hops from focus" tooltip
 * in the pin chip lists across all three canvases.
 *
 * Algorithm: BFS in each direction over the lineage adjacency (skipping
 * containment edges, same predicate used by `usePinnedLineagePath`), then
 * `min(forward, reverse)` per URN — orientation-agnostic so it works for
 * pins downstream OR upstream of the focus.
 *
 * O(V+E), memoized on `(edges, focusUrn, isContainmentEdge)`. Returns an
 * empty map when there's no focus.
 */

import { useMemo } from 'react'
import { normalizeEdgeType } from '@/store/schema'
import type { LineageEdge } from '@/store/canvas'

export function usePinHopDistance(params: {
  edges: LineageEdge[]
  isContainmentEdge: (normalizedEdgeType: string) => boolean
  focusUrn: string | null
}): Map<string, number> {
  const { edges, isContainmentEdge, focusUrn } = params
  return useMemo(() => {
    const m = new Map<string, number>()
    if (!focusUrn) return m

    const fwd = new Map<string, string[]>()
    const bwd = new Map<string, string[]>()
    for (const e of edges) {
      if (isContainmentEdge(normalizeEdgeType(e as any))) continue
      if (!fwd.has(e.source)) fwd.set(e.source, [])
      fwd.get(e.source)!.push(e.target)
      if (!bwd.has(e.target)) bwd.set(e.target, [])
      bwd.get(e.target)!.push(e.source)
    }

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

    const df = bfs(fwd)
    const db = bfs(bwd)
    const seen = new Set<string>([...df.keys(), ...db.keys()])
    for (const u of seen) {
      const a = df.get(u) ?? Infinity
      const b = db.get(u) ?? Infinity
      m.set(u, Math.min(a, b))
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, focusUrn, isContainmentEdge])
}
