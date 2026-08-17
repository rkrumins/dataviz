/**
 * condensation — T23 R2's PASS-THROUGH CONDENSATION: a maximal run of
 * degree-1 entity cards IN THE DRAWN PICTURE collapses to one connector
 * chip ("— via N steps —▶"), which unfolds inline the instant it's
 * clicked (the steps are already in the model — only the DRAWN set
 * changes) and re-condenses via an explicit control on the run's own
 * boundary card.
 *
 * A pure post-pass over an already-built `FocusGraph`: it never touches
 * population, grain or rank, so a run's own drawn identity (and
 * everything downstream of it — the isolation cone) survives folding and
 * unfolding for free. (T28 R3 removed the sliding window that used to
 * run after this stage and fold bands past a fixed radius — the board
 * just grows now; condensation is the only thing left that ever
 * collapses drawn cards.)
 */
import { holdsRows, type FocusCard, type FocusEdge, type FocusGraph } from './focus-cards'

/** A run shorter than this reads as one ordinary hop, not clutter —
 *  condensing it would trade a legible wire for a chip that says almost
 *  nothing "— via 1 step —▶" doesn't already show as a plain arrow. */
export const MIN_CONDENSE_RUN = 2

const connectorId = (a: string, b: string): string => `condense:${a}>${b}`

/** Eligible to be swallowed into a run: a FREE-STANDING ordinary entity
 *  card — never the focal (the thing being asked about is never chrome),
 *  never a row-holding card (a frame's rows are its own answer, not a
 *  corridor to fold past), and never a card that lives INSIDE a frame.
 *
 *  That last one is not symmetry: a frame is drawn from its rows, so
 *  folding its only row away leaves the frame itself on the board with
 *  an empty body under a header still claiming "1 on this lineage · of
 *  12" — reported live, and with no card left to click, the connector
 *  chip (which lands mid-wire, inside whatever frame the wire crosses)
 *  became the only way onward. A run of corridors between top-level
 *  cards is what this fold was for. */
const eligible = (c: FocusCard): boolean =>
  c.kind === 'entity' && !holdsRows(c) && c.frameId === null

/**
 * Collapse every maximal run of degree-1 pass-through cards not
 * explicitly held open in `condensedOpen` (a connector id — see
 * `connectorId` — recorded once a reader unfolds it; sticky per view
 * state, same as every other lens-local edit).
 */
export function applyCondensation(
  graph: FocusGraph,
  condensedOpen: ReadonlySet<string>,
): FocusGraph {
  const byId = new Map(graph.cards.map(c => [c.id, c]))
  const outEdge = new Map<string, FocusEdge>()
  const inEdge = new Map<string, FocusEdge>()
  const outCount = new Map<string, number>()
  const inCount = new Map<string, number>()
  for (const e of graph.edges) {
    outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1)
    inCount.set(e.target, (inCount.get(e.target) ?? 0) + 1)
    outEdge.set(e.source, e)
    inEdge.set(e.target, e)
  }

  const isPassThrough = (id: string): boolean => {
    const c = byId.get(id)
    if (!c || !eligible(c)) return false
    return (outCount.get(id) ?? 0) === 1 && (inCount.get(id) ?? 0) === 1
  }

  // Walk every maximal run exactly once: start only from a pass-through
  // card whose OWN predecessor is not itself pass-through (a true run
  // head), so an interior card is never re-walked as a second run.
  const consumed = new Set<string>()
  interface Run { boundaryA: string; interior: string[]; boundaryB: string; edges: FocusEdge[] }
  const runs: Run[] = []
  for (const c of graph.cards) {
    if (!isPassThrough(c.id) || consumed.has(c.id)) continue
    const head = inEdge.get(c.id)!.source
    if (isPassThrough(head) && !consumed.has(head)) continue   // not a run head
    const interior: string[] = []
    const runEdges: FocusEdge[] = [inEdge.get(c.id)!]
    let cursor = c.id
    while (isPassThrough(cursor) && !consumed.has(cursor)) {
      consumed.add(cursor)
      interior.push(cursor)
      const next = outEdge.get(cursor)!
      runEdges.push(next)
      cursor = next.target
    }
    runs.push({ boundaryA: head, interior, boundaryB: cursor, edges: runEdges })
  }

  const foldable = runs.filter(r => r.interior.length >= MIN_CONDENSE_RUN)
  if (foldable.length === 0) return graph

  const hideCardIds = new Set<string>()
  const hideEdgeIds = new Set<string>()
  const newEdges: FocusEdge[] = []
  const condenseRunByCard = new Map<string, { connectorId: string; dir: 'in' | 'out'; steps: number }>()

  for (const run of foldable) {
    const id = connectorId(run.boundaryA, run.boundaryB)
    if (condensedOpen.has(id)) {
      // Unfolded: draw the run exactly as the layout built it — but the
      // BOUNDARY card carries the re-condense control back.
      const a = byId.get(run.boundaryA)
      const dir: 'in' | 'out' = a && a.band <= (byId.get(run.boundaryB)?.band ?? 0) ? 'out' : 'in'
      condenseRunByCard.set(run.boundaryA, { connectorId: id, dir, steps: run.interior.length })
      continue
    }
    for (const cardId of run.interior) hideCardIds.add(cardId)
    let count = 0
    let edgeTypeNorm = run.edges[0]?.edgeTypeNorm ?? ''
    for (const e of run.edges) {
      hideEdgeIds.add(e.id)
      count += e.count
      if (e.edgeTypeNorm !== edgeTypeNorm) edgeTypeNorm = ''
    }
    newEdges.push({
      id: `${id}:edge`,
      source: run.boundaryA,
      target: run.boundaryB,
      count,
      edgeTypeNorm,
      dimmed: false,
      cycleBack: false,
      cycleAnchor: false,
      // The chip is its own label — never a competing ×N in the same slot.
      labelVisible: false,
      labelT: 0.5,
      grainCoarse: false,
      sameAncestorFrame: null,
      seamSlotted: false,
      condensed: { connectorId: id, steps: run.interior.length },
    })
  }

  const cards = graph.cards
    .filter(c => !hideCardIds.has(c.id))
    .map(c => (condenseRunByCard.has(c.id) ? { ...c, condenseRun: condenseRunByCard.get(c.id) } : c))
  const edges = [
    ...graph.edges.filter(e => !hideEdgeIds.has(e.id)),
    ...newEdges,
  ]

  return { ...graph, cards, edges }
}
