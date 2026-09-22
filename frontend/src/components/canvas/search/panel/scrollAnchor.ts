/**
 * Scroll anchoring for the results list.
 *
 * "Load all" walks the cursor to the end one page at a time, and every
 * committed page re-derives the whole grouping: groups sort by the canvas's
 * COLUMN order rather than by arrival, and a hit for a container already on
 * screen is appended inside it. Both put new rows ABOVE the fold, so the
 * list slid down under whoever was reading it — the row they had just
 * clicked walked off the screen.
 *
 * The keys were never the problem (the virtualizer already keys rows by urn).
 * The fix is to pin the viewport to a row and put it back where it was once
 * the new rows have landed.
 *
 * Pure: no React, no virtualizer types — just the arithmetic, so it can be
 * tested without a scroller.
 */

export interface ScrollAnchor {
  /** The row the viewport is pinned to. */
  key: string
  /**
   * Where that row sat relative to the top of the viewport when captured.
   * Usually negative or zero: the first visible row typically starts just
   * above the fold.
   */
  offset: number
}

/** The shape this module needs from a virtual row. `key` is widened to the
 *  virtualizer's own `Key` (it allows a bigint) and stringified on capture,
 *  so the anchor can be matched back by value later. */
export interface AnchorCandidate {
  key: string | number | bigint
  start: number
  end: number
}

/**
 * Pin to the first row that is at least partly visible.
 *
 * Returns null at the very top of the list: a reader sitting at the top
 * means to be at the top, and holding them there is what a browser's own
 * scroll anchoring does. Anything else would push the newest rows out of
 * sight the moment they arrive.
 */
export function captureAnchor(
  items: readonly AnchorCandidate[],
  scrollTop: number,
): ScrollAnchor | null {
  if (scrollTop <= 0) return null
  for (const item of items) {
    if (item.end > scrollTop) {
      return { key: String(item.key), offset: item.start - scrollTop }
    }
  }
  return null
}

/**
 * Where the scroller has to go for `anchor` to sit where it did.
 *
 * `startOf` resolves the row's NEW offset within the list; null when the row
 * is gone (a filter changed, a group collapsed) — and a row that no longer
 * exists cannot be held still, so nothing is adjusted.
 */
export function restoreScrollTop(
  anchor: ScrollAnchor | null,
  startOf: (key: string) => number | null,
): number | null {
  if (!anchor) return null
  const start = startOf(anchor.key)
  if (start === null) return null
  return Math.max(0, start - anchor.offset)
}
