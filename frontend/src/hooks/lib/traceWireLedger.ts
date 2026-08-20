/**
 * traceWireLedger — the GRAIN RULE: which of the statements a lineage makes
 * about a pair of cards actually gets drawn.
 *
 * A graph says the same thing many times over. `orders → aov` is a
 * materialised ROLLUP carrying the graph's own count of the flows;
 * `orders.channel → aov.channel` and `orders.net → aov.avg` are the RAW hops
 * it summarises; `INTERMEDIATE_T2 → cfo` is that same rollup again, one
 * containment level up. Draw them all and the reader sees one flow as three
 * lines at three grains — the double-draw that made the old overlay
 * unreadable. Draw none and the lineage is gone.
 *
 * RAW EVIDENCE ALWAYS WINS. The reader opened the dashboard precisely so the
 * wire would land on the chart inside it; answering that with the coarser
 * authored rollup — a line to the dashboard they have already opened past —
 * is the wrong direction. The lineage is redrawn per expansion, so every raw
 * hop the model holds is drawn between the nearest VISIBLE ancestor of each
 * of its endpoints, at whatever grain the reader has earned.
 *
 * ROLLUPS ARE THEN ACCOUNTED FOR, INNER-FIRST — finest cone first, each one
 * asked only what is left to say that nothing inside it has said already:
 *
 *      stated    = R (raw hops in the cone) + inner (already-emitted
 *                  summaries strictly inside it)
 *      remaining = W (the rollup's own count) − stated
 *
 *  • The ledger vouches for the cone's raw detail (and there IS raw detail)
 *    ⇒ dropped. The raw wires carry it, and a W above R is aggregation
 *    staleness rather than a flow the reader is missing.
 *  • Nothing stated inside it yet ⇒ the rollup draws whole (`kind:'rollup'`,
 *    `W`) when the cone holds no raw hops at all — the coarse phase of a
 *    walk, or an estate whose lineage only ever materialises as :AGGREGATED
 *    — or as a RESIDUAL of `max(1, W − R)` when it holds raw hops the ledger
 *    will not vouch for. The floor applies only here, at the finest stated
 *    grain: a pair nobody vouches for always has something left to say.
 *  • Something inside it has already spoken ⇒ only the REMAINDER draws, as a
 *    residual, and nothing at all once the remainder reaches zero. This is
 *    what keeps `orders → aov` and `INTERMEDIATE_T2 → cfo` from stating the
 *    same two flows twice, while still letting the outer cone report a
 *    sibling dataset the inner one says nothing about.
 *
 * CONTAINMENT COMES FROM TWO PLACES, on purpose. The ledger's cone index
 * walks `model.containmentEdges` (first parent wins, cycle-guarded), so a
 * pair's raw count is a fact about the MODEL. The wire builder walks the
 * SUBGRAPH's parents — the same first-parent chain `projectLensEdges`
 * re-anchors along — so what is drawn agrees with what is projected. They
 * differ only for a containment edge the subgraph dropped as dangling.
 *
 * Grain is decided HERE, from edge kinds and this ledger — never from
 * `card.depth` (which is lane-relative and says nothing about grain).
 *
 * STAGE 2 CHECK: the residual floor claims "1 more" even when `W − R` is 0 —
 * right for a pair the ledger will not vouch for, but unreachable in Stage 1
 * (the default ledger vouches for every raw-backed pair), so it wants
 * confirming against real `completePairs`.
 */
import { projectLensEdges, type LensSubgraph, type LensEdgeLike } from '@/components/canvas/context-view/lens/lens-subgraph'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'

export interface TraceWire {
  id: string
  source: string
  target: string
  /** Raw: hops bundled into this line. Rollup/residual: flows summarised. */
  edgeCount: number
  isBundled: boolean
  kind: 'raw' | 'rollup' | 'residual'
  /** Raw: the ledger vouches that this pair's detail is fully loaded. Rollup
   *  and residual: ALWAYS false — a coarse wire is a summary of flows nobody
   *  has drilled into, never settled, whatever the ledger says. */
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

/** Ancestors of `urn`, nearest first, `urn` itself included. Cycle-guarded:
 *  a containment loop stops at the node that closes it. */
function ancestorWalker(parentOf: (urn: string) => string | null): (urn: string) => string[] {
  const cache = new Map<string, string[]>()
  return (urn: string): string[] => {
    const hit = cache.get(urn)
    if (hit) return hit
    const out: string[] = []
    const guard = new Set<string>()
    let cursor: string | null = urn
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor)
      out.push(cursor)
      cursor = parentOf(cursor)
    }
    cache.set(urn, out)
    return out
  }
}

/**
 * What is KNOWN about each pair's raw detail.
 *
 * `rawCount` is a CONE count — raw hops between anything inside the source
 * and anything inside the target — because that is exactly what a rollup
 * between two containers is a statement about. Counting only hops whose
 * endpoints are literally the pair would report 0 for every rollup, since
 * rollups sit at container grain and raw hops at column grain. It is
 * computed once, as an ancestor-pair index over the raw hops (O(E·d²)), and
 * read back as a map lookup — every raw wire asks for it.
 *
 * `completePairs` omitted = Stage 1's standing assumption: the walk model IS
 * the fine closure, so a pair is vouched for exactly when it HAS raw hops.
 * (Vouching for pairs with no raw detail would let a rollup be dropped as
 * redundant against evidence that does not exist.) Stage 2's driver passes
 * the pairs it has actually finished loading, and then a raw-backed pair
 * outside the set reads `partial`.
 *
 * `rawEdges` overrides which hops are counted: pass the SUBGRAPH's resolved
 * edges so the ledger and the projection see exactly the same set. Defaults
 * to the model's own raw edges.
 */
export function buildLedger(
  model: LensWalkModel,
  completePairs?: ReadonlySet<string>,
  rawEdges?: ReadonlyArray<LensEdgeLike>,
): PairLedger {
  const edges = rawEdges ?? model.lineageEdges.filter(e => e.kind !== 'rollup')

  const parentOf = new Map<string, string>()
  // FIRST parent wins, exactly as `buildLensSubgraph` resolves it, so a node
  // with two containment edges climbs the same chain in both.
  for (const c of model.containmentEdges) {
    if (!parentOf.has(c.targetUrn)) parentOf.set(c.targetUrn, c.sourceUrn)
  }
  const ancestorsOrSelf = ancestorWalker(urn => parentOf.get(urn) ?? null)

  const cone = new Map<string, number>()
  for (const e of edges) {
    for (const a of ancestorsOrSelf(e.sourceUrn)) {
      for (const b of ancestorsOrSelf(e.targetUrn)) {
        const key = pairKey(a, b)
        cone.set(key, (cone.get(key) ?? 0) + 1)
      }
    }
  }

  const rawCount = (src: string, dst: string): number => cone.get(pairKey(src, dst)) ?? 0

  return {
    rawCount,
    state: (src, dst) => {
      if (completePairs === undefined) return rawCount(src, dst) > 0 ? 'complete' : 'none'
      if (completePairs.has(pairKey(src, dst))) return 'complete'
      return rawCount(src, dst) > 0 ? 'partial' : 'none'
    },
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

  const ancestorsOrSelf = ancestorWalker(urn => sg.nodes.get(urn)?.parent ?? null)
  /** `inner` sits inside `outer`, or IS it. */
  const within = (inner: string, outer: string): boolean => ancestorsOrSelf(inner).includes(outer)
  /** One contains the other: there is no line to draw between a card and its
   *  own container — it would leave a card and come straight back into it. */
  const nested = (a: string, b: string): boolean => a === b || within(a, b) || within(b, a)
  const depthOf = (urn: string): number => ancestorsOrSelf(urn).length - 1

  const wires: TraceWire[] = []

  // RAW: every hop the model holds, drawn between the nearest VISIBLE
  // ancestor of each of its endpoints — the projection the Lens already
  // ships, so a trace and a lens of the same model draw the same lines.
  // Nothing suppresses these: they are the finest statement on screen.
  for (const bundle of projectLensEdges(sg, new Set(sg.nodes.keys()), visible)) {
    const { sourceUrn: source, targetUrn: target } = bundle
    if (nested(source, target)) continue
    wires.push({
      id: `bundle:${pairKey(source, target)}:raw`,
      source, target,
      edgeCount: bundle.weight,
      isBundled: !bundle.isLeafEdge,
      kind: 'raw',
      complete: ledger.state(source, target) === 'complete',
    })
  }

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

  // INNER-FIRST: the finest cone speaks first, and every coarser one is left
  // accounting for the remainder. `innerStated` carries each emitted count up
  // every ancestor pair above it, so the lookup is O(1) per rollup.
  const ordered = [...rollups.entries()].sort(([aKey, a], [bKey, b]) =>
    (depthOf(b.source) + depthOf(b.target)) - (depthOf(a.source) + depthOf(a.target)) ||
    (aKey < bKey ? -1 : aKey > bKey ? 1 : 0))
  const innerStated = new Map<string, number>()

  for (const [key, { source, target, weight }] of ordered) {
    const raw = ledger.rawCount(source, target)
    if (raw > 0 && ledger.state(source, target) === 'complete') continue   // the raw wires say it all
    const inner = innerStated.get(key) ?? 0
    let edgeCount: number
    let kind: TraceWire['kind']
    if (inner === 0) {
      // The finest stated grain in this cone: the whole rollup when there is
      // no raw detail under it, otherwise what the unvouched raw detail does
      // not show — and never nothing.
      kind = raw > 0 ? 'residual' : 'rollup'
      edgeCount = raw > 0 ? Math.max(1, weight - raw) : weight
    } else {
      // Something inside already said its part; only the remainder is news.
      const remaining = weight - (raw + inner)
      if (remaining <= 0) continue
      kind = 'residual'
      edgeCount = remaining
    }
    wires.push({ id: `bundle:${key}:${kind}`, source, target, edgeCount, isBundled: true, kind, complete: false })
    for (const a of ancestorsOrSelf(source)) {
      for (const b of ancestorsOrSelf(target)) {
        if (a === source && b === target) continue
        const above = pairKey(a, b)
        innerStated.set(above, (innerStated.get(above) ?? 0) + edgeCount)
      }
    }
  }

  return wires.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
