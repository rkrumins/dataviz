/**
 * Which way a hidden row lies — the arrow on "↑/↓ N lines" and the tray a
 * line docks to.
 *
 * Read against the row's OWN column: its list's viewport, which starts below
 * the column's sticky header and ends above the band the bottom chrome
 * reserves, cut to the part of the canvas on screen. Reading it against the
 * whole canvas scroller instead put a row hidden under its header (or in the
 * band) INSIDE the box, where a guess from the visible end's height called
 * rows just above the header "down" — so a column scrolled to its very end
 * went on saying "↓ 7 more", and the click scrolled to a row already in view.
 *
 * Pure, and cheap enough for the overlay's per-frame pass.
 */
import type { OverflowDirection } from './types'

export interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

/** A row's rect, as the DOM or the column geometry gives it. */
export interface RowRect {
  top: number
  height: number
  left: number
  right: number
}

/** A column's visible box: its list's own viewport, cut to the canvas's. A
 *  column scrolled sideways off the canvas comes out empty (left past right),
 *  which classifies its rows as off to that side. */
export function columnVisibleRect(list: Box, canvas: Box): Box {
  return {
    top: Math.max(list.top, canvas.top),
    bottom: Math.min(list.bottom, canvas.bottom),
    left: Math.max(list.left, canvas.left),
    right: Math.min(list.right, canvas.right),
  }
}

/**
 * Where `row` lies relative to `visible` (its column's visible box), by its
 * centre — the further-out axis wins, so a column scrolled sideways gets
 * left/right rather than a meaningless up/down. `null` when the centre is in
 * the box: the row is on screen, and nothing is hidden to point at.
 */
export function classifyHiddenEnd(row: RowRect, visible: Box): OverflowDirection | null {
  const x = (row.left + row.right) / 2
  const y = row.top + row.height / 2
  const dx = x < visible.left ? x - visible.left : x > visible.right ? x - visible.right : 0
  const dy = y < visible.top ? y - visible.top : y > visible.bottom ? y - visible.bottom : 0
  if (dx === 0 && dy === 0) return null
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'up' : 'down'
  return dx < 0 ? 'left' : 'right'
}
