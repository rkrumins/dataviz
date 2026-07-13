import { useEffect, useState, type RefObject } from 'react'

/**
 * True when an element's text is ACTUALLY being clipped by `truncate` /
 * `text-ellipsis`.
 *
 * Measured, never assumed — and that is the whole point. It lets a tooltip
 * exist ONLY when it has something to say. A blanket `title=` (or a tooltip
 * wired to every row) fires whether or not anything is hidden; this fires only
 * when the ellipsis is actually eating text, so hovering a row that already
 * reads in full does nothing at all. No flicker, no card to dismiss, no noise.
 *
 * Why it has to be measured rather than predicted: whether a row fits depends
 * on several moving parts at once — the length of the copy, whatever else
 * shares the row (the sidebar's Explore item surrenders ~20px to its count
 * badge, so it clips *before* rows with longer text do), the font, and the
 * container's live width. The sidebar in particular is drag-resizable from
 * 220px to 400px. A `ResizeObserver` re-measures across that drag, so a tooltip
 * disappears the moment the row can show its own text, and comes back when it
 * can't.
 *
 * @param ref     the element whose text may be clipped (the one carrying `truncate`)
 * @param enabled skip measuring entirely — e.g. a collapsed sidebar renders no
 *                text at all, so there is nothing to measure. Also re-runs the
 *                effect when it flips, which is what picks the element up when
 *                it mounts later.
 */
export function useIsClipped(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): boolean {
  const [clipped, setClipped] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) {
      setClipped(false)
      return
    }

    // The +1 absorbs sub-pixel rounding. Without it, text that fits exactly
    // reports as clipped at fractional zoom / non-integer DPR, and the tooltip
    // flickers on rows that look perfectly fine.
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1)
    measure()

    // Absent in jsdom (and in any non-DOM renderer). Measure once and stay
    // correct-if-static rather than throwing.
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, enabled])

  return clipped
}
