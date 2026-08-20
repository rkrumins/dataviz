/**
 * traceWireLedger — the GRAIN RULE: which of the two statements a lineage
 * makes about a pair of cards actually gets drawn.
 *
 * A graph says the same thing twice. `orders → aov` is a materialised ROLLUP
 * carrying the graph's own count of the flows; `orders.channel → aov.channel`
 * and `orders.net → aov.avg` are the RAW hops that rollup summarises. Draw
 * both and the reader sees two lines for one flow at two grains — the
 * double-draw that made the old overlay unreadable. Draw neither and the
 * lineage is gone.
 *
 * So exactly one wins per pair, and WHICH one is decided by what the reader
 * has actually opened:
 *
 *  • The reader has DRILLED to the raw hops (both endpoints of a hop are
 *    visible cards) ⇒ the raw wires are the finest truth on screen, and the
 *    rollup above them steps aside — unless the ledger will not vouch that
 *    every raw hop under that pair is loaded, in which case the rollup stays
 *    on as a RESIDUAL: "there are W flows here and you can see R of them".
 *  • The reader has NOT drilled ⇒ the authored rollup is the honest
 *    container-grain statement, and a raw hop re-anchored up onto the same
 *    two cards is that same statement made a second time, from a weaker
 *    source (it counts only the hops that happen to be loaded, while the
 *    rollup counts what the graph knows). The rollup wins; the re-anchored
 *    bundle is dropped.
 *  • No rollup at all ⇒ the projected bundle is all there is, and it draws.
 *    (This is the Lens's behaviour, kept: a collapsed estate without
 *    aggregation still shows its wires.)
 *
 * Grain is decided HERE, from edge kinds and this ledger — never from
 * `card.depth` (which is lane-relative and says nothing about grain).
 */
import { projectLensEdges, type LensSubgraph } from '@/components/canvas/context-view/lens/lens-subgraph'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'

export interface TraceWire {
  id: string
  source: string
  target: string
  /** Raw: hops bundled into this line. Rollup/residual: flows summarised. */
  edgeCount: number
  isBundled: boolean
  kind: 'raw' | 'rollup' | 'residual'
  /** The ledger vouches that this pair's raw detail is fully loaded. */
  complete: boolean
}

export type PairState = 'complete' | 'partial' | 'none'

/** Directional: `A>B` and `B>A` are never the same pair. */
export function pairKey(src: string, dst: string): string {
  return `${src}>${dst}`
}

export interface PairLedger {
  state(src: string, dst: string): PairState
  rawCount(src: string, dst: string): number
}

/**
 * What is KNOWN about each pair's raw detail.
 *
 * `rawCount` counts containment-inclusively — the raw hops that live INSIDE
 * the pair, at any grain below it — because a rollup between two containers
 * is a statement about every hop between anything in one and anything in the
 * other. Counting only hops whose endpoints are literally the pair would
 * report 0 for every rollup, since rollups sit at container grain and raw
 * hops at column grain.
 *
 * `completePairs` omitted = Stage 1's standing assumption: the walk model IS
 * the fine closure, so every pair's raw detail is complete. Stage 2's driver
 * passes the pairs it has actually finished loading.
 */
export function buildLedger(model: LensWalkModel, completePairs?: ReadonlySet<string>): PairLedger {
  const childrenOf = new Map<string, string[]>()
  for (const c of model.containmentEdges) {
    childrenOf.set(c.sourceUrn, [...(childrenOf.get(c.sourceUrn) ?? []), c.targetUrn])
  }
  const rawEdges = model.lineageEdges.filter(e => e.kind !== 'rollup')

  const descCache = new Map<string, Set<string>>()
  const descendantsOrSelf = (urn: string): Set<string> => {
    const hit = descCache.get(urn)
    if (hit) return hit
    const out = new Set<string>()
    const stack = [urn]
    while (stack.length > 0) {
      const cursor = stack.pop()!
      if (out.has(cursor)) continue                     // containment-cycle guard
      out.add(cursor)
      for (const kid of childrenOf.get(cursor) ?? []) stack.push(kid)
    }
    descCache.set(urn, out)
    return out
  }

  const countCache = new Map<string, number>()
  const rawCount = (src: string, dst: string): number => {
    const key = pairKey(src, dst)
    const hit = countCache.get(key)
    if (hit !== undefined) return hit
    const from = descendantsOrSelf(src)
    const to = descendantsOrSelf(dst)
    let n = 0
    for (const e of rawEdges) if (from.has(e.sourceUrn) && to.has(e.targetUrn)) n += 1
    countCache.set(key, n)
    return n
  }

  return {
    rawCount,
    state: (src, dst) =>
      completePairs === undefined || completePairs.has(pairKey(src, dst))
        ? 'complete'
        : rawCount(src, dst) > 0 ? 'partial' : 'none',
  }
}

export interface TraceWireInputs {
  sg: LensSubgraph<LensWalkNode>
  model: LensWalkModel
  /** The cards on screen — the wires' only permitted endpoints. */
  visible: ReadonlySet<string>
  ledger: PairLedger
}

/** The wires the canvas draws between the currently visible cards. */
export function buildTraceWires(i: TraceWireInputs): TraceWire[] {
  const { sg, model, visible, ledger } = i

  const ancestorCache = new Map<string, string[]>()
  const ancestorsOrSelf = (urn: string): string[] => {
    const hit = ancestorCache.get(urn)
    if (hit) return hit
    const out: string[] = []
    let cursor: string | null = urn
    const guard = new Set<string>()
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor)
      out.push(cursor)
      cursor = sg.nodes.get(cursor)?.parent ?? null
    }
    ancestorCache.set(urn, out)
    return out
  }
  /** One contains the other: there is no line to draw between a card and its
   *  own container — it would leave a card and come straight back into it. */
  const nested = (a: string, b: string): boolean =>
    a === b || ancestorsOrSelf(a).includes(b) || ancestorsOrSelf(b).includes(a)

  // ROLLUPS are never re-anchored: a rollup is an authored statement about
  // two specific nodes, so it draws where it was authored or not at all.
  const rollups = new Map<string, { source: string; target: string; weight: number }>()
  for (const e of model.lineageEdges) {
    if (e.kind !== 'rollup') continue
    if (!visible.has(e.sourceUrn) || !visible.has(e.targetUrn)) continue
    if (nested(e.sourceUrn, e.targetUrn)) continue
    const key = pairKey(e.sourceUrn, e.targetUrn)
    const seen = rollups.get(key)
    // Several rollup edges at the same endpoints only happen when the model
    // holds duplicates; their weights are one statement about one pair.
    if (seen) seen.weight += e.weight ?? 1
    else rollups.set(key, { source: e.sourceUrn, target: e.targetUrn, weight: e.weight ?? 1 })
  }

  // DRILLED hops: raw hops the reader can see BOTH ends of. These — and only
  // these — are finer than a rollup, so only these retire one.
  const drilledAt = new Map<string, number>()          // at their own pair
  const drilledUnder = new Map<string, number>()       // inside a rollup's pair
  for (const hop of sg.lineageEdges) {
    if (!visible.has(hop.sourceUrn) || !visible.has(hop.targetUrn)) continue
    const own = pairKey(hop.sourceUrn, hop.targetUrn)
    drilledAt.set(own, (drilledAt.get(own) ?? 0) + 1)
    if (rollups.size === 0) continue
    for (const s of ancestorsOrSelf(hop.sourceUrn)) {
      for (const t of ancestorsOrSelf(hop.targetUrn)) {
        const key = pairKey(s, t)
        if (rollups.has(key)) drilledUnder.set(key, (drilledUnder.get(key) ?? 0) + 1)
      }
    }
  }

  const wires: TraceWire[] = []
  const drawnRollups = new Set<string>()
  for (const [key, { source, target, weight }] of rollups) {
    const drilled = drilledUnder.get(key) ?? 0
    if (drilled > 0 && ledger.state(source, target) === 'complete') continue   // the raw wires say it all
    drawnRollups.add(key)
    const kind = drilled > 0 ? 'residual' : 'rollup'
    // A residual is what the raw wires do NOT show: the rollup's own count
    // less the detail already loaded, and never nothing (a pair the ledger
    // will not vouch for always has something left to say).
    const edgeCount = drilled > 0 ? Math.max(1, weight - ledger.rawCount(source, target)) : weight
    wires.push({ id: `bundle:${key}:${kind}`, source, target, edgeCount, isBundled: true, kind, complete: false })
  }

  // RAW: each hop drawn between the nearest VISIBLE ancestor of each of its
  // endpoints — the projection the Lens already ships, so a trace and a lens
  // of the same model draw the same lines.
  const population = new Set(model.nodes.map(n => n.urn))
  for (const bundle of projectLensEdges(sg, population, visible)) {
    const { sourceUrn: source, targetUrn: target } = bundle
    if (nested(source, target)) continue
    const key = pairKey(source, target)
    // Re-anchored (nothing drilled at this pair) and a rollup already speaks
    // for these two cards: same statement, and the rollup's count is the
    // graph's rather than whatever happens to be loaded.
    if ((drilledAt.get(key) ?? 0) === 0 && coveredBy(drawnRollups, ancestorsOrSelf(source), ancestorsOrSelf(target))) continue
    wires.push({
      id: `bundle:${key}:raw`,
      source, target,
      edgeCount: bundle.weight,
      isBundled: !bundle.isLeafEdge,
      kind: 'raw',
      complete: ledger.state(source, target) === 'complete',
    })
  }

  return wires.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function coveredBy(drawnRollups: ReadonlySet<string>, sources: string[], targets: string[]): boolean {
  for (const s of sources) for (const t of targets) if (drawnRollups.has(pairKey(s, t))) return true
  return false
}
