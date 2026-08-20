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
 * (`resolveRootLayer`), and ancestors above that anchor are dropped. A chain
 * with no placeable ancestor is never invented into a synthetic lane: it is
 * counted in `outsideView` and reported as a number.
 *
 * Two kinds of card:
 *  • PARTICIPANTS — on the lineage (focus/up/down/both).
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
import type { HierarchyNode } from '@/types/hierarchy'
import type { ViewLayerConfig } from '@/types/schema'
import { resolveRootLayer } from './resolveRootLayer'

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
  /** Participants inside this card's subtree (self excluded). */
  onLineage: number
  expanded: boolean
  /** Min lineage hop from the focus subtree (null = host only). */
  hop: number | null
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
}

export interface TraceView {
  lanes: TraceLane[]
  visible: Set<string>
  /** Participants whose whole ancestor chain is unplaceable by this view. */
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

  // A hop-1 partner known ONLY through a rollup — the container-grain
  // statement the raw subgraph cannot make, because the raw hops land on
  // that container's columns rather than on the container itself.
  const rollupPartners = new Set<string>()
  for (const e of i.model.lineageEdges) {
    if (e.kind !== 'rollup') continue
    if (e.sourceUrn === i.focusUrn) rollupPartners.add(e.targetUrn)
    if (e.targetUrn === i.focusUrn) rollupPartners.add(e.sourceUrn)
  }

  const roleBy = new Map<string, TraceCard['role']>()
  const hopBy = new Map<string, number | null>()
  for (const [urn, n] of sg.nodes) {
    const up = n.hopUp !== null || i.model.upstreamUrns.has(urn)
    const down = n.hopDown !== null || i.model.downstreamUrns.has(urn)
    roleBy.set(urn, n.isFocus ? 'focus' : up && down ? 'both' : up ? 'up' : down ? 'down' : 'host')
    const hops = [n.hopUp, n.hopDown].filter((h): h is number => h !== null)
    hopBy.set(urn, hops.length > 0 ? Math.min(...hops) : rollupPartners.has(urn) ? 1 : null)
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

  // PLACEMENT: climb to the HIGHEST ancestor the view places. Rules only bite
  // in an open view — `resolveRootLayer` closes a curated view to its own
  // explicit assignments, which is why `snowflake` stays chrome.
  const ruleFor = (type: string): string | undefined => i.layers.find(l => l.entityTypes.includes(type))?.id
  const layerCache = new Map<string, string | undefined>()
  const layerFor = (urn: string): string | undefined => {
    if (layerCache.has(urn)) return layerCache.get(urn)
    const layer = resolveRootLayer({
      nodeId: urn, nodeUrn: urn, nodeLayerProp: undefined, instanceAssignment: undefined,
      explicitAssignment: i.assignments[urn]?.layerId, viewIsCurated: i.viewIsCurated, branchCreated: false,
      backendAssignment: undefined, ruleAssignment: ruleFor(typeOf(urn)), inheritedLayerId: undefined,
      unassignedFallbackLayerId: undefined,
    })
    layerCache.set(urn, layer)
    return layer
  }

  const anchorOf = new Map<string, string>()        // participant → its anchor
  const laneOfAnchor = new Map<string, string>()    // anchor → layerId
  let outsideView = 0
  for (const p of participants) {
    let anchor: string | null = null
    let anchorLayer: string | undefined
    let cursor: string | null = p
    const guard = new Set<string>()
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor)
      const layer = layerFor(cursor)
      if (layer) { anchor = cursor; anchorLayer = layer }   // keep climbing: HIGHEST placed wins
      cursor = sg.nodes.get(cursor)?.parent ?? null
    }
    if (anchor && anchorLayer) {
      anchorOf.set(p, anchor)
      laneOfAnchor.set(anchor, anchorLayer)
    } else {
      outsideView += 1
    }
  }

  // SCOPE: a participant survives its direction being on and its hop being
  // within that direction's depth. A host has no direction of its own — it
  // survives only by hosting something that survived (below).
  const within = (hop: number | null, depth: number): boolean =>
    depth >= UNLIMITED_DEPTH || (hop !== null && hop <= depth)
  const inScope = (urn: string): boolean => {
    const role = roleBy.get(urn)
    if (role === 'focus') return true
    const n = sg.nodes.get(urn)
    if (!n) return false
    const hop = hopBy.get(urn) ?? null
    const up = i.showUpstream && within(n.hopUp ?? hop, i.depthUp)
    const down = i.showDownstream && within(n.hopDown ?? hop, i.depthDown)
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
        hop: hopBy.get(urn) ?? null,
        role: roleBy.get(urn) ?? 'host',
        data: (sg.nodes.get(urn)?.node.data ?? {}) as Record<string, unknown>,
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

  return { lanes, visible, outsideView, counts: { up, down } }
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
 */
export function lanesToHierarchy(lanes: TraceLane[]): Array<{ layerId: string; nodes: HierarchyNode[] }> {
  const toHierarchy = (lane: TraceLane, urn: string, parentId: string | undefined): HierarchyNode => {
    const card = lane.cards.get(urn)!
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
      children: (lane.childrenOf.get(urn) ?? []).map(kid => toHierarchy(lane, kid, urn)),
      ...(parentId === undefined ? {} : { parentId }),
      depth: card.depth,
      urn: card.urn,
      entityTypeOption: card.type,
      tags: [],
    }
  }
  return lanes.map(lane => ({
    layerId: lane.layerId,
    nodes: lane.roots.map(root => toHierarchy(lane, root.id, undefined)),
  }))
}
