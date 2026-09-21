/**
 * Where a lineage line leaves its source card, where it lands, and the curve
 * between them.
 *
 * A line joins the two sides that FACE each other. A target in a column to the
 * right is reached from the source's right side onto the target's left; a
 * target to the LEFT, from the source's left side onto the target's right. The
 * overlay used to leave every line by the right side and land it on the left,
 * so a line flowing right-to-left set off rightwards, turned back across its
 * own column and every column between, and came round to the far side of its
 * target — a loop per line. The "reverse-flow" arc added later only sent those
 * loops UNDER the rows, where a dense view piled them into a band. Facing sides
 * need neither: every curve stays between its two cards.
 *
 * Two rows of the same column have no facing sides; their line bows through a
 * lane in the column's left gutter.
 *
 * Coordinates are the overlay container's (card rects already offset by it).
 */

// Same-column lines route through a left lane. Lane `index`'s leftmost control
// point sits at node.left - SAME_COLUMN_LANE_START - (BASE + index * STEP).
// Exported so the canvas can reserve a matching scroll-content gutter
// (EXTREMITY_EDGE_GUTTER_PX) and the two stay in sync.
export const SAME_COLUMN_LANE_START = 6
export const SAME_COLUMN_LANE_BASE = 24
export const SAME_COLUMN_LANE_STEP = 8
// Horizontal gutter reserved on each side of the layer columns so the
// outermost same-column lanes (and the rightmost columns' outgoing-edge
// starts) aren't clipped by the overflow-auto scroll container. Sized to
// keep the first 4 lanes unclipped (≈ 62px).
export const EXTREMITY_EDGE_GUTTER_PX =
  SAME_COLUMN_LANE_START + SAME_COLUMN_LANE_BASE + SAME_COLUMN_LANE_STEP * 4

/** Room between a card's edge and where its line starts (the source dot). */
const EXIT_GAP_PX = 6
/** Room between a card's edge and the arrowhead pointing into it. */
const ENTRY_GAP_PX = 8
/** Cards whose left edges are this close share a column. */
const SAME_COLUMN_PX = 50

export interface RowBox {
  left: number
  right: number
  top: number
  height: number
}

export interface LineRoute {
  pathD: string
  sx: number
  sy: number
  tx: number
  ty: number
}

/**
 * @param lane  the line's index among lines sharing a lane (`groupIndex`), so
 *              parallel lines in a gutter or above a row band do not overlap
 * @param isSelf the line starts and ends on the same card
 */
export function routeLine(s: RowBox, t: RowBox, lane: number, isSelf = false): LineRoute {
  const sMid = s.top + s.height / 2
  const tMid = t.top + t.height / 2

  if (!isSelf && Math.abs(s.left - t.left) < SAME_COLUMN_PX) {
    const sx = s.left - SAME_COLUMN_LANE_START
    const tx = t.left - SAME_COLUMN_LANE_START
    const bow = -(SAME_COLUMN_LANE_BASE + lane * SAME_COLUMN_LANE_STEP)
    return {
      pathD: `M ${sx} ${sMid} C ${sx + bow} ${sMid}, ${tx + bow} ${tMid}, ${tx} ${tMid}`,
      sx, sy: sMid, tx, ty: tMid,
    }
  }

  const rightward = t.left + t.right >= s.left + s.right
  const dir = rightward ? 1 : -1
  const sx = rightward ? s.right + EXIT_GAP_PX : s.left - EXIT_GAP_PX
  const tx = rightward ? t.left - ENTRY_GAP_PX : t.right + ENTRY_GAP_PX

  // Same row band in two columns: a plain curve would cut straight through
  // whatever card sits between them. Rightward lines take a lane above the
  // band and leftward ones a lane below, so the two directions never share
  // one; each end sits a little off-centre toward its lane.
  if (!isSelf && Math.abs(s.top - t.top) < Math.min(s.height, t.height) * 0.5) {
    const lift = -dir * (28 + lane * 6)
    const sy = sMid - dir * s.height * 0.18
    const ty = tMid - dir * t.height * 0.18
    const reach = Math.max(40, Math.abs(tx - sx) * 0.3)
    return {
      pathD: `M ${sx} ${sy} C ${sx + dir * reach} ${sy + lift}, ${tx - dir * reach} ${ty + lift}, ${tx} ${ty}`,
      sx, sy, tx, ty,
    }
  }

  const spread = Math.max(Math.abs(tx - sx) * 0.5, 24)
  return {
    pathD: `M ${sx} ${sMid} C ${sx + dir * spread} ${sMid}, ${tx - dir * spread} ${tMid}, ${tx} ${tMid}`,
    sx, sy: sMid, tx, ty: tMid,
  }
}
