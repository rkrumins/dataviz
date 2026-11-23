/**
 * CanvasStatusStack — the one place at the top of the canvas that says what
 * the canvas is showing, and what it is doing.
 *
 * WHY ONE PLACE. Every notice up here used to position itself: the trace
 * capsule, the connect pill and the Narrow chip each at `absolute top-3`, so
 * any two of them painted on top of each other, and on top of whatever
 * banner was showing; the Narrow chip at `z-30` beside columns at `z-30`
 * that come later in the page, so the column headers painted over it; and
 * the provider pill, placed by CanvasRouter over the WHOLE canvas, landed on
 * the toolbar's search and menu buttons. A reader saw a notice half-covered,
 * or not at all.
 *
 * Three lanes, one layer (`z-status`, lib/zIndex.ts), each in priority order
 * — the caller passes the most important first, and nothing ever has to share
 * a slot:
 *
 *   * BANNERS (children), full width, in normal flow: the columns are pushed
 *     down rather than covered, as each banner always has been.
 *   * NOTICES — what the canvas is SHOWING (a load that came back short, a
 *     narrowing, a search filtering rows). In flow too, centred under the
 *     banners: they stay up for as long as the state does, and a notice that
 *     floated would sit on the column headers for all of that time.
 *   * ACTIVITY — what the canvas is DOING right now (a trace walking, a link
 *     being drawn). Floats just below the rest, over the top of the columns:
 *     it comes and goes with the gesture, and in flow it would move the board
 *     under the reader's pointer every time it did.
 *
 * Inside the canvas body, so it starts below the toolbar by construction:
 * nothing here can sit over a header button. The lanes take no pointer
 * events themselves; each chip takes its own.
 */
import type { ReactNode } from 'react'

export function CanvasStatusStack({ notices, activity, children }: {
  /** What the canvas is showing — in flow, most important first. */
  notices?: ReactNode
  /** What the canvas is doing — floating, most important first. */
  activity?: ReactNode
  /** The full-width banners. */
  children?: ReactNode
}) {
  return (
    <div data-canvas-status-stack className="relative z-status flex-none flex flex-col">
      {children}
      <div
        data-canvas-status-notices
        className="pointer-events-none flex flex-col items-center gap-2 px-4 pt-2 pb-1 empty:hidden"
      >
        {notices}
      </div>
      <div
        data-canvas-status-activity
        className="pointer-events-none absolute inset-x-0 top-full flex flex-col items-center gap-2 px-4 pt-3"
      >
        {activity}
      </div>
    </div>
  )
}
