/**
 * hop-window — T23 R1's SLIDING WINDOW: the board draws only a span of
 * hop columns around a center; everything further folds into one
 * terminal chip per side.
 *
 * A pure post-pass over an already-built `FocusGraph` — never touches
 * `buildFocusLayout`. That keeps the population/grain/pill machinery
 * (already the most fragile file in this feature) byte-for-byte
 * untouched, and it is what makes "rank/grain stability survive window
 * moves" free: the window never un-admits anything, never changes a
 * card's `drawnRank`, never reruns the answer-grain walk. It only
 * decides, for THIS render, which already-computed cards get drawn and
 * which get folded — moving the window back to a column the reader has
 * already seen shows it exactly as it was.
 *
 * `HopRail` (FocusGraphView.tsx) always reads the UNWINDOWED graph — the
 * rail's own contract is "the WHOLE fetched extent" — so the window only
 * ever affects what `applyHopWindow`'s OUTPUT feeds the board.
 */
import { BAND_GAP, CARD_H, CARD_W, type FocusCard, type FocusEdge, type FocusGraph } from './focus-cards'

/** Hop columns the board draws at once when a walk outgrows one glance.
 *  Centered odd count: the focal's own column plus three each side. */
export const HOP_WINDOW = 7

/** A card's TOP-LEVEL band — mirrors `focus-layout.ts`'s own
 *  `topLevelBandOf`: a frame's children ride its band, never their own,
 *  so a folded frame folds every row inside it as one unit. */
function topLevelBandOf(byId: Map<string, FocusCard>, cardId: string): number {
  let cursor = byId.get(cardId)
  let guard = 0
  while (cursor?.frameId && guard++ < 32) cursor = byId.get(cursor.frameId)
  return cursor?.band ?? 0
}

/** The full band range the fetched extent actually draws, top-level
 *  cards only (frame children ride their host's band). `null` when the
 *  board is empty. */
export function bandRangeOf(graph: FocusGraph): { min: number; max: number } | null {
  let min: number | null = null
  let max: number | null = null
  for (const c of graph.cards) {
    if (c.frameId) continue
    if (min === null || c.band < min) min = c.band
    if (max === null || c.band > max) max = c.band
  }
  if (min === null || max === null) return null
  return { min, max }
}

const foldCard = (
  id: string, band: number, dir: 'in' | 'out', hops: number, cards: number, connections: number, y: number,
): FocusCard => ({
  id, kind: 'fold', nodeId: null, band,
  // Same `band * (CARD_W + BAND_GAP)` every ordinary card's `x` comes
  // from (focus-layout.ts) — a hardcoded 0 here landed every fold chip
  // at the flow origin, right on top of whatever card the focal itself
  // occupies (reproduced via a real screenshot, not assumed: the first
  // shot of this fixture showed both chips' text stacked illegibly
  // inside the focal card's own body).
  x: band * (CARD_W + BAND_GAP), y, w: CARD_W, h: CARD_H,
  label: dir === 'in' ? 'Further upstream' : 'Further downstream',
  description: null, freshness: null, type: 'not loaded',
  parentId: null, parentLabel: null, count: connections, flowsIn: 0, flowsOut: 0,
  showType: false, edgeTypeNorm: '', frameId: null, depth: 0,
  frameEmpty: false, connected: false, frameShowingAll: false, frameConnectedCount: 0,
  frameLoaded: 0, frameTotal: -1, frameHasMore: false,
  frameSearchedCount: 0, frameSearchedExact: true, frameSharedEdgeType: '',
  ancestry: [], ancestryIds: [],
  frameOffset: 0, frameWindowSize: 0, frameRows: [],
  canOpenChildren: false, childrenOpen: false, expandKey: null, expanded: false,
  wired: true, deadEnd: false, fetch: null, dimmed: false,
  pillUp: null, pillDown: null, contents: null,
  fold: { dir, hops, cards, connections },
})

/**
 * Fold everything outside `[center - radius, center + radius]` into one
 * terminal chip per side. `center` null defaults to the focal's own
 * column (band 0) — a walk the reader has not yet steered the window on
 * opens centered on what they asked about, same as the layout itself
 * always has.
 *
 * `radius` (T25 B) is the depth control's own preset — defaults to
 * `HOP_WINDOW`'s original fixed radius (3) for every caller that does
 * not carry a per-focal one (every existing test, the visual harness).
 *
 * A no-op (returns `graph` unchanged) whenever the fetched extent
 * already fits the window — every fixture shy of `walkLongChain` never
 * pays for this pass at all.
 */
export function applyHopWindow(
  graph: FocusGraph,
  center: number | null,
  radius: number = (HOP_WINDOW - 1) / 2,
): { graph: FocusGraph; window: { min: number; max: number } | null } {
  const range = bandRangeOf(graph)
  if (!range || range.max - range.min + 1 <= radius * 2 + 1) return { graph, window: null }

  const RADIUS = radius
  const focus = center ?? 0
  let lo = focus - RADIUS
  let hi = focus + RADIUS
  // Clamp to the fetched extent, then re-expand the SHORT side so a
  // window near an edge still shows a full HOP_WINDOW of columns rather
  // than shrinking — the reader asked to see 7, not "up to 7".
  if (lo < range.min) { hi += range.min - lo; lo = range.min }
  if (hi > range.max) { lo -= hi - range.max; hi = range.max }
  lo = Math.max(range.min, lo)
  hi = Math.min(range.max, hi)

  const byId = new Map(graph.cards.map(c => [c.id, c]))
  const topBand = (id: string) => topLevelBandOf(byId, id)

  const kept: FocusCard[] = []
  const foldedUpIds = new Set<string>()
  const foldedDownIds = new Set<string>()
  let foldedUpHops = 0, foldedUpConnections = 0
  let foldedDownHops = 0, foldedDownConnections = 0
  const seenUpBands = new Set<number>()
  const seenDownBands = new Set<number>()

  for (const card of graph.cards) {
    const band = card.frameId ? topBand(card.frameId) : card.band
    if (band >= lo && band <= hi) { kept.push(card); continue }
    if (band < lo) {
      foldedUpIds.add(card.id)
      if (!card.frameId && !seenUpBands.has(band)) { seenUpBands.add(band); foldedUpHops++ }
    } else {
      foldedDownIds.add(card.id)
      if (!card.frameId && !seenDownBands.has(band)) { seenDownBands.add(band); foldedDownHops++ }
    }
  }
  // Cards folded, counted once per ENTITY — a frame is one card however
  // many rows it holds, matching how the rail/band headers already count.
  const foldedUpCards = graph.cards.filter(c => !c.frameId && foldedUpIds.has(c.id)).length
  const foldedDownCards = graph.cards.filter(c => !c.frameId && foldedDownIds.has(c.id)).length

  if (foldedUpIds.size === 0 && foldedDownIds.size === 0) return { graph, window: null }

  const edges: FocusEdge[] = []
  for (const e of graph.edges) {
    const sUp = foldedUpIds.has(e.source), sDown = foldedDownIds.has(e.source)
    const tUp = foldedUpIds.has(e.target), tDown = foldedDownIds.has(e.target)
    if (sUp || tUp) {
      // Both ends folded away, or one end reroutes to the fold chip
      // (below) — either way this exact edge is not drawn as-is; the
      // chip states the connection count instead.
      foldedUpConnections += e.count
      continue
    }
    if (sDown || tDown) {
      foldedDownConnections += e.count
      continue
    }
    edges.push(e)
  }
  // A card sitting exactly on the window's own edge, wired to a folded
  // neighbour, keeps its OWN wire into the window silently dropped above
  // — reroute it into the chip instead, so the chip reads as where the
  // board's own wires actually lead rather than as a disconnected label.
  for (const e of graph.edges) {
    const sUp = foldedUpIds.has(e.source), tUp = foldedUpIds.has(e.target)
    const sDown = foldedDownIds.has(e.source), tDown = foldedDownIds.has(e.target)
    if (sUp && !tUp && !foldedDownIds.has(e.target)) {
      edges.push({ ...e, id: `${e.id}|fold:in`, source: 'fold:in', condensed: null })
    } else if (tUp && !sUp && !foldedDownIds.has(e.source)) {
      edges.push({ ...e, id: `${e.id}|fold:in`, target: 'fold:in', condensed: null })
    } else if (sDown && !tDown && !foldedUpIds.has(e.target)) {
      edges.push({ ...e, id: `${e.id}|fold:out`, source: 'fold:out', condensed: null })
    } else if (tDown && !sDown && !foldedUpIds.has(e.source)) {
      edges.push({ ...e, id: `${e.id}|fold:out`, target: 'fold:out', condensed: null })
    }
  }

  // The focal's OWN row — a chip is a continuation of the same spine the
  // reader was reading along, not a new row of its own. Falls back to 0
  // (the layout's own baseline) on the one caller with no focal card at
  // all (a harness graph built by hand).
  const focalY = graph.cards.find(c => c.kind === 'focal')?.y ?? 0
  if (foldedUpIds.size > 0) {
    kept.push(foldCard('fold:in', lo - 1, 'in', foldedUpHops, foldedUpCards, foldedUpConnections, focalY))
  }
  if (foldedDownIds.size > 0) {
    kept.push(foldCard('fold:out', hi + 1, 'out', foldedDownHops, foldedDownCards, foldedDownConnections, focalY))
  }

  return {
    graph: { ...graph, cards: kept, edges },
    window: { min: lo, max: hi },
  }
}
