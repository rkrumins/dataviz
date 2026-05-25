/**
 * usePinnedLineagePath - isolate the sub-lineage between a trace focus and
 * one or more pinned nodes.
 *
 * A trace can return a 99-hop skeleton with thousands of nodes. "Pin
 * Lineage" lets the user pick the endpoints they actually care about; this
 * hook reduces the graph to exactly the nodes/edges that lie on a directed
 * lineage path between the trace focus and any pinned node.
 *
 * Everything needed is already in the canvas store (a node can only be
 * pinned once it is on screen, i.e. already part of the merged trace
 * result), so this is pure client-side graph traversal — no API call.
 *
 * Canvas invariant (useGraphHydration.toCanvasNode/Edge): a node's `id`
 * equals its URN and an edge's `source`/`target` are URNs. So pinned URNs,
 * the focus URN, node ids and edge endpoints are all the same key space.
 */

import { useMemo } from 'react'
import { normalizeEdgeType } from '@/store/schema'
import type { LineageEdge } from '@/store/canvas'
import { useLineageAdjacency, type LineageAdjacency } from './useLineageAdjacency'

/** Minimal edge shape the pure algorithm needs. */
export interface PathEdge {
  id: string
  source: string
  target: string
  /** True for containment/hierarchy edges (excluded from lineage paths). */
  isContainment: boolean
}

/**
 * Which orientation(s) of the focus↔pin path to keep:
 * - `'both'` (default): every directed route, in either orientation.
 * - `'downstream'`: only routes from focus to pin (pin is downstream).
 * - `'upstream'`: only routes from pin to focus (pin is upstream).
 */
export type PinPathDirection = 'both' | 'downstream' | 'upstream'

export interface PinnedPathInput {
  edges: PathEdge[]
  focusUrn: string | null
  pinnedUrns: string[]
  /** child urn -> parent urn (containment), for layout-ancestor retention. */
  containmentParent: Map<string, string>
  /** Optional pre-built lineage adjacency. When provided, the algorithm
   *  reuses it instead of iterating `edges` to rebuild — useful when the
   *  same adjacency is also feeding other hooks in the same render. */
  adjacency?: LineageAdjacency
  /** Path direction filter; defaults to `'both'` (original behavior). */
  direction?: PinPathDirection
}

export interface PinnedPathResult {
  /** Nodes lying on a directed lineage path between focus and a pin. */
  pathNodeUrns: Set<string>
  /** Lineage edge ids whose both endpoints are path nodes. */
  pathEdgeIds: Set<string>
  /**
   * Containment ancestors of path nodes. Not part of the lineage path but
   * must stay rendered so the layout engine can position the isolated
   * sub-lineage within its hierarchy.
   */
  keepForLayoutUrns: Set<string>
  /**
   * Pinned URNs that have no directed lineage route to/from the focus.
   * Force-added to pathNodeUrns so they stay visible, but flagged so the UI
   * can warn the user that the pin contributes nothing.
   */
  unreachablePinUrns: Set<string>
  /** True only when there is a focus AND at least one pin. */
  active: boolean
}

const EMPTY: PinnedPathResult = {
  pathNodeUrns: new Set(),
  pathEdgeIds: new Set(),
  keepForLayoutUrns: new Set(),
  unreachablePinUrns: new Set(),
  active: false,
}

/** BFS over an adjacency map, returning every reachable node (incl. start). */
function reachable(starts: Iterable<string>, adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>()
  const queue: string[] = []
  for (const s of starts) {
    if (!seen.has(s)) {
      seen.add(s)
      queue.push(s)
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string
    const next = adj.get(cur)
    if (!next) continue
    for (const n of next) {
      if (!seen.has(n)) {
        seen.add(n)
        queue.push(n)
      }
    }
  }
  return seen
}

/**
 * Pure path-isolation algorithm. Keeps every node on ANY directed lineage
 * route connecting focus and a pinned node, orientation-agnostic so it
 * works whether the pins are downstream OR upstream of the focus.
 */
export function computePinnedPath(input: PinnedPathInput): PinnedPathResult {
  const { edges, focusUrn, pinnedUrns, containmentParent, adjacency, direction = 'both' } = input
  if (!focusUrn || pinnedUrns.length === 0) return EMPTY

  let fwd: Map<string, string[]>
  let bwd: Map<string, string[]>
  if (adjacency) {
    fwd = adjacency.fwd
    bwd = adjacency.bwd
  } else {
    // Directed lineage adjacency (forward) + reverse adjacency (backward).
    fwd = new Map()
    bwd = new Map()
    for (const e of edges) {
      if (e.isContainment) continue
      if (!fwd.has(e.source)) fwd.set(e.source, [])
      fwd.get(e.source)!.push(e.target)
      if (!bwd.has(e.target)) bwd.set(e.target, [])
      bwd.get(e.target)!.push(e.source)
    }
  }

  const df = reachable([focusUrn], fwd) // focus → downstream
  const bf = reachable([focusUrn], bwd) // focus → upstream
  const dp = reachable(pinnedUrns, fwd) // pins  → downstream
  const bp = reachable(pinnedUrns, bwd) // pins  → upstream

  // STRICT path node set — nodes that genuinely lie on a directed
  // focus↔pin route under the current direction filter. Used to filter
  // path edges so an unreachable-in-direction pin doesn't "drag in" the
  // edge that connects it to focus in the WRONG orientation.
  //   'downstream' = routes leaving focus  → `df ∩ bp`
  //   'upstream'   = routes entering focus → `bf ∩ dp`
  //   'both'       = union of the two (default)
  const reachablePathNodes = new Set<string>()
  if (direction === 'both' || direction === 'downstream') {
    for (const u of df) if (bp.has(u)) reachablePathNodes.add(u)
  }
  if (direction === 'both' || direction === 'upstream') {
    for (const u of bf) if (dp.has(u)) reachablePathNodes.add(u)
  }
  reachablePathNodes.add(focusUrn)
  // A pin contributes to the strict path set only if reachable in the
  // current direction (so the canvas only highlights edges that actually
  // route through it).
  const directionReachable = (p: string): boolean => {
    if (p === focusUrn) return true
    const inDown = df.has(p)
    const inUp = bf.has(p)
    switch (direction) {
      case 'downstream': return inDown
      case 'upstream':   return inUp
      default:           return inDown || inUp
    }
  }
  for (const p of pinnedUrns) {
    if (directionReachable(p)) reachablePathNodes.add(p)
  }

  // DISPLAY path node set — strict set plus every pin (even unreachable
  // ones). Force-visible so the user can still see and unpin the chip's
  // target on the canvas; flagged separately in `unreachablePinUrns`.
  const pathNodeUrns = new Set(reachablePathNodes)
  for (const p of pinnedUrns) pathNodeUrns.add(p)

  const pathEdgeIds = new Set<string>()
  for (const e of edges) {
    if (e.isContainment) continue
    // Edge qualifies only when BOTH endpoints lie in the strict set —
    // never just because a force-visible unreachable pin happens to be
    // connected to a path node.
    if (reachablePathNodes.has(e.source) && reachablePathNodes.has(e.target)) {
      pathEdgeIds.add(e.id)
    }
  }

  // Retain containment ancestors of every path node so ELK can place the
  // isolated sub-lineage inside its hierarchy.
  const keepForLayoutUrns = new Set<string>()
  for (const node of pathNodeUrns) {
    let cur = containmentParent.get(node)
    while (cur && !pathNodeUrns.has(cur) && !keepForLayoutUrns.has(cur)) {
      keepForLayoutUrns.add(cur)
      cur = containmentParent.get(cur)
    }
  }

  // A pin is "unreachable" iff its presence contributes no nodes in the
  // current direction filter. With `'both'` that means neither orientation
  // works; with `'downstream'` the pin must be reachable forward from
  // focus; with `'upstream'` it must be reachable backward from focus.
  // This way the chip turns red the moment the user narrows direction
  // and a pin's orientation no longer qualifies.
  const unreachablePinUrns = new Set<string>()
  for (const p of pinnedUrns) {
    if (p === focusUrn) continue
    const inDown = df.has(p) // pin is downstream of focus
    const inUp = bf.has(p)   // pin is upstream of focus
    let reachableInDirection: boolean
    switch (direction) {
      case 'downstream': reachableInDirection = inDown; break
      case 'upstream':   reachableInDirection = inUp; break
      default:           reachableInDirection = inDown || inUp; break
    }
    if (!reachableInDirection) unreachablePinUrns.add(p)
  }

  return { pathNodeUrns, pathEdgeIds, keepForLayoutUrns, unreachablePinUrns, active: true }
}

/**
 * React adapter: maps canvas edges to the pure algorithm's shape (resolving
 * containment via the schema store's normalizeEdgeType + the view's
 * isContainmentEdge predicate) and memoizes on the inputs that matter.
 */
export function usePinnedLineagePath(params: {
  edges: LineageEdge[]
  isContainmentEdge: (normalizedEdgeType: string) => boolean
  focusUrn: string | null
  pinnedUrns: string[]
  containmentParent: Map<string, string>
  direction?: PinPathDirection
}): PinnedPathResult {
  const { edges, isContainmentEdge, focusUrn, pinnedUrns, containmentParent, direction = 'both' } = params
  // Shared with usePinHopDistance — one adjacency build per edge change.
  const adjacency = useLineageAdjacency({ edges, isContainmentEdge })
  return useMemo(() => {
    if (!focusUrn || pinnedUrns.length === 0) return EMPTY
    const pathEdges: PathEdge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      isContainment: isContainmentEdge(normalizeEdgeType(e as any)),
    }))
    return computePinnedPath({
      edges: pathEdges,
      focusUrn,
      pinnedUrns,
      containmentParent,
      adjacency,
      direction,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, focusUrn, pinnedUrns, containmentParent, isContainmentEdge, adjacency, direction])
}
