import { useEffect, useRef, type RefObject } from 'react'
import type { FocusCard, FocusEdge } from './focus-cards'

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
  /** Current pan/zoom — read-only, so checking "is this already in view"
   *  costs nothing the instance was not already tracking. */
  getViewport: () => { x: number; y: number; zoom: number }
}

/** How close to the pane's own edge counts as "already in view" — a
 *  card sitting flush against the edge still reads as visible, so the
 *  margin is generous rather than pixel-exact. */
const VISIBLE_MARGIN_PX = 24

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
 * from the EDGES on the board — the cards an arrival actually wired
 * itself to.
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
  edges: FocusEdge[],
  reducedMotion: boolean,
  /** The pane's own DOM element (Task 20, P5) — measured at the moment
   *  the visibility check runs, rather than a reactive width/height:
   *  this hook's own body executes OUTSIDE any `ReactFlowProvider`
   *  (`FocusGraphView` renders one below itself, for its children), so
   *  the store hook `LensPeek` uses for the same question is not
   *  reachable here. A plain ref costs nothing until it is read. */
  containerRef: RefObject<HTMLElement | null>,
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
      // What each arrival wired itself to — the other end of every
      // edge touching it, which is the same question `partnerIds` used
      // to answer off the card and is now simply on the board.
      const arrivedIds = new Set(arrived.map(c => c.id))
      const anchors = new Set<string>()
      for (const e of edges) {
        if (arrivedIds.has(e.source) && !arrivedIds.has(e.target)) anchors.add(e.target)
        if (arrivedIds.has(e.target) && !arrivedIds.has(e.source)) anchors.add(e.source)
      }
      const frameIds = [
        ...arrived.map(c => c.id),
        ...cards.filter(c => anchors.has(c.id)).map(c => c.id),
        // THE one unbreakable rule: the focal is in every frame this
        // camera ever eases to. Answers arriving asynchronously — an
        // auto-resolved container, a slow expansion — used to pan the
        // viewport to themselves, and the entity the user focused left
        // the screen: "the actual focus node has disappeared". The
        // focal is the question; no answer is allowed to displace it.
        'f',
      ]
      // Already fully on screen? Then don't move the camera AT ALL — a
      // fitView here is a jump the reader did not ask for; they clicked
      // a control in view and the answer landed beside it, in view.
      // Only when the arrival would land off-pane does the existing
      // (already once-fixed) ease below still run.
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect && cardsAlreadyVisible(frameIds, cards, rf.getViewport(), rect.width, rect.height)) return
      void rf.fitView({
        nodes: frameIds.map(id => ({ id })),
        padding: 0.25,
        duration: reducedMotion ? 0 : 320,
        maxZoom: FIT_MAX_ZOOM,
      })
    }, 30)
    return () => window.clearTimeout(t)
    // `edges` was missing here before this task (pre-existing) — added
    // now that touching this file put it under lint. Safe: an `edges`
    // change alone (cards unchanged) re-runs the effect but hits the
    // "nothing arrived" early return, which only stamps the bookkeeping.
  }, [rf, focalId, cards, edges, reducedMotion, containerRef])
}

/**
 * Are every one of `ids` (by their FocusCard geometry) already inside
 * the pane, at the CURRENT pan/zoom? Flow-space → screen-space is the
 * same transform `LensPeek` already uses (`x * zoom + tx`); a card is
 * "visible" with `VISIBLE_MARGIN_PX` of slack on every edge.
 */
function cardsAlreadyVisible(
  ids: string[],
  cards: FocusCard[],
  viewport: { x: number; y: number; zoom: number },
  paneW: number,
  paneH: number,
): boolean {
  const byId = new Map(cards.map(c => [c.id, c]))
  for (const id of ids) {
    const c = byId.get(id)
    if (!c) continue // e.g. 'f' when the focal isn't drawn as a card
    const left = c.x * viewport.zoom + viewport.x
    const top = c.y * viewport.zoom + viewport.y
    const right = (c.x + c.w) * viewport.zoom + viewport.x
    const bottom = (c.y + c.h) * viewport.zoom + viewport.y
    // An unknown position (NaN, from a card with no geometry) must NOT
    // read as "visible" — every one of the comparisons below is false
    // for NaN, which would otherwise silently skip the camera move.
    if (![left, top, right, bottom].every(Number.isFinite)) return false
    if (
      left < -VISIBLE_MARGIN_PX || top < -VISIBLE_MARGIN_PX
      || right > paneW + VISIBLE_MARGIN_PX || bottom > paneH + VISIBLE_MARGIN_PX
    ) return false
  }
  return true
}
