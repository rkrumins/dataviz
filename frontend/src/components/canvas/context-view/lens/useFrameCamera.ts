import { useEffect, useRef } from 'react'
import type { FocusCard } from './focus-cards'

/**
 * How far `fitView` may zoom IN.
 *
 * It used to be 1, meaning a graph smaller than the viewport was drawn
 * at 1:1 and left floating in a large field of dots — three cards adrift
 * in an ocean, with 11px type. A focused answer is usually SMALL (that
 * is the point of focusing), so the common case looked broken. Let a
 * small picture fill its frame; 1.5 keeps the 11–12px card type at a
 * comfortable 16–18px without turning two cards into billboards.
 */
export const FIT_MAX_ZOOM = 1.5

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
    // Rows INSIDE a frame do not count as arrivals. A resolving
    // container replaces its rows on every step of the server walk
    // (pass-through levels come and go), and easing to each batch
    // yanked the viewport once per step — reported, accurately, as
    // "it all turns into chaos". The FRAME appearing is the event;
    // what happens inside it is its own business.
    const arrived = newFocal ? [] : cards.filter(c => !prev!.ids.has(c.id) && !c.frameId)
    if (!newFocal && arrived.length === 0) {
      // Nothing to move to, so nothing to cancel: safe to stamp now.
      framedRef.current = { focal: focalId, ids }
      return
    }
    const t = window.setTimeout(() => {
      framedRef.current = { focal: focalId, ids }
      if (newFocal) {
        void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: FIT_MAX_ZOOM })
        return
      }
      const anchors = new Set(arrived.flatMap(c => c.partnerIds))
      const frame = [
        ...arrived.map(c => c.id),
        ...cards.filter(c => c.nodeId && anchors.has(c.nodeId)).map(c => c.id),
        // THE one unbreakable rule: the focal is in every frame this
        // camera ever eases to. Answers arriving asynchronously — an
        // auto-resolved container, a slow expansion — used to pan the
        // viewport to themselves, and the entity the user focused left
        // the screen: "the actual focus node has disappeared". The
        // focal is the question; no answer is allowed to displace it.
        'f',
      ]
      void rf.fitView({
        nodes: frame.map(id => ({ id })),
        padding: 0.25,
        duration: reducedMotion ? 0 : 320,
        maxZoom: FIT_MAX_ZOOM,
      })
    }, 30)
    return () => window.clearTimeout(t)
  }, [rf, focalId, cards, reducedMotion])
}
