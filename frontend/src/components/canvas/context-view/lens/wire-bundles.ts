/**
 * Wire bundles — which member wires come back, and for what.
 *
 * The layout folds a wall of wires between two containers into ONE bundle
 * (`FocusEdge.bundle`) and keeps the members aside in
 * `FocusGraph.bundledWires`. The detail is a gesture away: a card the
 * reader hovers or selects gets its own wires drawn again; a frame gets
 * every wire of every row inside it; a bundle hovered on the board fans
 * out into all of its members. Pure — the view asks, the answer is a list.
 */
import type { FocusEdge } from './focus-cards'

export interface RevealAnchors {
  /** Cards (rows, cards or frames) the reader is on. */
  cards: ReadonlySet<string>
  /** Bundle edge ids the reader is on. */
  bundles: ReadonlySet<string>
}

/**
 * The members to draw for these anchors. `frameChainOf` lists a card's
 * enclosing frames innermost-first, so an anchor that is a frame reveals
 * every wire of every card under it.
 */
export function revealedWires(
  bundledWires: readonly FocusEdge[],
  anchors: RevealAnchors,
  frameChainOf: (cardId: string) => readonly string[],
): FocusEdge[] {
  if (bundledWires.length === 0) return []
  if (anchors.cards.size === 0 && anchors.bundles.size === 0) return []
  const touches = (cardId: string): boolean => {
    if (anchors.cards.has(cardId)) return true
    for (const host of frameChainOf(cardId)) if (anchors.cards.has(host)) return true
    return false
  }
  return bundledWires.filter(w =>
    (w.inBundle !== undefined && anchors.bundles.has(w.inBundle)) || touches(w.source) || touches(w.target),
  )
}
