/**
 * The app's layering scale — one ladder, named by what sits on each rung.
 *
 * Every number here is the one the app already used for that kind of surface,
 * so naming them changed nothing on screen. What naming them changes is the
 * next surface: it picks a rung instead of a number, and two surfaces that
 * must not collide can no longer end up on the same one by accident. That is
 * how the top of the Context View came to hide its own notices — the Narrow
 * chip sat at `z-30` beside columns at `z-30` that come later in the page, so
 * the column headers painted over it, and the provider pill (`z-40`) was
 * positioned over the whole canvas, its toolbar included.
 *
 * `tailwind.config.js` builds its `zIndex` theme from this object, so the
 * classes (`z-status`, `z-chrome` …) and these constants are the same numbers
 * by construction. Use the constant only for an inline style; a class is
 * otherwise the house way.
 */
export const Z_INDEX = {
  /** The layer columns and their cards: above the lineage overlay's hit layer
   *  (z-20) so a card wins the pointer over a line passing under it. */
  canvas: 30,
  /** Floating canvas chrome: the bottom-right dock, the trace dock, the frame
   *  pills. */
  chrome: 40,
  /** The status stack at the top of the canvas: what the canvas is doing or
   *  showing (a trace running, a narrowing, a load that came back
   *  incomplete). Above the columns and the chrome — a notice the reader
   *  cannot see might as well not be there. */
  status: 45,
  /** First-run coachmarks, portaled and fixed to the viewport. */
  coach: 50,
  /** The notification stack. */
  toast: 80,
  /** Menus and popovers portaled to the document body. */
  popover: 1000,
  /** HoverTip — above any popover it explains a control inside of. */
  tooltip: 9998,
  /** A guided tour: above everything, tooltips included. */
  tour: 9999,
} as const

export type ZLayer = keyof typeof Z_INDEX
