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
  /** Underlying connections this record stands for — always ≥1. An
   *  absorbed AGGREGATED rollup contributes its own edge count, so
   *  folding one away can never understate. A floor, never a total. */
  bundledCount: number
  /** Relationship types folded into this record beyond `edgeTypeNorm`
   *  (today: the synthetic rollup). Shown as secondary chips. */
  alsoTypes: string[]
  /** This connection is (or absorbed) a coarse rollup of finer flows.
   *  Survives the fold, so the rollup styling and counts don't vanish
   *  along with the edge that carried the flag. */
  aggregated: boolean
  /** The absorbed rollup edge itself, kept because it — not the concrete
   *  edge — is what the server can drill into its underlying
   *  connections. Undefined when nothing was absorbed. */
  rollupEdge: LineageEdge | undefined
}

/**
 * The platform's synthetic rollup relationship. It is declared
 * `is_lineage` in the system ontology and injected into every ontology,
 * so it arrives in `lineageEdgeTypes` and reads as an ordinary business
 * relationship — but it is materialized by the aggregation job, never
 * authored, and the backend happily returns it ALONGSIDE the raw edge
 * for the same pair (it dedupes by relationship id, never by pair).
 * Left alone, that renders one card per edge type for one connection.
 */
const ROLLUP_EDGE_TYPE = 'AGGREGATED'

/** Shared empty array — records that absorbed nothing share one. */
const EMPTY_TYPES: string[] = []

/** How many underlying connections one edge stands for (floor, ≥1). */
const edgeWeight = (e: LineageEdge): number => {
  const d = e.data as { isAggregated?: boolean; sourceEdgeCount?: number; edgeCount?: number } | undefined
  if (!d?.isAggregated) return 1
  return Math.max(d.sourceEdgeCount ?? d.edgeCount ?? 1, 1)
}

/**
 * One card per CONNECTION, not per edge.
 *
 * Two collapses, in order:
 *   1. Exact repeats — the same (neighbour, relationship) arriving as
 *      two edge ids (store + projection, or two hydration passes).
 *   2. The synthetic rollup — an AGGREGATED edge folds into the concrete
 *      relationship to the same neighbour, carrying its weight so the
 *      count never drops. Genuinely different business relationships
 *      keep their own record; and a rollup with no concrete sibling is
 *      kept as-is, because between coarse entities it is often the ONLY
 *      evidence that a connection exists.
 */
function collapseRecords(
  records: NeighborRecord[],
  grain?: GrainContext,
): NeighborRecord[] {
  if (records.length < 2) return records

  // 1. Exact repeats, insertion order preserved. These are ONE
  //    connection arriving twice (the store and the projection both
  //    carry it), so the weight is the larger of the two — summing
  //    would report a duplicate as extra lineage.
  const byKey = new Map<string, NeighborRecord>()
  for (const r of records) {
    const key = `${r.neighborId}\u0000${r.edgeTypeNorm}`
    const seen = byKey.get(key)
    if (seen) {
      seen.bundledCount = Math.max(seen.bundledCount, r.bundledCount)
      if (r.aggregated) seen.aggregated = true
      seen.rollupEdge ??= r.rollupEdge
    } else byKey.set(key, r)
  }

  // 2. Rollups fold into a concrete sibling for the same neighbour.
  const concreteByNeighbor = new Map<string, NeighborRecord>()
  for (const r of byKey.values()) {
    if (r.edgeTypeNorm === ROLLUP_EDGE_TYPE) continue
    const best = concreteByNeighbor.get(r.neighborId)
    if (!best
      || r.bundledCount > best.bundledCount
      || (r.bundledCount === best.bundledCount && r.edgeTypeNorm < best.edgeTypeNorm)
    ) concreteByNeighbor.set(r.neighborId, r)
  }
  const out: NeighborRecord[] = []
  for (const r of byKey.values()) {
    if (r.edgeTypeNorm !== ROLLUP_EDGE_TYPE) { out.push(r); continue }
    // Absorbed by exactly ONE concrete record — spreading it would
    // count the same underlying flows more than once. The rollup
    // summarises ALL flows to that neighbour, so it attaches to the
    // record already standing for the most of them (ties by type name,
    // so the output is stable across hydration orders).
    const host = concreteByNeighbor.get(r.neighborId)
    if (!host) {
      // 3. A rollup to a COARSER partner than the focal, while a concrete
      //    record exists in this direction, is the same flow restated one
      //    grain up — the aggregation worker materialises a cell at every
      //    level above the real one. Listing them as peers showed ONE flow
      //    four times: the partner field, its dataset, its container and
      //    its platform, which is the "5 in / 4 out on a column with two
      //    real neighbours" the closure strips server-side.
      //
      //    Dropped only when something concrete is there to stand for the
      //    flow. Between coarse entities a rollup is often the ONLY
      //    evidence a connection exists, and that case is kept.
      if (grain && concreteByNeighbor.size > 0
        && isCoarserGrain(grain.closure, r.neighborNode?.data?.type as string | undefined, grain.focalType)) {
        continue
      }
      out.push(r)
      continue
    }
    // max, not sum: the rollup is evidence ABOUT the same flows the
    // concrete edge stands for, not additional flows.
    host.bundledCount = Math.max(host.bundledCount, r.bundledCount)
    host.aggregated = true
    host.rollupEdge ??= r.edge
    if (!host.alsoTypes.includes(r.edgeTypeNorm)) host.alsoTypes = [...host.alsoTypes, r.edgeTypeNorm]
  }
  return out
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

/** What the caller knows about grain, so a rollup can be recognised as a
 *  coarser restatement of a flow already represented. Optional: without it
 *  the derivation behaves exactly as it did. */
export interface GrainContext {
  /** From {@link buildCanContainClosure}. */
  closure: Map<string, Set<string>>
  /** The focal entity's own type. */
  focalType: string
}

export function deriveNeighborRecords(
  nodeId: string,
  edges: LineageEdge[],
  nodeMap: Map<string, LineageNode>,
  containmentEdgeTypes: string[],
  grain?: GrainContext,
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
      bundledCount: edgeWeight(e),
      alsoTypes: EMPTY_TYPES,
      aggregated: !!(e.data as { isAggregated?: boolean } | undefined)?.isAggregated,
      rollupEdge: undefined,
    }
    if (isIn) incoming.push(record)
    else outgoing.push(record)
  }
  // Collapsed per direction: the same entity legitimately appears on
  // both sides of a focal, and those are two different connections.
  return {
    incomingRecords: collapseRecords(incoming, grain),
    outgoingRecords: collapseRecords(outgoing, grain),
  }
}
