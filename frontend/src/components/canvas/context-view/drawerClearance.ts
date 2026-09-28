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

/**
 * Once the drawer has finished opening — the board's width has stopped moving — scroll the board by
 * the least that shows every one of `rowIds`: the entity the drawer is about, or both ends of the
 * line it is open on. A row not rendered is left to the reveal paths. Returns the cancel.
 */
export function keepClearOfDrawer(container: HTMLElement, rowIds: readonly string[]): () => void {
  let frame = 0
  let width = -1
  let still = 0
  let frames = 0
  const whenSettled = () => {
    const now = container.clientWidth
    still = now === width ? still + 1 : 0
    width = now
    frames += 1
    // Three identical frames means the width has stopped moving — which is
    // true immediately when the drawer merely swapped subjects and never
    // resized. The frame cap keeps a window being dragged from holding
    // this open indefinitely.
    if (still < 3 && frames < 60) { frame = requestAnimationFrame(whenSettled); return }
    const rects = rowIds
      .map((id) => document.getElementById(`layer-node-${id}`)?.getBoundingClientRect())
      .filter((r): r is DOMRect => !!r)
    if (rects.length === 0) return            // off-window: the reveal paths own that
    const extent = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)) }
    const shift = shiftToClear(extent, container.getBoundingClientRect())
    if (shift !== 0) container.scrollLeft += shift
  }
  frame = requestAnimationFrame(whenSettled)
  return () => cancelAnimationFrame(frame)
}
