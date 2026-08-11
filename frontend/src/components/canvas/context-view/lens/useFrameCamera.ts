import { useEffect, useRef } from 'react'
import type { FocusCard } from './focus-graph'

/** The only part of the React Flow instance the camera needs. */
export type CameraTarget = {
  fitView: (opts: {
    nodes?: Array<{ id: string }>
    padding?: number
    duration?: number
    maxZoom?: number
  }) => unknown
}

/**
 * Keep the camera honest about what just happened.
 *
 * A new focal is a new picture, so frame all of it. An EXPANSION is
 * different: new cards land a whole band out — 370px past the card you
 * clicked, growing the graph by ~30% in one click — and the camera used
 * to stay pinned, so the only feedback was the pill changing glyph and
 * the result was very often off screen. That is the whole of "I can't
 * expand anything".
 *
 * Re-fitting everything would yank you off what you just opened, which
 * is why it was pinned in the first place. So ease to exactly the cards
 * that ARRIVED plus the cards they attached to — the thing you clicked
 * stays in frame and the answer comes to you. The anchors come free
 * from `partnerIds`, which every card already carries.
 *
 * The one invariant worth naming, because breaking it cost a whole
 * feature: **the bookkeeping is stamped only once the move has actually
 * happened.** Stamping when the move is merely SCHEDULED means a
 * cancelled run — React invokes effects twice under StrictMode, and any
 * rapid re-render does the same — leaves the ref claiming this picture
 * was framed while its timeout was cleared. The next run then sees
 * "same focal, nothing new" and does nothing, so re-centering never
 * re-fits and the camera stays pointing at the PREVIOUS graph: the
 * focal renders correctly and is nowhere on screen.
 */
export function useFrameCamera(
  rf: CameraTarget | null,
  focalId: string,
  cards: FocusCard[],
  reducedMotion: boolean,
) {
  const framedRef = useRef<{ focal: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!rf) return
    const ids = new Set(cards.map(c => c.id))
    const prev = framedRef.current
    const newFocal = !prev || prev.focal !== focalId
    const arrived = newFocal ? [] : cards.filter(c => !prev!.ids.has(c.id))
    if (!newFocal && arrived.length === 0) {
      // Nothing to move to, so nothing to cancel: safe to stamp now.
      framedRef.current = { focal: focalId, ids }
      return
    }
    const t = window.setTimeout(() => {
      framedRef.current = { focal: focalId, ids }
      if (newFocal) {
        void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: 1 })
        return
      }
      const anchors = new Set(arrived.flatMap(c => c.partnerIds))
      const frame = [
        ...arrived.map(c => c.id),
        ...cards.filter(c => c.nodeId && anchors.has(c.nodeId)).map(c => c.id),
      ]
      void rf.fitView({
        nodes: frame.map(id => ({ id })),
        padding: 0.25,
        duration: reducedMotion ? 0 : 320,
        maxZoom: 1,
      })
    }, 30)
    return () => window.clearTimeout(t)
  }, [rf, focalId, cards, reducedMotion])
}
