/**
 * useLocateManyOnCanvas — "reveal all N of these on the canvas" (T24 F5).
 *
 * A plain `document.getElementById` query only ever finds whatever a
 * VIRTUALIZED column already happened to render — a row below the
 * overscan window is not in the DOM at all, so a target there silently
 * never arrived, with no signal that anything had failed. This walks
 * each target through the SAME virtualizer-aware reveal pulse a single
 * hit already uses (`scrollHitIntoView`, see ContextViewCanvas.tsx), one
 * at a time — the pulse is a single slot, so firing a later target's
 * pulse before an earlier one settles would cancel the earlier one's
 * in-flight reveal — tallies how many actually landed in the DOM
 * afterward, and reports back: both a return value for the caller and,
 * whenever some or all targets could not be located, a notification instead of
 * silence.
 */
import { useCallback, useRef } from 'react'
import type { RevealOptions } from './useRevealNode'

export interface UseLocateManyOnCanvasOptions {
  /** Expand a target's collapsed ancestors. Always called with
   *  `skipFocus: true` — N per-node scrolls would fight each other; this
   *  hook does its own scrolling, one target at a time. */
  revealAndFocus: (nodeId: string, opts: RevealOptions) => Promise<void>
  /** The virtualizer-aware single-target reveal pulse (the same one a
   *  lone search hit uses). */
  scrollHitIntoView: (nodeId: string) => void
  /** DOM lookup for a revealed row, by node id — the canvas's own id
   *  scheme lives with the caller, not here. */
  getElementById: (nodeId: string) => HTMLElement | null
  /** The horizontally-scrolling canvas container, for the final
   *  best-effort union-centring pass across whatever ended up
   *  simultaneously in the DOM. */
  getScrollContainer: () => HTMLElement | null
  /** Notify on a partial or total failure to locate. */
  notify: (type: 'warning' | 'error', message: string) => void
  /** How long to wait after each pulse for its row to materialize
   *  before checking whether it landed — mirrors the reveal-pulse
   *  effect's own timing (a settle delay plus two rAFs). Injectable so
   *  a test does not have to sit through real time. */
  settleMs?: number
}

export interface LocateManyResult {
  revealed: number
  requested: number
}

export function useLocateManyOnCanvas(
  opts: UseLocateManyOnCanvasOptions,
): (ids: string[]) => Promise<LocateManyResult> {
  // Same stash-in-a-ref shape as useRevealNode: a stable callback identity
  // that always reads the latest injected adapters.
  const optsRef = useRef(opts)
  optsRef.current = opts

  return useCallback(async (ids: string[]): Promise<LocateManyResult> => {
    const {
      revealAndFocus, scrollHitIntoView, getElementById, getScrollContainer, notify,
      settleMs = 90,
    } = optsRef.current

    if (ids.length === 0) return { revealed: 0, requested: 0 }

    await Promise.allSettled(ids.map((id) => revealAndFocus(id, { skipFocus: true })))
    // Let any expand-driven re-layout commit before the first reveal.
    await new Promise<void>((r) => requestAnimationFrame(() => r()))

    let revealed = 0
    for (const id of ids) {
      scrollHitIntoView(id)
      await new Promise<void>((r) => setTimeout(r, settleMs))
      if (getElementById(id)) revealed++
    }

    // Best-effort horizontal centring across whatever ended up
    // simultaneously in the DOM at the end (typically the whole set,
    // when the targets are close together).
    const container = getScrollContainer()
    const finalEls = ids.map(getElementById).filter((el): el is HTMLElement => !!el)
    if (container && finalEls.length > 0) {
      const containerRect = container.getBoundingClientRect()
      const rects = finalEls.map((el) => el.getBoundingClientRect())
      const minLeft = Math.min(...rects.map((r) => r.left))
      const maxRight = Math.max(...rects.map((r) => r.right))
      const unionCenterX = (minLeft + maxRight) / 2
      const viewportCenterX = containerRect.left + containerRect.width / 2
      container.scrollTo({
        left: container.scrollLeft + (unionCenterX - viewportCenterX),
        behavior: 'smooth',
      })
    }

    if (revealed < ids.length) {
      notify(
        revealed === 0 ? 'error' : 'warning',
        revealed === 0
          ? `Couldn't locate any of the ${ids.length} entities on the canvas`
          : `Revealed ${revealed} of ${ids.length} entities — the rest could not be located`,
      )
    }
    return { revealed, requested: ids.length }
  }, [])
}
