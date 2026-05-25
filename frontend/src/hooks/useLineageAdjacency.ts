/**
 * useLineageAdjacency — forward + backward adjacency maps over the
 * lineage subset of the edge set (containment edges filtered out).
 * Shared by `usePinnedLineagePath` (path computation) and
 * `usePinHopDistance` (hop tooltips) so both read identical adjacency
 * and benefit from one memoized build per edge change.
 */

import { useMemo } from 'react'
import { normalizeEdgeType } from '@/store/schema'
import type { LineageEdge } from '@/store/canvas'

export interface LineageAdjacency {
  fwd: Map<string, string[]>
  bwd: Map<string, string[]>
}

export function useLineageAdjacency(params: {
  edges: LineageEdge[]
  isContainmentEdge: (normalizedEdgeType: string) => boolean
}): LineageAdjacency {
  const { edges, isContainmentEdge } = params
  return useMemo(() => {
    const fwd = new Map<string, string[]>()
    const bwd = new Map<string, string[]>()
    for (const e of edges) {
      if (isContainmentEdge(normalizeEdgeType(e as any))) continue
      if (!fwd.has(e.source)) fwd.set(e.source, [])
      fwd.get(e.source)!.push(e.target)
      if (!bwd.has(e.target)) bwd.set(e.target, [])
      bwd.get(e.target)!.push(e.source)
    }
    return { fwd, bwd }
  }, [edges, isContainmentEdge])
}
