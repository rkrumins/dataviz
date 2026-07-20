/**
 * Shared 1-hop lineage neighbor derivation.
 *
 * Consumed by BOTH the EntityDrawer's LineageNeighbors section and the
 * canvas Lineage Lens so their counts and groupings always agree. Data
 * contract mirrors the canvas: pass `visibleEdges` (the projected /
 * aggregated set the canvas renders) when non-empty, raw `edges`
 * otherwise; containment edges are excluded — this is flow lineage.
 */
import type { LineageNode, LineageEdge } from '@/store/canvas'
import { normalizeEdgeType, isContainmentEdgeType } from '@/store/schema'

export type NeighborDirection = 'incoming' | 'outgoing'

export interface NeighborRecord {
  edge: LineageEdge
  neighborId: string
  neighborNode: LineageNode | undefined
  direction: NeighborDirection
  edgeTypeNorm: string
}

/**
 * Merge on-demand fetched edges into the store-derived base set. A
 * fetched edge is redundant — and skipped — when the store already
 * represents that connection: identical id, identical (source, target,
 * edgeType) pair, or rolled up into an aggregate that SHARES AN
 * ENDPOINT with it (the aggregate row shows it at coarser granularity).
 * An aggregate between two OTHER nodes does not cover it — that's
 * exactly the invisible-lineage case the merge exists to fix.
 *
 * Shared by the Lineage Lens and the entity drawer so both surfaces
 * always agree about what the data source contains.
 */
export function mergeSupplementalEdges(
  base: LineageEdge[],
  supplemental: LineageEdge[],
): LineageEdge[] {
  if (supplemental.length === 0) return base
  const seenIds = new Set<string>()
  const seenPairs = new Set<string>()
  const coveringAggregates = new Map<string, Array<{ s: string; t: string }>>()
  const pairKey = (e: LineageEdge) => `${e.source}\u0000${e.target}\u0000${(e.data?.edgeType as string) ?? ''}`
  for (const e of base) {
    seenIds.add(e.id)
    seenPairs.add(pairKey(e))
    for (const rid of e.data?.sourceEdges ?? []) {
      const list = coveringAggregates.get(rid) ?? []
      list.push({ s: e.source, t: e.target })
      coveringAggregates.set(rid, list)
    }
  }
  const merged = [...base]
  for (const e of supplemental) {
    if (seenIds.has(e.id) || seenPairs.has(pairKey(e))) continue
    const covers = coveringAggregates.get(e.id)
    if (covers?.some(({ s, t }) => s === e.source || t === e.source || s === e.target || t === e.target)) continue
    merged.push(e)
  }
  return merged
}

/**
 * Transitive canContain closure over the schema's entity-type
 * hierarchy: closure(T) = every type T can (transitively) contain,
 * upper-cased. Feeds isCoarserGrain — shared by the Lens and the
 * drawer so their "rolled-up" counts always agree.
 */
export function buildCanContainClosure(
  hierarchyMap: Record<string, { canContain: string[] }>,
): Map<string, Set<string>> {
  const closure = new Map<string, Set<string>>()
  for (const [t, h] of Object.entries(hierarchyMap)) {
    const seen = new Set<string>()
    const stack = [...h.canContain]
    while (stack.length > 0) {
      const c = stack.pop()!
      const cu = c.toUpperCase()
      if (seen.has(cu)) continue
      seen.add(cu)
      for (const g of hierarchyMap[c]?.canContain ?? []) stack.push(g)
    }
    closure.set(t.toUpperCase(), seen)
  }
  return closure
}

/** A partner is a COARSER-grain rollup relative to a base node when the
 *  partner's type can (transitively) contain the base's type. */
export function isCoarserGrain(
  closure: Map<string, Set<string>>,
  partnerType: string | undefined,
  baseType: string,
): boolean {
  if (!partnerType) return false
  return closure.get(partnerType.toUpperCase())?.has(baseType.toUpperCase()) ?? false
}

export function deriveNeighborRecords(
  nodeId: string,
  edges: LineageEdge[],
  nodeMap: Map<string, LineageNode>,
  containmentEdgeTypes: string[],
): { incomingRecords: NeighborRecord[]; outgoingRecords: NeighborRecord[] } {
  const incoming: NeighborRecord[] = []
  const outgoing: NeighborRecord[] = []
  for (const e of edges) {
    const isIn = e.target === nodeId && e.source !== nodeId
    const isOut = e.source === nodeId && e.target !== nodeId
    if (!isIn && !isOut) continue
    const edgeTypeNorm = normalizeEdgeType(e)
    if (isContainmentEdgeType(edgeTypeNorm, containmentEdgeTypes)) continue
    const record: NeighborRecord = {
      edge: e,
      neighborId: isIn ? e.source : e.target,
      neighborNode: nodeMap.get(isIn ? e.source : e.target),
      direction: isIn ? 'incoming' : 'outgoing',
      edgeTypeNorm,
    }
    if (isIn) incoming.push(record)
    else outgoing.push(record)
  }
  return { incomingRecords: incoming, outgoingRecords: outgoing }
}
