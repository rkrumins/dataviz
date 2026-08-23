/**
 * Keeping the details drawer off its own subject (2026-08-22).
 *
 * The drawer is a flex sibling of the board, not a floating panel: opening
 * it takes 420–560 px off the canvas's width, and the columns do not move.
 * So the card at the right edge — very often the one just clicked to open
 * the drawer — ends up outside the visible box, and the reader is reading
 * about an entity they can no longer see.
 *
 * This is the arithmetic of the remedy: the SMALLEST horizontal scroll that
 * clears the row. Not centring — the board should settle, not lurch, and a
 * reader who arranged their view keeps it.
 */

/** The horizontal extent of something, in viewport coordinates (a `DOMRect`
 *  satisfies it). */
export interface Extent {
  left: number
  right: number
}

/**
 * How far to scroll the board horizontally so `row` sits inside `viewport`
 * with `margin` to spare — `0` when it already does. Positive scrolls right
 * (add it to `scrollLeft`); negative scrolls left.
 *
 * A row too wide to fit shows its LEFT edge: that end carries the icon and
 * the name, and a reader who cannot have all of it wants the half that says
 * what it is.
 */
export function shiftToClear(row: Extent, viewport: Extent, margin = 24): number {
  const free = (viewport.right - viewport.left) - margin * 2
  if (row.right - row.left > free) return row.left - (viewport.left + margin)

  const pastRight = (row.right + margin) - viewport.right
  if (pastRight > 0) return pastRight

  const pastLeft = (viewport.left + margin) - row.left
  if (pastLeft > 0) return -pastLeft

  return 0
}
