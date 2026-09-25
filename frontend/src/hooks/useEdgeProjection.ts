/**
 * useEdgeProjection - Extracted from ReferenceModelCanvas.tsx
 *
 * Encapsulates:
 * - lineageEdges: aggregated + expanded detailed + trace/regular edges
 * - visibleLineageEdges: edge projection/roll-up to visible ancestors
 *
 * Phase 5.1: ancestorMap is built incrementally — on expand/collapse only
 * the changed subtree is patched, avoiding a full O(N) traversal on every
 * user interaction. Full rebuild only happens when nodesByLayer changes
 * (layer re-assignment, initial load).
 */

import { useMemo, useRef } from 'react'
import type { AggregatedEdgeInfo } from '@/providers/GraphDataProvider'
import { normalizeEdgeType } from '@/store/schema'
import type { HierarchyNode } from '@/types/hierarchy'
import { NO_PLACE_FOUND } from './useAncestorChains'

// ============================================
// Types
// ============================================

export interface UseEdgeProjectionOptions {
  edges: any[]
  aggregatedEdges: Map<string, any>
  nodesByLayer: Map<string, HierarchyNode[]>
  expandedNodes: Set<string>
  displayFlat: HierarchyNode[]
  displayMap: Map<string, HierarchyNode>
  urnToIdMap: Map<string, string>
  showLineageFlow: boolean
  isTracing: boolean
  traceContextSet: Set<string>
  isContainmentEdge: (edgeType: string) => boolean
  /**
   * URN-pair keys (`${sourceUrn}->${targetUrn}`) for parent AGGREGATED edges
   * that have been drilled into and currently have at least one finer-level
   * edge visible. Suppresses the parent AGG so the canvas doesn't render the
   * same lineage twice (rolled-up + detailed). Restored automatically when
   * either endpoint is collapsed. Only consulted in trace mode.
   */
  suppressedAggEdgeKeys?: Set<string>
  /**
   * Edge ids the trace explicitly merged into the canvas store (from
   * `trace.addedEdgeIds`). When in trace mode, these bypass the
   * `traceContextSet` gate: by construction they belong to the trace and
   * must render even if one endpoint hasn't yet been routed into the
   * trace-filtered hierarchy. Endpoint resolution via displayMap/ancestorMap
   * still applies — edges to entirely-unresolved nodes are still dropped.
   */
  traceAddedEdgeIds?: ReadonlySet<string>
  /**
   * Canvas containment parent map (child id → parent id) from
   * useContainmentHierarchy. Used by the trace-mode bundling projection
   * to walk leaf-level edge endpoints up to the focus's hierarchy level so
   * thousands of column-to-column edges collapse into a handful of
   * container-to-container bundles.
   */
  traceBundleParentMap?: Map<string, string>
  /** entityType → hierarchy.level map. Required for traceFocusLevel-based bundling. */
  entityTypeLevels?: Map<string, number>
  /**
   * Hierarchy level the active trace ran at (`result.effectiveLevel`). When
   * set with `traceBundleParentMap` + `entityTypeLevels`, edges whose
   * endpoints are at a finer level get projected UP to the closest
   * ancestor that sits at this level — visualising as bundled rollups
   * rather than per-leaf spaghetti.
   */
  traceFocusLevel?: number
  /**
   * Canvas containment parent map (child id → parent id) in browse mode.
   * Delegation reads it to tell when an open container's line is covered by
   * its children's lines.
   */
  browseBundleParentMap?: Map<string, string>
  /**
   * nodeId → layer index map (Source=0, Staging=1, …). When provided,
   * each projected edge gets `isReverseFlow` set true if the target's
   * layer index is strictly less than the source's. Used by the
   * renderer to route reverse-flow edges through a dedicated lane.
   */
  nodeLayerIndexMap?: Map<string, number>
  /**
   * UPPERCASE type keys the user has hidden for this view. Applied per
   * GROUP MEMBER in Finalize, so a bundle whose members all carry only
   * hidden types disappears and a mixed bundle keeps a reduced edgeCount.
   */
  hiddenEdgeTypes?: ReadonlySet<string>
  /**
   * Containment chains (parent first, root last) for lineage endpoints the
   * canvas never loaded — useAncestorChains. An endpoint that resolves to
   * nothing on canvas is filed under the nearest ancestor that does, so its
   * line rolls up to the container the reader can see instead of being
   * counted as leading outside the view. Consulted only when the endpoint
   * itself does not resolve. A URN missing from a map that IS given is
   * pending: its place is still being asked, so it makes no stub and is not
   * counted. One published as NO_PLACE_FOUND is unknown, the same way, for
   * good. With no map at all there is no chain source, and such an end
   * leads outside.
   */
  ancestorChains?: ReadonlyMap<string, readonly string[]>
  /**
   * Each promoted anchor's URN → the column it is drawn as
   * (useLayerAssignment). The anchor is never a row, so lineage naming it,
   * or reaching it on a chain, is lineage into that column: in the view.
   */
  promotedAnchors?: ReadonlyMap<string, string>
  /**
   * Roll-ups between a row and a HOLDER, asked on their own
   * (useHolderRollups): an anchor with rows past its loaded page, or an open
   * container with children not loaded yet. Section A keeps of each only
   * what the loaded rows under the holder do not carry.
   */
  holderEdges?: ReadonlyMap<string, AggregatedEdgeInfo>
}

// ============================================
// Tree helpers for incremental ancestorMap updates
// ============================================

/** Build a flat id→node lookup from the full tree. O(N) once, then O(1) per lookup. */
function buildNodeIndex(nodesByLayer: Map<string, HierarchyNode[]>): Map<string, HierarchyNode> {
  const index = new Map<string, HierarchyNode>()
  const stack: HierarchyNode[] = []
  nodesByLayer.forEach(roots => { for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]) })
  while (stack.length > 0) {
    const node = stack.pop()!
    index.set(node.id, node)
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
  }
  return index
}

/** Map a node and all its descendants to `anchor` in the given map. Iterative. */
function collapseSubtreeInMap(root: HierarchyNode, anchor: string, map: Map<string, string>) {
  const stack: HierarchyNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.urn) map.set(node.urn, anchor)
    map.set(node.id, anchor)
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
  }
}

/**
 * When `node` is expanded, each direct child becomes visible and maps to
 * itself. If a child is already expanded, process its children too.
 * If a child is collapsed, all its descendants roll up to it. Iterative.
 */
function expandNodeInMap(node: HierarchyNode, expandedNodes: Set<string>, map: Map<string, string>) {
  const stack: HierarchyNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const child of current.children) {
      if (child.urn) map.set(child.urn, child.id)
      map.set(child.id, child.id)
      if (expandedNodes.has(child.id)) {
        stack.push(child)
      } else {
        for (const gc of child.children) collapseSubtreeInMap(gc, child.id, map)
      }
    }
  }
}

/** Full O(N) build. Called on initial load and whenever nodesByLayer changes. Iterative. */
function buildFullAncestorMap(
  nodesByLayer: Map<string, HierarchyNode[]>,
  expandedNodes: Set<string>,
  displayFlat: HierarchyNode[],
): Map<string, string> {
  const map = new Map<string, string>()

  const stack: Array<{ node: HierarchyNode; anchor: string }> = []
  nodesByLayer.forEach(roots => {
    for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], anchor: roots[i].id })
  })

  while (stack.length > 0) {
    const { node, anchor } = stack.pop()!
    if (node.urn) map.set(node.urn, anchor)
    map.set(node.id, anchor)

    let childAnchor = anchor
    if (node.id === anchor) {
      childAnchor = expandedNodes.has(node.id) ? 'USE_CHILD_ID' : node.id
    }

    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]
      stack.push({ node: child, anchor: childAnchor === 'USE_CHILD_ID' ? child.id : childAnchor })
    }
  }

  // Safety pass: visible nodes always map to themselves
  displayFlat.forEach(node => {
    if (!map.has(node.id)) map.set(node.id, node.id)
    if (node.urn && !map.has(node.urn)) map.set(node.urn, node.id)
  })

  return map
}

/**
 * Lineage from a row ON the canvas whose far end is not drawn. Per direction,
 * as seen from the row — `in` flows arrive at it, `out` flows leave it —
 * counted in UNDERLYING flows (a roll-up edge contributes every flow it
 * stands for, as it does on a line), with the far ends (capped) so a click
 * can bring them in.
 */
export interface OffCanvasFlows {
  in: number
  out: number
  inPartners: ReadonlySet<string>
  outPartners: ReadonlySet<string>
}

/**
 * `in`/`out` are the flows that truly LEAVE the view. `columns` holds, per
 * layer id, the flows into an anchored column that are not drawn yet: a row
 * of it past its loaded page, or its anchor, which has no partner to bring
 * in because it is drawn as the column. Those are in the view, never a stub.
 * `unplaced` counts the flows whose far end has no known place: still being
 * asked (pending), or never found (unknown). Neither in the view nor out of
 * it as far as anyone can tell, so never a stub, and never a hollow port.
 */
export interface OffCanvasLineage extends OffCanvasFlows {
  columns: ReadonlyMap<string, OffCanvasFlows>
  unplaced: { readonly in: number; readonly out: number }
}

/** Where one end of a line lands (see `place` in the projection). */
type Place =
  | { at: 'row'; id: string }
  | { at: 'column'; layerId: string }
  | { at: 'outside' }
  | { at: 'pending' }
  | { at: 'unknown' }

const OUTSIDE: Place = { at: 'outside' }
const PENDING: Place = { at: 'pending' }
const UNKNOWN: Place = { at: 'unknown' }

type MutableFlows = { in: number; out: number; inPartners: Set<string>; outPartners: Set<string> }
const noFlows = (): MutableFlows => ({ in: 0, out: 0, inPartners: new Set(), outPartners: new Set() })

/** Far ends kept per row and direction — enough for a click to bring in a
 *  first batch; the counts stay exact beyond it. */
const OFF_CANVAS_PARTNER_CAP = 500

const NO_OFF_CANVAS: ReadonlyMap<string, OffCanvasLineage> = new Map()

// ============================================
// Hook
// ============================================

export function useEdgeProjection({
  edges,
  aggregatedEdges,
  nodesByLayer,
  expandedNodes,
  displayFlat,
  displayMap,
  urnToIdMap,
  showLineageFlow,
  isTracing,
  traceContextSet,
  isContainmentEdge,
  suppressedAggEdgeKeys,
  traceAddedEdgeIds,
  traceBundleParentMap,
  entityTypeLevels,
  traceFocusLevel,
  browseBundleParentMap,
  nodeLayerIndexMap,
  hiddenEdgeTypes,
  ancestorChains,
  promotedAnchors,
  holderEdges,
}: UseEdgeProjectionOptions): { lineageEdges: any[], visibleLineageEdges: any[], unresolvedEdgeCount: number, unresolvedAggregatedCount: number, hiddenInsideCollapsedCount: number, offCanvasByNode: ReadonlyMap<string, OffCanvasLineage> } {

  // Throttle for the dev-facing console warning about dropped edges. The
  // user-facing count itself is returned from the projection memo (no ref —
  // it is render data).
  const lastWarnAtRef = useRef(0)

  // ── Flat node index — O(1) lookup replacing O(N) tree search ──────────
  const nodeIndex = useMemo(() => buildNodeIndex(nodesByLayer), [nodesByLayer])

  // ── Incremental ancestorMap state ──────────────────────────────────────
  const ancestorMapRef = useRef<Map<string, string>>(new Map())
  const prevNodesByLayerRef = useRef<Map<string, HierarchyNode[]> | null>(null)
  const prevExpandedNodesRef = useRef<Set<string>>(new Set())

  // ── lineageEdges ───────────────────────────────────────────────────────
  // Flow is the master switch for edge rendering. Trace mode keeps its node
  // highlights and side panels but respects Flow off — the canvas stays clean
  // when the user wants to inspect a trace path without ambient mesh noise.
  const lineageEdges = useMemo(() => {
    if (!showLineageFlow) return []

    // 1. Aggregated Edges
    const aggEdges = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'collapsed')
      .map(e => ({
        id: e.aggregated.id,
        source: e.aggregated.sourceUrn,
        target: e.aggregated.targetUrn,
        data: {
          edgeType: 'AGGREGATED',
          relationship: 'aggregated',
          isAggregated: true,
          edgeCount: e.aggregated.edgeCount,
          edgeTypes: e.aggregated.edgeTypes,
          confidence: e.aggregated.confidence,
        }
      }))

    // 2. Expanded Detailed Edges
    const expandedDetailedEdges = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges
        .filter((de: any) => !isContainmentEdge(de.edgeType))
        .map((de: any) => ({
          id: de.id,
          source: de.sourceUrn,
          target: de.targetUrn,
          data: {
            edgeType: de.edgeType,
            relationship: de.edgeType,
            confidence: de.confidence,
          }
        })))

    // 3. Regular canvas edges — performance guard: only include edges where
    // at least one endpoint is in displayMap.
    const regularEdges = edges.filter(edge => {
      if (isContainmentEdge(normalizeEdgeType(edge))) return false
      return displayMap.has(edge.source) || displayMap.has(edge.target)
    })

    return [...aggEdges, ...expandedDetailedEdges, ...regularEdges]
  }, [edges, showLineageFlow, aggregatedEdges, isContainmentEdge, displayMap])

  // ── ancestorMap (Phase 5.1 — incremental) ─────────────────────────────
  //
  // Full rebuild: when nodesByLayer reference changes (layer re-assignment,
  // initial data load). This is infrequent.
  //
  // Incremental patch: when only expandedNodes changes (user expands /
  // collapses a tree node). We diff the previous/current Set and only
  // traverse the affected subtrees — O(subtree) instead of O(N).
  const ancestorMap = useMemo(() => {
    const needsFullRebuild = prevNodesByLayerRef.current !== nodesByLayer

    if (needsFullRebuild) {
      const map = buildFullAncestorMap(nodesByLayer, expandedNodes, displayFlat)
      prevNodesByLayerRef.current = nodesByLayer
      prevExpandedNodesRef.current = expandedNodes
      ancestorMapRef.current = map
      return map
    }

    // Same nodesByLayer — check if expandedNodes changed
    const prev = prevExpandedNodesRef.current
    if (prev === expandedNodes) {
      return ancestorMapRef.current
    }

    // Diff
    const expanded: string[] = []
    const collapsed: string[] = []
    expandedNodes.forEach(id => { if (!prev.has(id)) expanded.push(id) })
    prev.forEach(id => { if (!expandedNodes.has(id)) collapsed.push(id) })

    if (expanded.length === 0 && collapsed.length === 0) {
      prevExpandedNodesRef.current = expandedNodes
      return ancestorMapRef.current
    }

    // Shallow copy then patch only changed subtrees
    const map = new Map(ancestorMapRef.current)

    // Collapses first: all descendants → collapsed node
    collapsed.forEach(id => {
      const node = nodeIndex.get(id)
      if (node) {
        node.children.forEach(child => collapseSubtreeInMap(child, id, map))
      }
    })

    // Expansions: children become individually visible
    expanded.forEach(id => {
      const node = nodeIndex.get(id)
      if (node) {
        expandNodeInMap(node, expandedNodes, map)
      }
    })

    prevExpandedNodesRef.current = expandedNodes
    ancestorMapRef.current = map
    return map
  }, [nodesByLayer, expandedNodes, displayFlat, nodeIndex])

  // How many children each container has LOADED: in the store, wherever they
  // are drawn. A child placed in another column is loaded all the same.
  const loadedChildCounts = useMemo(() => {
    const counts = new Map<string, number>()
    ;(browseBundleParentMap ?? traceBundleParentMap)?.forEach(parent => counts.set(parent, (counts.get(parent) ?? 0) + 1))
    return counts
  }, [browseBundleParentMap, traceBundleParentMap])

  // ── Edge projection ────────────────────────────────────────────────────
  //
  // Now depends on the stable `ancestorMap` instead of rebuilding it here.
  // This memo only re-runs when edges or the ancestorMap actually change.
  const projection = useMemo(() => {
    if (!showLineageFlow) return { edges: [], unresolvedCount: 0, hiddenInsideCount: 0, offCanvas: NO_OFF_CANVAS }

    const edgeGroups = new Map<string, any[]>()

    // `lifted` = the endpoints this member is filed under are NOT the ones the
    // edge itself names — it was resolved up to an ancestor. That, and only
    // that, is what makes a raw edge a roll-up (see isGhost in Finalize).
    const addEdgeToGroup = (sourceId: string, targetId: string, edge: any, type: string, lifted = false) => {
      const groupKey = `${sourceId}->${targetId}`
      if (!edgeGroups.has(groupKey)) edgeGroups.set(groupKey, [])
      edgeGroups.get(groupKey)!.push({ ...edge, source: sourceId, target: targetId, originalType: type, _lifted: lifted })
    }

    // The row an end is drawn on: itself, or the collapsed row it is folded
    // into. `ancestorMap` first — displayMap holds every node of the tree,
    // including those folded away inside a closed row.
    const rowOf = (end: string): string | undefined => {
      const id = urnToIdMap.get(end) ?? end
      return ancestorMap.get(id) ?? (displayMap.has(id) ? id : undefined)
    }

    // Where one end lands, one answer for all three sections below: a row;
    // an anchored column (its anchor, drawn AS the column, or a row of it
    // not loaded yet — in the view, with no row to draw to); outside the
    // view; pending, while its chain is still being asked; or unknown, when
    // no chain for it was ever found (after every retry, or cut short at the
    // server's hop cap), which is no evidence that it leaves the view. An end
    // the canvas never loaded is filed under its nearest ancestor that IS
    // drawn (see `ancestorChains`); an anchor on the way stops the walk, even
    // with something above it drawn elsewhere, because that column is where
    // the partner is.
    const place = (end: string): Place => {
      const row = rowOf(end)
      if (row) return { at: 'row', id: row }
      const column = promotedAnchors?.get(end)
      if (column) return { at: 'column', layerId: column }
      if (!ancestorChains) return OUTSIDE
      const chain = ancestorChains.get(end)
      if (!chain) return PENDING
      if (chain === NO_PLACE_FOUND) return UNKNOWN
      for (const ancestor of chain) {
        const up = rowOf(ancestor)
        if (up) return { at: 'row', id: up }
        const layerId = promotedAnchors?.get(ancestor)
        if (layerId) return { at: 'column', layerId }
      }
      return OUTSIDE
    }

    // The containment ancestors of one end: its loaded parents, else its
    // fetched chain.
    const containmentParents = browseBundleParentMap ?? traceBundleParentMap
    const upPath = (end: string): readonly string[] => {
      let cursor = containmentParents?.get(end)
      if (cursor === undefined) return ancestorChains?.get(end) ?? []
      const path: string[] = []
      const seen = new Set([end])
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor)
        path.push(cursor)
        cursor = containmentParents!.get(cursor)
      }
      return path
    }

    // A line between an entity and one of its own ancestors — an anchor and
    // its own row, a source and a cell inside it, an open row and its child —
    // is the entity summarised against itself: no line, no stub, not counted.
    // Walked only where that happens (a roll-up, or an end on a column), so a
    // plain line between two rows costs nothing.
    const isSelfRollup = (sUrn: string, tUrn: string, S: Place, T: Place, aggregated: boolean): boolean => {
      if (!aggregated && S.at !== 'column' && T.at !== 'column') return false
      return upPath(tUrn).includes(sUrn) || upPath(sUrn).includes(tUrn)
    }

    // How many underlying relationships ONE member stands for. A raw edge is
    // itself, so it weighs one; a roll-up arrives carrying the real total and
    // must contribute ALL of it. Counting members instead reported a rollup
    // summarising 4,300 table-level flows as `1`, which then sorted below any
    // pair holding two raw edges when the adaptive budget culls.
    //
    // Two shapes, one meaning: the collapsed aggregate built in section A puts
    // the total on `data.edgeCount`, while a MATERIALIZED `:AGGREGATED` graph
    // edge arrives through ordinary hydration with the worker's `weight` mapped
    // onto `data.sourceEdgeCount` (`toCanvasEdge`). Reading only the first
    // weighed the second as 1, so the drawer — whose `edgeWeight` reads both —
    // said 4,300 about the very line this panel said 1 about.
    const memberWeight = (e: { data?: { isAggregated?: boolean, edgeCount?: number, sourceEdgeCount?: number } }): number => {
      const d = e.data
      if (!d?.isAggregated) return 1
      const n = d.edgeCount ?? d.sourceEdgeCount
      return typeof n === 'number' && n > 0 ? n : 1
    }

    // A type the reader hid is hidden from the stubs and the count too — they
    // must not report what the lines would not draw.
    const allHidden = (types: readonly string[]) =>
      !!hiddenEdgeTypes && hiddenEdgeTypes.size > 0 && types.length > 0
      && types.every(t => hiddenEdgeTypes.has(t.toUpperCase()))

    const note = (flows: MutableFlows, side: 'in' | 'out', partner: string | undefined, weight: number) => {
      const partners = side === 'out' ? flows.outPartners : flows.inPartners
      flows[side] += weight
      if (partner !== undefined && partners.size < OFF_CANVAS_PARTNER_CAP) partners.add(partner)
    }

    // An edge with ONE end on a row and the other not drawn: the row carries
    // it (see OffCanvasLineage). Only an end OUTSIDE the view is counted as
    // missing; one in an anchored column is in the view; one with no known
    // place (pending or unknown) is held, neither a stub nor a hollow port.
    const offCanvas = new Map<string, MutableFlows & { columns: Map<string, MutableFlows>; unplaced: { in: number; out: number } }>()
    let unresolvedThisPass = 0
    const fileUndrawn = (S: Place, T: Place, sUrn: string, tUrn: string,
      types: readonly string[], weight: number, wholeColumn: boolean) => {
      const side = S.at === 'row' ? 'out' : 'in'
      const [near, far, farUrn] = side === 'out' ? [S, T, tUrn] : [T, S, sUrn]
      if (near.at !== 'row' || far.at === 'row' || allHidden(types)) return
      const isAnchor = promotedAnchors?.has(farUrn) ?? false
      // A roll-up naming an anchor that still counts its loaded rows' flows
      // summarises the whole column; the rows' own roll-ups carry those.
      if (far.at === 'column' && isAnchor && wholeColumn) return
      let entry = offCanvas.get(near.id)
      if (!entry) { entry = { ...noFlows(), columns: new Map(), unplaced: { in: 0, out: 0 } }; offCanvas.set(near.id, entry) }
      if (far.at === 'pending' || far.at === 'unknown') {
        entry.unplaced[side] += weight
        return
      }
      if (far.at === 'outside') {
        note(entry, side, farUrn, weight)
        unresolvedThisPass += weight
        return
      }
      let column = entry.columns.get(far.layerId)
      if (!column) { column = noFlows(); entry.columns.set(far.layerId, column) }
      // The anchor is drawn as the column: no partner to bring in.
      note(column, side, isAnchor ? undefined : farUrn, weight)
    }

    // A. Aggregated Edges
    // Both endpoints rolled up to the SAME anchor — a connection that lives
    // entirely inside one collapsed container (most visibly, a closed
    // logical group). There is no line to draw between a node and itself,
    // but the connection is real and the canvas has to be able to say so:
    // this used to be discarded without a trace, which is how putting two
    // related entities into a group made their lineage "disappear".
    let hiddenInsideThisPass = 0
    // The cells, one per pair: the rows' own, and a row's with a HOLDER
    // (`holderEdges`) — the rows' own win a pair both hold. A drilled cell is
    // drawn by section C, but its flows still count below.
    const cells = new Map<string, AggregatedEdgeInfo>()
    aggregatedEdges.forEach((e, id) => cells.set(id, e.aggregated))
    holderEdges?.forEach((c, id) => { if (!cells.has(id)) cells.set(id, c) })
    const cellWeight = (c: AggregatedEdgeInfo) => memberWeight({ data: { isAggregated: true, edgeCount: c.edgeCount } })

    // A holder holds rows the view has not loaded: an anchor (drawn as its
    // column), or an open container with children not loaded yet.
    const idOf = (urn: string) => urnToIdMap.get(urn) ?? urn
    const isHolder = (urn: string): boolean => {
      if (promotedAnchors?.has(urn)) return true
      const id = idOf(urn)
      if (!expandedNodes.has(id)) return false
      const node = displayMap.get(id)
      const total = (node?.data?.childCount as number) || (node?.data?._collapsedChildCount as number) || 0
      return total > (loadedChildCounts.get(id) ?? node?.children.length ?? 0)
    }

    // A holder's cell counts every flow into it, its loaded rows' included,
    // and those rows carry theirs on their own lines and columns. So the
    // holder keeps only the rest: w(row, holder) − Σ w(row, X) over the cell
    // ends X whose nearest cell end above them is that holder, floored at 0
    // (containment that is not a tree can overlap). An anchor's rest is
    // lineage into its rows past the page; an open container's, into its
    // children not loaded yet. A holder cannot say which rows of a row's OWN
    // column it means: that cell is the row summarised against itself.
    const ends = new Set<string>()
    for (const c of cells.values()) { ends.add(c.sourceUrn); ends.add(c.targetUrn) }
    const nearestEnd = (urn: string) => upPath(urn).find(up => ends.has(up))
    const pairKey = (s: string, t: string) => `${s}->${t}`
    const loadedShare = new Map<string, number>()
    const share = (s: string, t: string, w: number) => loadedShare.set(pairKey(s, t), (loadedShare.get(pairKey(s, t)) ?? 0) + w)
    cells.forEach(c => {
      const aboveT = nearestEnd(c.targetUrn)
      if (aboveT !== undefined && isHolder(aboveT)) share(c.sourceUrn, aboveT, cellWeight(c))
      const aboveS = nearestEnd(c.sourceUrn)
      if (aboveS !== undefined && isHolder(aboveS)) share(aboveS, c.targetUrn, cellWeight(c))
    })

    cells.forEach((agg, id) => {
      const state = aggregatedEdges.get(id)?.state
      if (state !== undefined && state !== 'collapsed') return
      // Suppress parent AGG when its drill is producing visible finer-level edges.
      if (isTracing && suppressedAggEdgeKeys?.has(`${agg.sourceUrn}->${agg.targetUrn}`)) return
      const shared = loadedShare.get(pairKey(agg.sourceUrn, agg.targetUrn))
      const weight = cellWeight(agg) - (shared ?? 0)
      if (weight <= 0) return
      const S = place(agg.sourceUrn)
      const T = place(agg.targetUrn)
      if (isSelfRollup(agg.sourceUrn, agg.targetUrn, S, T, true)) return
      if (S.at !== 'row' || T.at !== 'row') {
        // The weight leaves out what the loaded rows carry, so a cell naming
        // an anchor is lineage into its rows not loaded yet: in the view.
        fileUndrawn(S, T, agg.sourceUrn, agg.targetUrn,
          Array.isArray(agg.edgeTypes) && agg.edgeTypes.length > 0 ? agg.edgeTypes : ['AGGREGATED'],
          weight, false)
      } else if (S.id === T.id) {
        hiddenInsideThisPass++
      } else {
        addEdgeToGroup(S.id, T.id, {
          id: agg.id,
          // Into an open container's children not loaded yet: drawn faint.
          _residual: isHolder(agg.sourceUrn) || isHolder(agg.targetUrn),
          data: {
            edgeType: 'AGGREGATED',
            relationship: 'aggregated',
            isAggregated: true,
            edgeCount: shared === undefined ? agg.edgeCount : weight,
            edgeTypes: agg.edgeTypes,
            confidence: agg.confidence,
            sourceEdgeIds: agg.sourceEdgeIds,
          }
        }, 'AGGREGATED')
      }
    })

    // Trace-mode bundling: walk an endpoint up the canvas containment
    // hierarchy until we land on an ancestor at the focus's trace level
    // (or coarser). This rolls every column-to-column edge up to the
    // object/dataset/schema level the trace ran at, so per-pair bundling
    // (which groups by `${sourceId}->${targetId}`) actually collapses
    // thousands of leaf edges into a handful of container bundles. Without
    // this, expanding a container exposes every leaf's lineage and the
    // canvas renders 10k+ individual edges.
    //
    // Returns null when no ancestor in `traceBundleParentMap` reaches the
    // focus level — that's when we fall back to the regular ancestorMap
    // projection. Disabled outside trace mode and when configuration is
    // missing (so non-trace canvases behave unchanged).
    const bundleEnabled =
      isTracing
      && traceBundleParentMap !== undefined
      && entityTypeLevels !== undefined
      && typeof traceFocusLevel === 'number'
    // Trace renders at exactly the level the user requested. The walk
    // only consolidates endpoints that are FINER than the focus (e.g. a
    // dataset-level focus trace returned a column-level edge because of
    // inherited lineage — walk the column up to its parent dataset). When
    // the endpoint is already at focus level or coarser, the walk exits
    // immediately and the edge keeps its visible endpoints.
    //
    // Visual density at hub-node traces is the renderer's responsibility
    // (the density-adaptive tiers in LineageFlowOverlay), not the
    // projection's. An attribute-level focus must surface as
    // attribute-to-attribute edges — not be silently rolled up to the
    // parent object — or the user can't trust what they're seeing.
    const effectiveBundleCeiling = bundleEnabled ? traceFocusLevel! : 0
    const projectToTraceLevel = (endpointId: string): string | null => {
      if (!bundleEnabled) return null
      let cursor: string | undefined = endpointId
      const seen = new Set<string>()
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        const node = nodeIndex.get(cursor) ?? displayMap.get(cursor)
        const entityType = (node?.data?.type as string | undefined) ?? node?.typeId
        const level = entityType ? entityTypeLevels!.get(entityType) : undefined
        if (level === undefined) {
          return cursor
        }
        if (level <= effectiveBundleCeiling) return cursor
        const parent = traceBundleParentMap!.get(cursor)
        if (!parent) return cursor
        cursor = parent
      }
      return cursor ?? null
    }

    // B. Regular / Trace Edges
    edges
      .filter(edge => !isContainmentEdge(normalizeEdgeType(edge)))
      .forEach(edge => {
        const type = normalizeEdgeType(edge)
        const aggregated = type === 'AGGREGATED' || !!edge.data?.isAggregated
        const S = place(edge.source)
        const T = place(edge.target)
        if (isSelfRollup(edge.source, edge.target, S, T, aggregated)) return
        if (S.at !== 'row' || T.at !== 'row') {
          fileUndrawn(S, T, edge.source, edge.target, [type], memberWeight(edge), aggregated)
          return
        }
        let sId = S.id
        let tId = T.id

        if (bundleEnabled) {
          // Apply the trace-level rollup. Result endpoints are always at
          // the focus level (or coarser); ancestor pairs become the
          // visible bundle.
          const bundledS = projectToTraceLevel(sId)
          const bundledT = projectToTraceLevel(tId)
          if (bundledS) sId = bundledS
          if (bundledT) tId = bundledT
        }

        if (sId !== tId) {
          // Trace-merged edges (recorded in addedEdgeIds) bypass the
          // contextSet gate — they're definitionally part of the trace and
          // must render even if one endpoint hasn't been routed into the
          // trace-filtered hierarchy yet. Ambient (non-trace) edges still
          // need both endpoints inside the trace context.
          const isTraceMerged = isTracing && traceAddedEdgeIds?.has(edge.id)
          if (isTracing && !isTraceMerged
              && (!traceContextSet.has(sId) || !traceContextSet.has(tId))) return
          // Suppress drilled parent AGG edges (URN-pair match on the original endpoints).
          if (
            isTracing
            && String((edge.data?.edgeType) ?? '').toUpperCase() === 'AGGREGATED'
            && suppressedAggEdgeKeys?.has(`${edge.source}->${edge.target}`)
          ) return
          // After both the ancestorMap resolution and the trace-level rollup:
          // different endpoints than the edge names ⇒ lifted to an ancestor.
          const lifted = sId !== edge.source || tId !== edge.target
          addEdgeToGroup(sId, tId, { ...edge, data: edge.data || {} }, type, lifted)
        } else {
          // sId === tId: a legitimate self-rollup, but not a non-event.
          // Counted separately so the canvas can offer to open the
          // container rather than leaving the user to wonder where their
          // lineage went.
          hiddenInsideThisPass++
        }
      })

    // C. Expanded Detailed Edges
    Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges)
      .forEach(edge => {
        const S = place(edge.sourceUrn)
        const T = place(edge.targetUrn)
        if (isSelfRollup(edge.sourceUrn, edge.targetUrn, S, T, false)) return
        if (S.at !== 'row' || T.at !== 'row') {
          fileUndrawn(S, T, edge.sourceUrn, edge.targetUrn, edge.edgeType ? [edge.edgeType] : [], 1, false)
        } else if (S.id === T.id) {
          hiddenInsideThisPass++
        } else {
          // Endpoints here are urns — compare against the node each urn owns,
          // not the urn itself. An unknown urn never asserts "lifted" on its
          // own — but one filed under an ancestor by its chain always is.
          const ownS = urnToIdMap.get(edge.sourceUrn)
          const ownT = urnToIdMap.get(edge.targetUrn)
          const lifted = (ownS !== undefined && ownS !== S.id) || (ownT !== undefined && ownT !== T.id)
            || ancestorMap.get(edge.sourceUrn) === undefined || ancestorMap.get(edge.targetUrn) === undefined
          addEdgeToGroup(S.id, T.id, {
            id: edge.id,
            data: { edgeType: edge.edgeType, relationship: edge.edgeType, confidence: edge.confidence }
          }, edge.edgeType, lifted)
        }
      })

    if (unresolvedThisPass > 0) {
      const now = Date.now()
      if (now - lastWarnAtRef.current > 1000) {
        lastWarnAtRef.current = now
        console.warn(`[useEdgeProjection] ${unresolvedThisPass} flows lead outside this view — nothing drawn holds their far end`)
      }
    }

    // Browse mode has no meta-bundling pass. It used to re-key the lines of
    // rows sharing a collapsed parent onto that parent, but every group key
    // above is already a row the reader sees at the level they chose. The
    // parent it stepped to was either not a row at all (an anchored column's
    // anchor) or a different card, so the rows lost their lines and markers.
    // Lines stay on the rows they belong to.

    // The types one group member carries. `data.edgeTypes` was previously
    // tested for truthiness alone, so an empty-but-present array skipped the
    // originalType fallback and the member vanished from the bundle's types
    // while still counting toward edgeCount.
    //
    // A roll-up naming SEVERAL types is filed under its own type instead of all
    // of them. The server builds one as a single `count(r)` beside a
    // `collect(DISTINCT type(r))`, so it carries no per-type split to hand out:
    // giving its whole weight to each type read PRODUCES 4,300 and TRANSFORMS
    // 4,300 beneath a 4,300 header, and hiding either one changed nothing —
    // the member still carried the other, so it stayed on the board at full
    // weight while its row claimed to have been subtracted.
    const memberTypes = (e: any): string[] => {
      const own = e.originalType ? [e.originalType] : []
      const arr = e.data?.edgeTypes
      if (!Array.isArray(arr) || arr.length === 0) return own
      if (arr.length > 1 && e.data?.isAggregated && own.length > 0) return own
      return arr
    }

    // Finalize: bundle groups into projected edges (without delegation — applied in separate memo)
    const projected: any[] = []
    edgeGroups.forEach((groupEdges, key) => {
      // Hidden types are applied per MEMBER, not per group: grouping stayed
      // identical above so the bidirectional collapse behaves exactly as
      // before, and only the finalized bundle changes.
      const members = hiddenEdgeTypes && hiddenEdgeTypes.size > 0
        ? groupEdges.filter((e: any) => {
            const ts = memberTypes(e)
            // A member with no type at all is never hidden — we cannot filter
            // on something the data does not say.
            return ts.length === 0 || ts.some(t => !hiddenEdgeTypes.has(t.toUpperCase()))
          })
        : groupEdges
      if (members.length === 0) return

      const distinctTypes = new Set<string>()
      let isAggregated = false
      let maxConfidence = 0
      let rawWeight = 0
      let rollupWeight = 0

      const sourceId = members[0].source
      const targetId = members[0].target

      members.forEach(e => {
        if (e.data?.isAggregated) { isAggregated = true; rollupWeight += memberWeight(e) }
        else rawWeight += memberWeight(e)
        memberTypes(e).forEach((et: string) => {
          if (hiddenEdgeTypes?.has(et.toUpperCase())) return
          distinctTypes.add(et)
        })
        maxConfidence = Math.max(maxConfidence, e.data?.confidence ?? 1)
      })

      // A bundle is a roll-up when it summarises something other than the raw
      // relationship between the two cards it touches.
      const isGhost = isAggregated || members.some((e: any) => e._lifted === true)
      // Nothing but the rest of an open container's children: a faint line.
      const isResidual = members.every((e: { _residual?: boolean }) => e._residual === true)

      // TWO NUMBERS, because this bundle answers two different questions and
      // one field was doing both jobs.
      //
      // `edgeCount` is the WEIGHT: what this line stands for. A roll-up
      // summarises flows that can also be members here in their own right, so
      // it is evidence ABOUT them rather than flows on top of them — max, not
      // sum, the rule `collapseRecords` already states for the drawer. The
      // panel, the drawer, the badge and the stroke width all want this.
      //
      // `bundleSize` is the COUNT: how many lines this one line replaces. The
      // adaptive edge budget ranks on THIS, because the budget is rationing
      // room on the board, and a single roll-up occupies one line's worth of
      // room no matter how many flows it speaks for. Ranking the budget on the
      // weight let a heavy roll-up outrank — and evict — the raw edges the user
      // had just expanded to see.
      const edgeCount = Math.max(rawWeight, rollupWeight)
      const bundleSize = members.length
      const typesArray = Array.from(distinctTypes)

      // Reverse-flow annotation: layer-index of target strictly less than
      // source means the edge points back upstream against the canonical
      // left→right flow. Renderer routes these through a dedicated lane.
      let isReverseFlow = false
      if (nodeLayerIndexMap) {
        const sLayer = nodeLayerIndexMap.get(sourceId)
        const tLayer = nodeLayerIndexMap.get(targetId)
        if (typeof sLayer === 'number' && typeof tLayer === 'number' && tLayer < sLayer) {
          isReverseFlow = true
        }
      }

      projected.push({
        id: `bundle-${key}`,
        source: sourceId,
        target: targetId,
        isBundled: edgeCount > 1,
        isGhost,
        edgeCount,
        // At the top level too: that is where `bySignificance` reads it.
        bundleSize,
        types: typesArray,
        confidence: maxConfidence,
        isAggregated,
        isReverseFlow,
        isDelegated: false,
        isResidual,
        isBidirectional: false,
        data: { edgeTypes: typesArray, confidence: maxConfidence, edgeCount, bundleSize }
      })
    })

    // Bidirectional collapse: when projected groups exist for both A→B and
    // B→A, merge into a single bundle stamped `isBidirectional: true`. The
    // canonical orientation is `min(sourceId, targetId) → max(...)` so the
    // renderer has a stable anchor; the dual-arrowhead is the visual cue
    // for two-way flow. Hover/click can still reveal the underlying per-
    // direction edges from `data.edgeTypes` and counts.
    const byPair = new Map<string, { fwd?: any, rev?: any }>()
    projected.forEach(p => {
      const a = p.source, b = p.target
      if (a === b) return
      const canonical = a < b ? `${a}->${b}` : `${b}->${a}`
      const slot = byPair.get(canonical) ?? {}
      if (a < b) slot.fwd = p
      else slot.rev = p
      byPair.set(canonical, slot)
    })

    const merged: any[] = []
    const consumed = new Set<any>()
    byPair.forEach((slot, canonical) => {
      const { fwd, rev } = slot
      if (fwd && rev) {
        const [s, t] = canonical.split('->')
        const types = new Set<string>()
        ;(fwd.types as string[]).forEach(t => types.add(t))
        ;(rev.types as string[]).forEach(t => types.add(t))
        const edgeCount = (fwd.edgeCount as number) + (rev.edgeCount as number)
        // One line now stands in for the lines of both directions.
        const bundleSize = (fwd.bundleSize as number) + (rev.bundleSize as number)
        const typesArr = Array.from(types)
        merged.push({
          id: `bundle-bi-${canonical}`,
          source: s,
          target: t,
          isBundled: true,
          // A pair that summarises anything in either direction IS a summary —
          // matching the OR its isAggregated sibling already uses.
          isGhost: fwd.isGhost || rev.isGhost,
          edgeCount,
          bundleSize,
          types: typesArr,
          confidence: Math.max(fwd.confidence, rev.confidence),
          isAggregated: fwd.isAggregated || rev.isAggregated,
          isReverseFlow: false,
          isDelegated: false,
          isResidual: fwd.isResidual && rev.isResidual,
          isBidirectional: true,
          data: { edgeTypes: typesArr, confidence: Math.max(fwd.confidence, rev.confidence), edgeCount, bundleSize },
        })
        consumed.add(fwd)
        consumed.add(rev)
      }
    })

    const offCanvasResult: ReadonlyMap<string, OffCanvasLineage> = offCanvas.size > 0 ? offCanvas : NO_OFF_CANVAS
    if (consumed.size === 0) return { edges: projected, unresolvedCount: unresolvedThisPass, hiddenInsideCount: hiddenInsideThisPass, offCanvas: offCanvasResult }
    return { edges: [...projected.filter(p => !consumed.has(p)), ...merged], unresolvedCount: unresolvedThisPass, hiddenInsideCount: hiddenInsideThisPass, offCanvas: offCanvasResult }
  }, [ancestorMap, lineageEdges, edges, aggregatedEdges, displayMap, urnToIdMap, showLineageFlow, isTracing, traceContextSet, isContainmentEdge, suppressedAggEdgeKeys, traceAddedEdgeIds, traceBundleParentMap, entityTypeLevels, traceFocusLevel, nodeIndex, nodeLayerIndexMap, hiddenEdgeTypes, ancestorChains, promotedAnchors, browseBundleParentMap, holderEdges, expandedNodes, loadedChildCounts])

  const projectedEdges = projection.edges

  // ── Delegation context. expandedParentInfo: expanded parents with
  // loaded children (+ partial-load flag). coveredPairs: delegation
  // coverage — a rolled-up parent-level edge may only be hidden
  // (isDelegated) when finer child-level edges actually exist for the
  // same lifted pair; an edge whose OWN pair never appears as a lifted
  // pair has no finer substitute (container-own lineage) and must stay
  // visible.
  const delegationContext = useMemo(() => {
    const expandedParentInfo = new Map<string, { isPartiallyLoaded: boolean }>()
    expandedNodes.forEach(nodeId => {
      const node = displayMap.get(nodeId)
      if (!node) return
      const totalChildCount = (node.data?.childCount as number) || (node.data?._collapsedChildCount as number) || 0
      const loadedChildCount = node.children?.length ?? 0
      if (loadedChildCount > 0) {
        expandedParentInfo.set(nodeId, {
          isPartiallyLoaded: totalChildCount > 0 && loadedChildCount < totalChildCount,
        })
      }
    })

    const containmentParentMap = browseBundleParentMap ?? traceBundleParentMap
    const coveredPairs = new Set<string>()
    if (containmentParentMap && expandedParentInfo.size > 0) {
      for (const edge of projectedEdges) {
        const sParent = containmentParentMap.get(edge.source)
        const tParent = containmentParentMap.get(edge.target)
        const liftedS = sParent && expandedParentInfo.has(sParent) ? sParent : edge.source
        const liftedT = tParent && expandedParentInfo.has(tParent) ? tParent : edge.target
        if (liftedS !== edge.source || liftedT !== edge.target) {
          coveredPairs.add(`${liftedS}->${liftedT}`)
        }
      }
    }
    return { expandedParentInfo, coveredPairs }
  }, [projectedEdges, expandedNodes, displayMap, browseBundleParentMap, traceBundleParentMap])

  // ── Edge delegation ──
  //
  // Stamps isDelegated/isResidual on the already-projected edges: a line from
  // an open container whose children's lines cover the same pair stands aside
  // for them (delegated — not drawn), or, while the children are only partly
  // loaded, draws faintly (residual). Hovering one of its ends brings it
  // back; that is the overlay's to do (LineageFlowOverlay), so a hover never
  // re-runs this pass — nor re-renders the canvas that holds it.
  const visibleLineageEdgesWithDelegation = useMemo(() => {
    if (projectedEdges.length === 0) return projectedEdges
    const { expandedParentInfo, coveredPairs } = delegationContext

    // If no expanded parents with children, skip the mapping
    if (expandedParentInfo.size === 0) return projectedEdges

    return projectedEdges.map(edge => {
      const sourceExpanded = expandedParentInfo.get(edge.source)
      const targetExpanded = expandedParentInfo.get(edge.target)

      if (!sourceExpanded && !targetExpanded) return edge

      const hasFinerCoverage = coveredPairs.has(`${edge.source}->${edge.target}`)
      if (!hasFinerCoverage) return edge

      const anyPartial = !!(sourceExpanded?.isPartiallyLoaded || targetExpanded?.isPartiallyLoaded)

      return {
        ...edge,
        isDelegated: !anyPartial,
        isResidual: anyPartial,
      }
    })
  }, [projectedEdges, delegationContext])

  return {
    lineageEdges,
    visibleLineageEdges: visibleLineageEdgesWithDelegation,
    unresolvedEdgeCount: projection.unresolvedCount,
    hiddenInsideCollapsedCount: projection.hiddenInsideCount,
    // Legacy alias — same value; kept for existing consumers.
    unresolvedAggregatedCount: projection.unresolvedCount,
    offCanvasByNode: projection.offCanvas,
  }
}
