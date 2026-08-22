/**
 * The board-wide filter, applied over a finished board (2026-08-22).
 *
 * MEASURED on the wide table (505 cards, 1,600px): every keystroke in
 * "Filter connections…" re-ran the whole layout pipeline — mean 325 ms
 * of blocked main thread per letter, worst 360 ms, which is exactly the
 * "laggy when browsing" report. But the filter changes NOTHING
 * structural: no population, no geometry, no count, no wire. It only
 * says which cards are the answer and which are background — `dimmed`.
 *
 * So the board is laid out once WITHOUT it (the expensive part, and now
 * independent of what is typed) and this pass dims the result: one loop
 * over the drawn cards, one over the wires. An empty filter returns the
 * very same object, so a board nobody has filtered pays nothing at all.
 *
 * Dimming only ever ADDS: a card a frame's own Find already dimmed stays
 * dimmed. A wire is background only when BOTH of its ends are — an
 * answer keeps its connections lit, which is the rule the layout itself
 * used.
 */
import type { FocusCard, FocusEdge, FocusGraph } from './focus-cards'

export function applyQueryDimming(graph: FocusGraph, query: string): FocusGraph {
  const needle = query.trim().toLowerCase()
  if (needle === '') return graph

  const cards: FocusCard[] = graph.cards.map(c => {
    const dimmed = c.dimmed || !c.label.toLowerCase().includes(needle)
    return dimmed === c.dimmed ? c : { ...c, dimmed }
  })
  const dimById = new Map(cards.map(c => [c.id, c.dimmed]))
  const dimEdge = (e: FocusEdge): FocusEdge => {
    const dimmed = (dimById.get(e.source) ?? false) && (dimById.get(e.target) ?? false)
    return dimmed === e.dimmed ? e : { ...e, dimmed }
  }
  return {
    ...graph,
    cards,
    edges: graph.edges.map(dimEdge),
    bundledWires: graph.bundledWires.map(dimEdge),
  }
}
