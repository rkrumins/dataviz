/**
 * The entity drawer's lineage, read from the Focus Lens's own walk.
 *
 * The drawer used to answer "what feeds this entity?" twice, from two
 * sources that could not agree: its COUNT came from one capped closure page
 * (747 when the page was cut, 932 in the data), and its LIST from the edges
 * the canvas happened to hold, rolled up to whatever the canvas showed. A
 * table's contents carry its lineage and a canvas rarely holds its partners,
 * so the list read "No flows in this direction" under a count of 747 — or
 * folded 736 sources into the one collapsed root the canvas drew.
 *
 * Now both come from the walk model the Lens builds (`useLensWalk`,
 * closure-adapter.ts): the partners the server walk found, degree-exact, in
 * the containment they sit in. This module turns that model into what the
 * drawer shows for one direction — how many partners, how many flows, and
 * the partners as a tree from their systems down, so a reader can open a
 * system, then an entity, then see the fields a flow joins.
 *
 * GRAIN. A partner is what the walk reached: for a table, its columns reach
 * other columns, so a table's partners are columns — the same number the
 * Lens reads ("fed by 932 sources"). `peers` names them at the focal's OWN
 * level (the tables beside a table), which is what "show them on the
 * canvas" should bring in: 198 tables, not 932 columns expanded one by one.
 * The level is measured along each flow, not from the top: a flow that
 * leaves the focal one step down (a table's column) arrives one step down
 * in its partner too, so the partner's peer is the ancestor one step up.
 * Depth from the root would disagree the moment two systems nest
 * differently — a top-level table fed by `Web Analytics › Customers ›
 * customer_id` has Customers beside it, not Web Analytics.
 *
 * COARSE. Before the first raw page lands, the walk may hold only the
 * rollup cells (`grain: 'coarse'`): partner containers and how many flows
 * each summarises. They answer "which entities" at once; the raw pages
 * replace them. `coarse: true` says the numbers are the rollups'.
 */
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'

export type PartnerSide = 'up' | 'down'

export interface PartnerTreeNode {
  urn: string
  /** The walk's copy of the entity; null when the walk named it (in an edge
   *  or a containment chain) without shipping it. */
  node: LensWalkNode | null
  /** Distinct partners at or inside this entity. */
  partners: number
  /** Flows between the focal and those partners. */
  flows: number
  /** The focal's lines reach this entity itself. */
  isPartner: boolean
  /** On a partner: the entities on the focal's side its flows meet — the
   *  focal itself, or what it contains. */
  via: string[]
  /** Most partners first, then most flows, then by name. */
  children: PartnerTreeNode[]
}

export interface SidePartners {
  /** Distinct partners — the number the Lens reads. */
  partners: number
  /** Raw hops, or — coarse — the flows the rollup cells summarise. */
  flows: number
  /** Every partner, distinct. */
  partnerUrns: string[]
  /** The partners at the focal's own containment level, distinct. */
  peers: string[]
  /** Only the rollup picture is in hand: partners are containers and the
   *  numbers are the rollups'. */
  coarse: boolean
  /** The partners' systems — every containment root they sit under. */
  roots: PartnerTreeNode[]
}

const NONE: ReadonlySet<string> = new Set()

interface Building {
  urn: string
  node: LensWalkNode | null
  partners: number
  flows: number
  isPartner: boolean
  via: string[]
  children: Map<string, Building>
}

export function partnerName(n: PartnerTreeNode): string {
  return n.node?.displayName || (n.node?.data?.label as string | undefined) || n.urn
}

function freeze(b: Building): PartnerTreeNode {
  const children = [...b.children.values()].map(freeze)
  children.sort((x, y) =>
    y.partners - x.partners || y.flows - x.flows || partnerName(x).localeCompare(partnerName(y)))
  return { urn: b.urn, node: b.node, partners: b.partners, flows: b.flows, isPartner: b.isPartner, via: b.via, children }
}

/**
 * One direction of the focal's lineage as the drawer shows it.
 * `fineSettled` — the walk has finished its raw pages, so an empty raw set
 * is the answer (no lineage that way) and the rollups must not stand in for
 * it.
 */
export function partnersFromWalk(
  model: LensWalkModel,
  side: PartnerSide,
  { fineSettled = false }: { fineSettled?: boolean } = {},
): SidePartners {
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

  const fine = side === 'up' ? model.upstreamUrns : model.downstreamUrns
  const rollups = (side === 'up' ? model.coarseUpstreamUrns : model.coarseDownstreamUrns) ?? NONE
  const coarse = fine.size === 0 && rollups.size > 0 && !fineSettled
  const partnerSet = coarse ? rollups : fine

  // Flows per partner. Raw hops count one each; a rollup cell counts the
  // flows it summarises, and only where no raw hop reaches that partner —
  // a manual model authors its flows AS rollups, and a partner that is both
  // must not count twice.
  const flowsOf = new Map<string, number>()
  const viaOf = new Map<string, Set<string>>()
  /** How far below the focal each flow leaves it — the partner's peer sits
   *  as far above the partner. The shallowest flow decides. */
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
  if (!coarse) {
    for (const e of model.lineageEdges) {
      if (e.kind === 'rollup') continue
      const { near, far } = ends(e)
      if (!scope.has(near) || scope.has(far) || !partnerSet.has(far)) continue
      add(far, near, 1)
      rawReached.add(far)
    }
  }
  for (const e of model.lineageEdges) {
    if (e.kind !== 'rollup') continue
    const { near, far } = ends(e)
    if (!scope.has(near) || scope.has(far) || !partnerSet.has(far) || rawReached.has(far)) continue
    add(far, near, Math.max(1, e.weight ?? 1))
  }

  const nodeBy = new Map<string, LensWalkNode>()
  for (const n of model.nodes) nodeBy.set(n.urn, n)
  const all = new Map<string, Building>()
  const roots = new Map<string, Building>()
  const at = (urn: string): Building => {
    let b = all.get(urn)
    if (!b) {
      b = { urn, node: nodeBy.get(urn) ?? null, partners: 0, flows: 0, isPartner: false, via: [], children: new Map() }
      all.set(urn, b)
    }
    return b
  }

  const peers = new Set<string>()
  const partnerUrns: string[] = []
  let partners = 0
  let flows = 0
  for (const p of partnerSet) {
    // Lineage between two things inside the focal is not a partner of it.
    if (scope.has(p)) continue
    const chain = [...chainOf(p), p]
    const f = flowsOf.get(p) ?? 0
    partners++
    partnerUrns.push(p)
    flows += f
    peers.add(chain[Math.max(0, chain.length - 1 - (stepsOf.get(p) ?? 0))])
    let prev: Building | null = null
    for (const urn of chain) {
      const b = at(urn)
      b.partners++
      b.flows += f
      if (prev) prev.children.set(urn, b)
      else roots.set(urn, b)
      prev = b
    }
    prev!.isPartner = true
    prev!.via = [...(viaOf.get(p) ?? [])]
  }

  const frozen = [...roots.values()].map(freeze)
  frozen.sort((x, y) => y.partners - x.partners || y.flows - x.flows || partnerName(x).localeCompare(partnerName(y)))
  return { partners, flows, partnerUrns, peers: [...peers], coarse, roots: frozen }
}
