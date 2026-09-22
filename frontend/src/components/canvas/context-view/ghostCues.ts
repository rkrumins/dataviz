/**
 * Ghost cues — how the canvas says "there is lineage here you cannot see".
 *
 * Two kinds, both deliberately NOT lines to places the canvas has not drawn
 * (a line to an estimated position read as "a line to nothing" and was taken
 * out once already — see the note at the end of LineageFlowOverlay's
 * updateFlow):
 *
 *   * A PORTAL at the viewport's edge, for a partner that is ON the canvas
 *     but scrolled out of sight sideways. It names where the lineage goes —
 *     the entity and its layer — and a click scrolls there. The ghost line
 *     that leads to it starts at the row, at the row's own height, so a
 *     column of rows produces a stack of level lines, never the fan that
 *     every row converging on one exit point made.
 *   * A STUB beside a row, for lineage whose far end is not on the canvas at
 *     all (never loaded). It cannot say where — nothing is known but the
 *     count — so it says how many, and a click brings a batch of them in.
 *
 * The stub itself is `OffCanvasStub.tsx`; this module holds what the two cues
 * say and how they are sized.
 */

/**
 * What a portal chip says about the partners behind it: the one entity and
 * its layer when there is one, otherwise how many and where.
 */
export function portalLabel(names: readonly string[], total: number, layerNames: readonly string[]): string {
  if (total <= 1 && names[0]) return layerNames[0] ? `${names[0]} · ${layerNames[0]}` : names[0]
  if (layerNames.length === 1) return `${total} in ${layerNames[0]}`
  if (layerNames.length > 1) return `${total} in ${layerNames.length} layers`
  return `${total} entities`
}

/** How many a stub click brings in at once. The count left on the stub goes
 *  down as they arrive, so the next click brings the next batch. */
export const BRING_IN_BATCH = 100

/** Width of a stub — it lives in its row's HALF of the gap between two
 *  columns (48px), so the stub of a row and the stub of its neighbour across
 *  the gap never collide. */
export const OFF_CANVAS_STUB_WIDTH = 22

