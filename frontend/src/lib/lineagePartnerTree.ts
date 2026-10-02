/**
 * The entity drawer's lineage — the partners of one entity, one direction,
 * as a tree from their systems down — built from the Focus Lens's own
 * closure answers and loaded a level at a time.
 *
 * The drawer used to answer "what feeds this entity?" twice, from two
 * sources that could not agree: its COUNT came from one capped closure page
 * (747 when the page was cut, 932 in the data), and its LIST from the edges
 * the canvas happened to hold, rolled up to whatever the canvas showed. A
 * table's contents carry its lineage and a canvas rarely holds its partners,
 * so the list read "No flows in this direction" under a count of 747 — or
 * folded 736 sources into the one collapsed root the canvas drew.
 *
 * TWO GRAINS, LOADED LAZILY. Opening the drawer must not walk an entity's
 * whole lineage — it opens on every selection, and most readers only want
 * to know who feeds it:
 *
 *   • `partnersFromRollups` reads the COARSE page (`grain: 'coarse'`): one
 *     indexed request, ~80 ms for a 600-column table, answering which
 *     entities feed it and how many flows each carries — the systems and the
 *     entities in them, with no column fetched. Accounted inner-first by the
 *     Lens's own rule (`rollupResiduals`), so a system and a table inside it
 *     never both claim the same flows.
 *   • `partnersFromWalk` reads the RAW walk (`useLensWalk`), fetched only
 *     when the reader opens an entity to see the columns a flow joins — and
 *     once: every other entity then opens without a request.
 *   • `withFields` grafts the raw walk's columns under the coarse tree's
 *     entities while the walk is still arriving, so the tree the reader is
 *     holding never reshapes under them.
 *
 * GRAIN OF THE COUNT. The drawer counts ENTITIES at the focal's own level —
 * the tables beside a table ("peers") — which both grains agree on (198 for
 * Accounts (Payment), with 932 underlying flows); the columns a flow joins
 * are a level below. A peer is measured along each flow, not from the root:
 * a flow that leaves the focal one step down (a table's column) arrives one
 * step down in its partner too, so the peer is the partner's ancestor one
 * step up — hierarchies that nest differently still line up.
 */
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import { rollupResiduals } from '@/hooks/lib/traceWireLedger'

export type PartnerSide = 'up' | 'down'

export interface PartnerTreeNode {
  urn: string
  /** The answer's copy of the entity; null when an answer named it (in an
   *  edge or a containment chain) without shipping it. */
  node: LensWalkNode | null
  /** Distinct peers — partner entities at the focal's level — at or inside
   *  this entity. */
  peers: number
  /** Distinct raw partners (the columns a flow reaches) inside it; 0 until
   *  the raw walk has loaded. */
  partners: number
  /** Flows between the focal and what sits here. */
  flows: number
  /** This entity is a peer — one of the entities the drawer counts. */
  isPeer: boolean
  /** The focal's lines reach this entity itself. */
  isPartner: boolean
  /** Its contents are known: a coarse peer's columns are not, until the raw
   *  walk arrives. Opening an entity whose contents are not known asks for
   *  them. */
  contentsLoaded: boolean
  /** On a partner: the entities on the focal's side its flows meet — the
   *  focal itself (coarse), or the columns inside it (raw). */
  via: string[]
  /** Most peers first, then most flows, then by name. */
  children: PartnerTreeNode[]
}

export interface SidePartners {
  /** The entities at the focal's own level that its lines reach, distinct —
   *  the count the drawer shows. */
  peers: string[]
  /** Raw partners (columns), when the raw walk has loaded; else the peers. */
  partnerUrns: string[]
  /** Raw hops, or the flows the rollup cells account for. */
  flows: number
  /** Built from the rollup cells: the peers' contents are not loaded. */
  coarse: boolean
  /** The partners' systems — every containment root they sit under. */
  roots: PartnerTreeNode[]
}

export function partnerName(n: Pick<PartnerTreeNode, 'urn' | 'node'>): string {
  return n.node?.displayName || (n.node?.data?.label as string | undefined) || n.urn
}

interface Building {
  urn: string
  node: LensWalkNode | null
  peerSet: Set<string>
  partners: number
  flows: number
  isPeer: boolean
  isPartner: boolean
  contentsLoaded: boolean
  via: string[]
  children: Map<string, Building>
}

const byWeight = (x: PartnerTreeNode, y: PartnerTreeNode) =>
  y.peers - x.peers || y.flows - x.flows || y.partners - x.partners || partnerName(x).localeCompare(partnerName(y))

function freeze(b: Building): PartnerTreeNode {
  const children = [...b.children.values()].map(freeze).sort(byWeight)
  return {
    urn: b.urn,
    node: b.node,
    peers: b.peerSet.size,
    partners: b.partners,
    flows: b.flows,
    isPeer: b.isPeer,
    isPartner: b.isPartner,
    contentsLoaded: b.contentsLoaded,
    via: b.via,
    children,
  }
}

/** The containment the answer shipped: parents (first wins) and children. */
function containment(model: LensWalkModel) {
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  for (const e of model.containmentEdges) {
    if (e.sourceUrn === e.targetUrn) continue
    if (!parentOf.has(e.targetUrn)) parentOf.set(e.targetUrn, e.sourceUrn)
    const kids = childrenOf.get(e.sourceUrn)
    if (kids) kids.push(e.targetUrn)
    else childrenOf.set(e.sourceUrn, [e.targetUrn])
  }
  /** Containment ancestors, outermost first. Cycles terminate. */
  const chainOf = (urn: string): string[] => {
    const out: string[] = []
    const seen = new Set([urn])
    let c = parentOf.get(urn)
    while (c !== undefined && !seen.has(c)) {
      seen.add(c)
      out.push(c)
      c = parentOf.get(c)
    }
    return out.reverse()
  }
  // The focal's side of every line: the focal and whatever it contains.
  const scope = new Set<string>()
  const stack = [model.focusUrn]
  while (stack.length > 0) {
    const u = stack.pop()!
    if (scope.has(u)) continue
    scope.add(u)
    for (const k of childrenOf.get(u) ?? []) stack.push(k)
  }
  return { parentOf, chainOf, scope }
}

/** One partner as the tree takes it: where it sits, which of its ancestors
 *  (or itself) is the peer, and what reaches it. */
interface Placed {
  urn: string
  chain: string[]
  peer: string
  flows: number
  via: string[]
  contentsLoaded: boolean
}

function grow(model: LensWalkModel, placed: Placed[], coarse: boolean): SidePartners {
  const nodeBy = new Map<string, LensWalkNode>()
  for (const n of model.nodes) nodeBy.set(n.urn, n)
  const all = new Map<string, Building>()
  const roots = new Map<string, Building>()
  const at = (urn: string): Building => {
    let b = all.get(urn)
    if (!b) {
      b = {
        urn, node: nodeBy.get(urn) ?? null, peerSet: new Set(), partners: 0, flows: 0,
        isPeer: false, isPartner: false, contentsLoaded: true, via: [], children: new Map(),
      }
      all.set(urn, b)
    }
    return b
  }
  const peers = new Set<string>()
  const partnerUrns: string[] = []
  let flows = 0
  for (const p of placed) {
    peers.add(p.peer)
    partnerUrns.push(p.urn)
    flows += p.flows
    const peerAt = p.chain.indexOf(p.peer)
    let prev: Building | null = null
    for (let i = 0; i < p.chain.length; i++) {
      const urn = p.chain[i]
      const b = at(urn)
      if (i <= peerAt) b.peerSet.add(p.peer)
      if (!coarse) b.partners++
      b.flows += p.flows
      if (urn === p.peer) b.isPeer = true
      if (prev) prev.children.set(urn, b)
      else roots.set(urn, b)
      prev = b
    }
    if (prev) {
      prev.isPartner = true
      prev.via = p.via
      prev.contentsLoaded = p.contentsLoaded
    }
  }
  const frozen = [...roots.values()].map(freeze).sort(byWeight)
  return { peers: [...peers], partnerUrns, flows, coarse, roots: frozen }
}

/**
 * One direction from the COARSE page: the entities whose rollup cells still
 * say something once the cells inside them have spoken (the Lens's
 * card-or-host rule), each with the flows it accounts for. Their contents
 * are not loaded.
 */
export function partnersFromRollups(model: LensWalkModel, side: PartnerSide): SidePartners {
  const focus = model.focusUrn
  // `rollupResiduals` reads both directions at once; keep this side's cells.
  const sideModel: LensWalkModel = {
    ...model,
    lineageEdges: model.lineageEdges.filter(e =>
      e.kind !== 'rollup' || (side === 'up' ? e.targetUrn === focus : e.sourceUrn === focus)),
  }
  const { chainOf } = containment(model)
  const placed: Placed[] = []
  for (const [far, residual] of rollupResiduals(sideModel)) {
    if (residual <= 0) continue
    placed.push({ urn: far, chain: [...chainOf(far), far], peer: far, flows: residual, via: [focus], contentsLoaded: false })
  }
  return grow(model, placed, true)
}

/**
 * One direction from the RAW walk: every partner the walk reached, under the
 * peer it belongs to, with the flows that reach it and the focal-side
 * entities they meet.
 */
export function partnersFromWalk(model: LensWalkModel, side: PartnerSide): SidePartners {
  const { parentOf, chainOf, scope } = containment(model)
  const partnerSet = side === 'up' ? model.upstreamUrns : model.downstreamUrns

  // Flows per partner. Raw hops count one each; a rollup cell counts the
  // flows it summarises, and only where no raw hop reaches that partner —
  // a manual model authors its flows AS rollups, and a partner that is both
  // must not count twice.
  const flowsOf = new Map<string, number>()
  const viaOf = new Map<string, Set<string>>()
  /** How far below the focal each flow leaves it — the peer sits as far
   *  above the partner. The shallowest flow decides. */
  const stepsOf = new Map<string, number>()
  const stepsBelowFocal = (urn: string): number => {
    let steps = 0
    let c: string | undefined = urn
    const seen = new Set<string>()
    while (c !== undefined && c !== model.focusUrn && !seen.has(c)) {
      seen.add(c)
      steps++
      c = parentOf.get(c)
    }
    return c === model.focusUrn ? steps : 0
  }
  const add = (far: string, near: string, w: number) => {
    flowsOf.set(far, (flowsOf.get(far) ?? 0) + w)
    let v = viaOf.get(far)
    if (!v) viaOf.set(far, (v = new Set()))
    v.add(near)
    const steps = stepsBelowFocal(near)
    const had = stepsOf.get(far)
    if (had === undefined || steps < had) stepsOf.set(far, steps)
  }
  const ends = (e: { sourceUrn: string; targetUrn: string }) =>
    side === 'up' ? { near: e.targetUrn, far: e.sourceUrn } : { near: e.sourceUrn, far: e.targetUrn }
  const rawReached = new Set<string>()
  for (const e of model.lineageEdges) {
    if (e.kind === 'rollup') continue
    const { near, far } = ends(e)
    if (!scope.has(near) || scope.has(far) || !partnerSet.has(far)) continue
    add(far, near, 1)
    rawReached.add(far)
  }
  for (const e of model.lineageEdges) {
    if (e.kind !== 'rollup') continue
    const { near, far } = ends(e)
    if (!scope.has(near) || scope.has(far) || !partnerSet.has(far) || rawReached.has(far)) continue
    add(far, near, Math.max(1, e.weight ?? 1))
  }

  const placed: Placed[] = []
  for (const p of partnerSet) {
    // Lineage between two things inside the focal is not a partner of it.
    if (scope.has(p)) continue
    const chain = [...chainOf(p), p]
    const peer = chain[Math.max(0, chain.length - 1 - (stepsOf.get(p) ?? 0))]
    placed.push({ urn: p, chain, peer, flows: flowsOf.get(p) ?? 0, via: [...(viaOf.get(p) ?? [])], contentsLoaded: true })
  }
  return grow(model, placed, false)
}

/**
 * The coarse tree, with the raw walk's contents grafted under every peer the
 * walk has reached so far — so a tree the reader is holding keeps its shape
 * while the walk is still arriving. Counts stay the coarse tree's until the
 * walk is done; then the raw tree replaces it outright.
 *
 * A peer's contents count as LOADED only once the walk is `complete`: a
 * first page can hold 3 of a table's 10 feeding columns, and a list of 3
 * read as the whole answer. Until then the columns so far show, still
 * marked as arriving.
 */
export function withFields(coarse: SidePartners, raw: SidePartners, complete = false): SidePartners {
  const rawBy = new Map<string, PartnerTreeNode>()
  const index = (n: PartnerTreeNode) => {
    rawBy.set(n.urn, n)
    n.children.forEach(index)
  }
  raw.roots.forEach(index)
  const graft = (n: PartnerTreeNode): PartnerTreeNode => {
    if (n.isPeer) {
      const r = rawBy.get(n.urn)
      return r ? { ...n, partners: r.partners, contentsLoaded: complete, children: r.children } : n
    }
    return { ...n, children: n.children.map(graft) }
  }
  return { ...coarse, roots: coarse.roots.map(graft) }
}
