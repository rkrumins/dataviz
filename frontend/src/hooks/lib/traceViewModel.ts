/**
 * traceViewModel — what the canvas draws in TRACE MODE, as a pure function of
 * (walk model, view placement, expansion, direction/depth toggles).
 *
 * THE INVARIANT this exists to hold: trace results are an OVERLAY, never a
 * merge into the canvas store. Merging is what produced a 1,774-item junk
 * lane, lost chevrons and a re-laid-out canvas — because a merged node lands
 * wherever the graph says instead of where THE VIEW places it.
 *
 * So every chain is anchored at the HIGHEST ancestor the view actually places
 * — decided by the canvas's OWN placement chain and rule engine
 * (`resolveRootLayer` / `buildLayerRules`) — and ancestors above that anchor
 * are dropped. A chain with no placeable ancestor is never invented into a
 * synthetic lane: it is counted in `outsideView` and reported as a number.
 *
 * Three kinds of card:
 *  • THE FOCUS SIDE — the focus and everything inside it. What the reader is
 *    looking at, never a partner of itself: never counted, never scoped away.
 *  • PARTNERS — what the lineage led to (up/down/both). The counts count these.
 *  • HOSTS — containment ancestors between an anchor and a participant. They
 *    host, they nest, they are never counted as being on the lineage.
 *
 * Counts are honest: `childCount` is the GRAPH's count of a card's children
 * (`data.childCount`), never `children.length` of the walked subset — the
 * walk only ever holds the children that carry lineage. `onLineage` is how
 * many participants sit INSIDE the card ("N things inside X carry lineage
 * here", the same statement the lens makes).
 */
import { buildLensSubgraph } from '@/components/canvas/context-view/lens/lens-subgraph'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import { resolveLayerAssignment, type GraphNode } from '@/providers/GraphDataProvider'
import type { HierarchyNode } from '@/types/hierarchy'
import type { ViewLayerConfig } from '@/types/schema'
import { buildLayerRules, resolveRootLayer } from './resolveRootLayer'
import { buildLedger, buildTraceWires, type TraceWire } from './traceWireLedger'

export type { TraceWire } from './traceWireLedger'

export interface TraceCard {
  id: string
  urn: string
  label: string
  type: string
  parentId: string | null
  /** Containment depth relative to the LANE ROOT (the anchor = 0). */
  depth: number
  /** Graph-counted children (`data.childCount`) — never `children.length`. */
  childCount: number
  /** Things INSIDE this card that carry lineage: participants in its subtree,
   *  SELF EXCLUDED — a participant leaf reads 0. The same statement the Lens
   *  makes, "N things inside X carry lineage here". */
  onLineage: number
  expanded: boolean
  /** Min lineage hop from the focus subtree (null = host only). */
  hop: number | null
  /** `'focus'` is the focus SIDE — the focus and everything inside it, which
   *  is what the reader is looking at rather than something the lineage led
   *  to. Never a partner: never counted, never scoped away. */
  role: 'focus' | 'up' | 'down' | 'both' | 'host'
  /** The walk node's payload, passed through untouched, so the hierarchy
   *  adapter can hand the canvas renderer the same `data` it always gets. */
  data: Record<string, unknown>
}

export interface TraceLane {
  layerId: string
  roots: TraceCard[]
  cards: Map<string, TraceCard>
  childrenOf: Map<string, string[]>
}

export interface TraceViewInputs {
  model: LensWalkModel
  focusUrn: string
  layers: ViewLayerConfig[]
  assignments: Record<string, { layerId: string }>
  viewIsCurated: boolean
  traceExpansion: ReadonlySet<string>
  showUpstream: boolean
  showDownstream: boolean
  /** ≥ 25 ⇒ unlimited. */
  depthUp: number
  depthDown: number
  /** Pairs (`pairKey(src, dst)`) whose raw detail is fully loaded. Omitted =
   *  all of them: Stage 1's standing assumption that the walk model IS the
   *  fine closure. Anything less makes a pair's rollup stay on as a residual. */
  completePairs?: ReadonlySet<string>
  /** The rest of the canvas's placement chain, so the overlay anchors a node
   *  exactly where the canvas behind it would. All optional: omit for a view
   *  that places purely by assignments and rules. */
  placement?: {
    /** The backend's effective assignments, urn → layerId. */
    backendAssignments?: ReadonlyMap<string, string>
    /** Open scope only: the layer opting in via `showUnassigned`. */
    unassignedFallbackLayerId?: string
    /** URNs created in the active branch's draft — the only nodes a CURATED
     *  view lets a stamped `layerAssignment` place. */
    branchCreatedUrns?: ReadonlySet<string>
  }
}

export interface TraceView {
  lanes: TraceLane[]
  visible: Set<string>
  /** The lineage lines between VISIBLE cards, each at the one grain the
   *  reader's own expansion has earned (see traceWireLedger). */
  wires: TraceWire[]
  /** How many CHAINS this view cannot place anywhere — keyed by the top of
   *  each unplaceable chain, so a warehouse whose six columns are all outside
   *  the view counts once. Computed before direction/depth scoping. */
  outsideView: number
  counts: { up: number; down: number }
}

/** Depth at or beyond which a direction is unlimited. */
const UNLIMITED_DEPTH = 25

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function buildTraceView(i: TraceViewInputs): TraceView {
  // RAW edges only: rollups are a summary OF the raw hops, so counting them
  // as hops would double-count and put container-grain distances on the same
  // ruler as column-grain ones.
  const sg = buildLensSubgraph<LensWalkNode>({
    focusUrn: i.focusUrn,
    nodes: i.model.nodes,
    lineageEdges: i.model.lineageEdges.filter(e => e.kind !== 'rollup'),
    containmentEdges: i.model.containmentEdges,
    frontierUp: i.model.frontierUp,
    frontierDown: i.model.frontierDown,
  })

  // THE FOCUS SIDE: the focus and everything inside it. `buildLensSubgraph`
  // seeds that whole subtree at hop 0 in BOTH directions, which would read as
  // role 'both' — as if the focus's own columns were partners of themselves.
  // They are what the reader is looking at, so they are 'focus': never
  // counted as a partner, never scoped away by a direction toggle.
  const focusSide = new Set<string>()
  const focusStack = [i.focusUrn]
  while (focusStack.length > 0) {
    const urn = focusStack.pop()!
    if (focusSide.has(urn) || !sg.nodes.has(urn)) continue
    focusSide.add(urn)
    for (const child of sg.nodes.get(urn)!.children) focusStack.push(child)
  }

  // A hop-1 partner known ONLY through a rollup — the container-grain
  // statement the raw subgraph cannot make, because the raw hops land on
  // that container's columns rather than on the container itself. The edge's
  // OWN direction says which side it is on: a rollup INTO the focus comes
  // from upstream, one out of it goes downstream.
  const rollupUp = new Set<string>()
  const rollupDown = new Set<string>()
  for (const e of i.model.lineageEdges) {
    if (e.kind !== 'rollup') continue
    if (e.targetUrn === i.focusUrn) rollupUp.add(e.sourceUrn)
    if (e.sourceUrn === i.focusUrn) rollupDown.add(e.targetUrn)
  }

  const roleBy = new Map<string, TraceCard['role']>()
  // Per-direction hops, kept apart on purpose: an upstream distance is only
  // ever measured against depthUp and a downstream one against depthDown.
  const hopUpBy = new Map<string, number | null>()
  const hopDownBy = new Map<string, number | null>()
  for (const [urn, n] of sg.nodes) {
    const hopUp = n.hopUp ?? (rollupUp.has(urn) ? 1 : null)
    const hopDown = n.hopDown ?? (rollupDown.has(urn) ? 1 : null)
    hopUpBy.set(urn, hopUp)
    hopDownBy.set(urn, hopDown)
    if (focusSide.has(urn)) {
      roleBy.set(urn, 'focus')
      continue
    }
    const up = hopUp !== null || i.model.upstreamUrns.has(urn)
    const down = hopDown !== null || i.model.downstreamUrns.has(urn)
    roleBy.set(urn, up && down ? 'both' : up ? 'up' : down ? 'down' : 'host')
  }
  const hopOf = (urn: string): number | null => {
    const hops = [hopUpBy.get(urn) ?? null, hopDownBy.get(urn) ?? null].filter((h): h is number => h !== null)
    return hops.length > 0 ? Math.min(...hops) : null
  }
  const participants = [...sg.nodes.keys()].filter(u => roleBy.get(u) !== 'host')

  const labelOf = (urn: string): string => {
    const n = sg.nodes.get(urn)?.node
    return n?.displayName ?? n?.data?.label ?? urn
  }
  const typeOf = (urn: string): string => {
    const n = sg.nodes.get(urn)?.node
    return n?.entityType ?? n?.data?.type ?? ''
  }
  const byLabel = (a: string, b: string): number => cmp(labelOf(a), labelOf(b)) || cmp(a, b)

  // PLACEMENT: climb to the HIGHEST ancestor the view places, deciding each
  // step with the canvas's OWN chain and the canvas's OWN rule engine — a
  // hand-rolled `entityTypes.includes` lookalike would place trace cards
  // somewhere the canvas behind them does not. Rules only bite in an open
  // view — `resolveRootLayer` closes a curated view to its explicit
  // assignments, which is why `snowflake` stays chrome.
  const rules = buildLayerRules([...i.layers].sort((a, b) => a.order - b.order))
  const validLayerIds = new Set(i.layers.map(l => l.id))
  const dataOf = (urn: string): Record<string, unknown> =>
    (sg.nodes.get(urn)?.node.data ?? {}) as Record<string, unknown>
  // The GraphNode the rule engine matches on — the same mapping the canvas
  // hook feeds it (useLayerAssignment.ts), so identical inputs match
  // identically.
  const graphNodeOf = (urn: string): GraphNode => {
    const data = dataOf(urn)
    return {
      urn: (data.urn as string) || urn,
      entityType: (data.type as string) || '',
      displayName: (data.label as string) || (data.businessLabel as string) || urn,
      properties: data,
      tags: (data.classifications as string[]) || [],
    }
  }
  const layerCache = new Map<string, string | undefined>()
  const layerFor = (urn: string): string | undefined => {
    if (layerCache.has(urn)) return layerCache.get(urn)
    const stamped = dataOf(urn).layerAssignment
    const layer = resolveRootLayer({
      nodeId: urn,
      nodeUrn: urn,
      // Validated exactly as the hook validates it: a stamped layer that no
      // longer names a layer of this view cannot strand the node.
      nodeLayerProp: typeof stamped === 'string' && validLayerIds.has(stamped) ? stamped : undefined,
      instanceAssignment: undefined,          // a live drag is canvas state, not the overlay's
      explicitAssignment: i.assignments[urn]?.layerId,
      viewIsCurated: i.viewIsCurated,
      branchCreated: i.placement?.branchCreatedUrns?.has(urn) ?? false,
      backendAssignment: i.placement?.backendAssignments?.get(urn),
      ruleAssignment: resolveLayerAssignment(graphNodeOf(urn), rules),
      // Anchors are ROOTS by construction — the climb stops at the highest
      // placed ancestor — so containment inheritance (and an assignment's
      // `inheritsChildren`) cannot apply to one.
      inheritedLayerId: undefined,
      unassignedFallbackLayerId: i.placement?.unassignedFallbackLayerId,
    })
    layerCache.set(urn, layer)
    return layer
  }

  const anchorOf = new Map<string, string>()        // participant → its anchor
  const laneOfAnchor = new Map<string, string>()    // anchor → layerId
  // CHAINS, not participants: a warehouse whose six columns are all outside
  // the view is ONE thing the reader cannot see, not six. Keyed by the top of
  // the unplaceable chain, and counted BEFORE scoping — what the view cannot
  // show does not depend on which direction toggle is currently on.
  const anchorlessChains = new Set<string>()
  for (const p of participants) {
    let anchor: string | null = null
    let anchorLayer: string | undefined
    let top = p
    let cursor: string | null = p
    const guard = new Set<string>()
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor)
      top = cursor
      const layer = layerFor(cursor)
      if (layer) { anchor = cursor; anchorLayer = layer }   // keep climbing: HIGHEST placed wins
      cursor = sg.nodes.get(cursor)?.parent ?? null
    }
    if (anchor && anchorLayer) {
      anchorOf.set(p, anchor)
      laneOfAnchor.set(anchor, anchorLayer)
    } else {
      anchorlessChains.add(top)
    }
  }

  // SCOPE: a participant survives its direction being on and its hop being
  // within that direction's depth. A host has no direction of its own — it
  // survives only by hosting something that survived (below).
  // Each direction is judged on ITS OWN hop — an upstream distance never
  // stands in for a downstream one — and a 'both' node survives if EITHER
  // enabled direction admits it.
  const within = (hop: number | null, depth: number): boolean =>
    depth >= UNLIMITED_DEPTH || (hop !== null && hop <= depth)
  const inScope = (urn: string): boolean => {
    const role = roleBy.get(urn)
    if (role === 'focus') return true
    const up = i.showUpstream && within(hopUpBy.get(urn) ?? null, i.depthUp)
    const down = i.showDownstream && within(hopDownBy.get(urn) ?? null, i.depthDown)
    return role === 'up' ? up : role === 'down' ? down : role === 'both' ? up || down : false
  }
  const scoped = new Set(participants.filter(p => anchorOf.has(p) && inScope(p)))

  // Cards = every surviving participant plus the hosts between it and its
  // anchor. Nothing else: a host with no surviving descendant never appears,
  // and an anchor with nothing left under it never becomes a lane.
  const urnsByAnchor = new Map<string, Set<string>>()
  for (const p of scoped) {
    const anchor = anchorOf.get(p)!
    const bucket = urnsByAnchor.get(anchor) ?? new Set<string>()
    let cursor: string | null = p
    while (cursor && !bucket.has(cursor)) {
      bucket.add(cursor)
      if (cursor === anchor) break
      cursor = sg.nodes.get(cursor)?.parent ?? null
    }
    urnsByAnchor.set(anchor, bucket)
  }

  const laneUrns = new Map<string, Set<string>>()
  const laneRoots = new Map<string, string[]>()
  for (const [anchor, urns] of urnsByAnchor) {
    const layerId = laneOfAnchor.get(anchor)!
    const bucket = laneUrns.get(layerId) ?? new Set<string>()
    for (const urn of urns) bucket.add(urn)
    laneUrns.set(layerId, bucket)
    laneRoots.set(layerId, [...(laneRoots.get(layerId) ?? []), anchor])
  }

  const lanes: TraceLane[] = []
  for (const [layerId, urns] of laneUrns) {
    const cards = new Map<string, TraceCard>()
    const childrenOf = new Map<string, string[]>()
    const seen = new Set<string>()
    /** Returns the participants in this subtree INCLUDING `urn` itself. */
    const visit = (urn: string, parentId: string | null, depth: number): number => {
      if (seen.has(urn)) return 0                  // containment-cycle guard
      seen.add(urn)
      const kids = (sg.nodes.get(urn)?.children ?? []).filter(c => urns.has(c)).sort(byLabel)
      childrenOf.set(urn, kids)
      let inside = 0
      for (const kid of kids) inside += visit(kid, urn, depth + 1)
      cards.set(urn, {
        id: urn, urn, label: labelOf(urn), type: typeOf(urn), parentId, depth,
        childCount: childCountOf(sg.nodes.get(urn)?.node),
        onLineage: inside,
        expanded: i.traceExpansion.has(urn),
        hop: hopOf(urn),
        role: roleBy.get(urn) ?? 'host',
        data: dataOf(urn),
      })
      return inside + (scoped.has(urn) ? 1 : 0)
    }
    const roots = (laneRoots.get(layerId) ?? []).slice().sort(byLabel)
    for (const root of roots) visit(root, null, 0)
    lanes.push({ layerId, roots: roots.map(r => cards.get(r)!), cards, childrenOf })
  }
  const orderOf = (layerId: string): number =>
    i.layers.find(l => l.id === layerId)?.order ?? Number.MAX_SAFE_INTEGER
  lanes.sort((a, b) => orderOf(a.layerId) - orderOf(b.layerId) || cmp(a.layerId, b.layerId))

  // R1 VISIBILITY: a lane root, or every ancestor up to it expanded. Seeding
  // the focus chain is the caller's job — nothing is implicitly opened here.
  const visible = new Set<string>()
  for (const lane of lanes) {
    const walk = (urn: string) => {
      if (visible.has(urn)) return
      visible.add(urn)
      if (!lane.cards.get(urn)?.expanded) return
      for (const kid of lane.childrenOf.get(urn) ?? []) walk(kid)
    }
    for (const root of lane.roots) walk(root.id)
  }

  let up = 0
  let down = 0
  for (const p of scoped) {
    const role = roleBy.get(p)
    if (role === 'up' || role === 'both') up += 1
    if (role === 'down' || role === 'both') down += 1
  }

  // WIRES last: they are drawn between the cards that survived scoping and
  // are visible right now, so a hidden branch contributes none.
  const wires = buildTraceWires({
    sg,
    model: i.model,
    visible,
    // The SUBGRAPH's edges, not the model's: the ledger and the projection
    // must count the same hops, and the subgraph is what dropped the
    // dangling ones.
    ledger: buildLedger(i.model, i.completePairs, sg.lineageEdges),
  })

  return { lanes, visible, wires, outsideView: anchorlessChains.size, counts: { up, down } }
}

/** The GRAPH's child count, at face value. `?? 0` and never `children.length`:
 *  the walk holds only the children that carry lineage, so counting them
 *  would report "1 more" on a table with 300 columns. */
function childCountOf(node: LensWalkNode | undefined): number {
  const count = node?.data?.childCount
  return typeof count === 'number' ? count : 0
}

/**
 * Adapter for `LayerColumn`: each lane → the `HierarchyNode` trees the canvas
 * already knows how to render, with the trace's own counts on `data` so the
 * renderer reads chevrons and "N on this lineage" from one place.
 *
 * The VISIBLE tree only: a closed card emits no children, so a partner renders
 * closed exactly as the reader left it. Its `data.childCount` is still the
 * graph's count, which is what keeps the chevron there to be clicked.
 */
export function lanesToHierarchy(lanes: TraceLane[]): Array<{ layerId: string; nodes: HierarchyNode[] }> {
  const toHierarchy = (lane: TraceLane, urn: string, parentId: string | undefined, seen: Set<string>): HierarchyNode => {
    seen.add(urn)
    const card = lane.cards.get(urn)!
    const children: HierarchyNode[] = []
    if (card.expanded) {
      for (const kid of lane.childrenOf.get(urn) ?? []) {
        if (seen.has(kid) || !lane.cards.has(kid)) continue   // containment-cycle guard
        children.push(toHierarchy(lane, kid, urn, seen))
      }
    }
    return {
      id: card.id,
      typeId: card.type,
      name: card.label,
      data: {
        ...card.data,
        childCount: card.childCount,
        onLineage: card.onLineage,
        traceRole: card.role,
        traceHop: card.hop,
      },
      children,
      ...(parentId === undefined ? {} : { parentId }),
      depth: card.depth,
      urn: card.urn,
      entityTypeOption: card.type,
      tags: [],
    }
  }
  return lanes.map(lane => {
    const seen = new Set<string>()
    return {
      layerId: lane.layerId,
      nodes: lane.roots.map(root => toHierarchy(lane, root.id, undefined, seen)),
    }
  })
}
