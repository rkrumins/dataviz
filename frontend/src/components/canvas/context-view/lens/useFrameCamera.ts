import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CARD_W, BAND_GAP, type FocusCard, type FocusEdge } from './focus-cards'

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

/**
 * THE FOCUS FIRST (2026-08-22). A new picture used to be fitted whole,
 * whatever its size: with dozens of partners a band the board is
 * thousands of pixels tall, the fit zoom lands near 0.1 and "the focus
 * node is tiny — I have to click Zoom In until I even find it". A board
 * that cannot be read at its fit zoom now opens CENTRED ON THE FOCUS at
 * a zoom never below this, with the two neighbouring bands in view; the
 * rest is a pan or a Fit away. 0.75 keeps the 11–12px card type at
 * ~8–9px — small, legible, and the focal frame's own rows readable.
 */
export const FOCUS_MIN_ZOOM = 0.75
/** The flow-space width the focus framing tries to show: the focus and
 *  one band either side, with a margin. */
const FOCUS_FRAME_W = 3 * (CARD_W + BAND_GAP) + 120
/** Screen pixels kept clear above a tall focal frame, so its header lands
 *  under the walk capsule (top-centre, ~110px) rather than behind it. */
export const FOCUS_HEADROOM_PX = 140
/** `fitView`'s own padding, mirrored so "would the whole board read at
 *  its fit zoom" is the same question React Flow would answer. */
const FIT_PADDING = 0.15

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
  /** A plain translate/zoom set — used ONLY for the extend-ghost nudge
   *  below, which has no real node id to hand `fitView`. */
  setViewport: (viewport: { x: number; y: number; zoom: number }, opts?: { duration?: number }) => unknown
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
  /** A hands-free walk is landing cards (C4, 2026-08-21). A wide board
   *  grows by a wave every few seconds for minutes; easing to each wave
   *  yanked the reader once per request for the whole walk. While this
   *  is set, arrivals hold the camera still and `grew` reports them so
   *  the view can OFFER a fit instead of taking one. */
  walking = false,
  /** The layout mode — density · steps · direction — as one string. A
   *  change is a new picture of the SAME focus (2026-08-22): the board
   *  re-lays out wholesale, so the camera re-frames the focus exactly as
   *  it does for a new focal, rather than leaving the reader wherever
   *  the previous layout had them. */
  frameKey = '',
  /** The reader panned or zoomed since this picture was framed. While it
   *  is set the camera is theirs: the end of a walk settles nothing, and
   *  the "Board grew" offer stays a pill. */
  readerMoved = false,
) {
  const framedRef = useRef<{ focal: string; key: string; ids: Set<string> } | null>(null)
  const [grew, setGrew] = useState(false)

  /** Centre the focus at a readable zoom — the move behind the focus-first
   *  opening and the reader's own Re-center. A plain viewport set: the
   *  focal's geometry is the layout's own, so no node id is needed. */
  const frameFocus = useCallback((duration: number) => {
    if (!rf) return false
    const rect = containerRef.current?.getBoundingClientRect()
    const focal = cards.find(c => c.kind === 'focal') ?? cards.find(c => c.id === 'f')
    if (!rect || rect.width <= 0 || rect.height <= 0 || !focal) return false
    const geometry = [focal.x, focal.y, focal.w, focal.h]
    if (!geometry.every(Number.isFinite)) return false
    const zoom = Math.min(FIT_MAX_ZOOM, Math.max(FOCUS_MIN_ZOOM, rect.width / FOCUS_FRAME_W))
    // A short focal is centred; a tall one is placed with its header
    // FOCUS_HEADROOM_PX below the pane's top — the name and the counts
    // are always in the picture, and never behind the capsule.
    const cx = focal.x + focal.w / 2
    const cy = focal.y + Math.min(focal.h / 2, (rect.height / 2 - FOCUS_HEADROOM_PX) / zoom)
    void rf.setViewport({ x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom, zoom }, { duration })
    return true
  }, [rf, cards, containerRef])

  /** Would the whole board read at its fit zoom? Unknown geometry or an
   *  unmeasured pane answers "yes" — the plain fit is the safe default. */
  const fitsReadably = useCallback((): boolean => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return true
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const c of cards) {
      if (c.frameId) continue
      if (![c.x, c.y, c.w, c.h].every(Number.isFinite)) return true
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x + c.w)
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y + c.h)
    }
    if (!Number.isFinite(minX)) return true
    const fitZoom = Math.min(
      rect.width / ((maxX - minX) * (1 + 2 * FIT_PADDING)),
      rect.height / ((maxY - minY) * (1 + 2 * FIT_PADDING)),
      FIT_MAX_ZOOM,
    )
    return fitZoom >= FOCUS_MIN_ZOOM
  }, [cards, containerRef])

  useEffect(() => {
    if (!rf) return
    const ids = new Set(cards.map(c => c.id))
    const prev = framedRef.current
    const newFocal = !prev || prev.focal !== focalId || prev.key !== frameKey
    if (newFocal) setGrew(false)
    // Rows INSIDE a frame do not count as arrivals. A resolving
    // container replaces its rows on every step of the server walk
    // (pass-through levels come and go), and easing to each batch
    // yanked the viewport once per step — reported, accurately, as
    // "it all turns into chaos". The FRAME appearing is the event;
    // what happens inside it is its own business.
    const arrived = newFocal ? [] : cards.filter(c => !prev!.ids.has(c.id) && !c.frameId)
    if (!newFocal && arrived.length === 0) {
      // Nothing to move to, so nothing to cancel: safe to stamp now.
      framedRef.current = { focal: focalId, key: frameKey, ids }
      return
    }
    if (!newFocal && walking) {
      // The walk is drawing; the reader keeps their place. No move is
      // scheduled, so stamping now is safe — and the board grew.
      framedRef.current = { focal: focalId, key: frameKey, ids }
      setGrew(true)
      return
    }
    const t = window.setTimeout(() => {
      framedRef.current = { focal: focalId, key: frameKey, ids }
      if (newFocal) {
        // A small picture fills its frame; a picture too large to read
        // at its fit zoom opens on the focus instead (FOCUS_MIN_ZOOM).
        if (fitsReadably() || !frameFocus(reducedMotion ? 0 : 240)) {
          void rf.fitView({ padding: FIT_PADDING, duration: reducedMotion ? 0 : 240, maxZoom: FIT_MAX_ZOOM })
        }
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
  }, [rf, focalId, cards, edges, reducedMotion, containerRef, walking, frameKey, fitsReadably, frameFocus])

  // THE WALK SETTLES ON THE FOCUS (2026-08-22). The camera holds still
  // while the walk lands cards, and the focal frame grows around the
  // midline meanwhile — so by the end its header had drifted up under
  // the capsule, and the reader was left at the first wave's framing of
  // a board now several times the size. One move on the walk's END
  // (walking: true → false) brings the focus back, readable — a small
  // board fitted whole, a large one centred on the focus — and only if
  // the reader has not taken the camera themselves.
  const prevWalkingRef = useRef(walking)
  useEffect(() => {
    const was = prevWalkingRef.current
    prevWalkingRef.current = walking
    if (!was || walking) return
    if (!rf || !grew || readerMoved) return
    const t = window.setTimeout(() => {
      setGrew(false)
      if (fitsReadably() || !frameFocus(reducedMotion ? 0 : 320)) {
        void rf.fitView({ padding: FIT_PADDING, duration: reducedMotion ? 0 : 320, maxZoom: FIT_MAX_ZOOM })
      }
    }, 30)
    return () => window.clearTimeout(t)
  }, [walking, rf, grew, readerMoved, reducedMotion, fitsReadably, frameFocus])

  /** The reader's own "show me everything": one fit of the whole board. */
  const fitAll = useCallback(() => {
    setGrew(false)
    if (!rf) return
    void rf.fitView({ padding: FIT_PADDING, duration: reducedMotion ? 0 : 240, maxZoom: FIT_MAX_ZOOM })
  }, [rf, reducedMotion])

  /** Is the focal card (at least partly, with the usual margin) inside
   *  the pane at this viewport? The board asks on every move and offers
   *  the way back when the answer is no. A pane it cannot measure, or a
   *  focal without geometry, answers "yes": never a pill about nothing. */
  const focusInView = useCallback((viewport?: { x: number; y: number; zoom: number }): boolean => {
    const rect = containerRef.current?.getBoundingClientRect()
    const focal = cards.find(c => c.kind === 'focal') ?? cards.find(c => c.id === 'f')
    if (!rect || rect.width <= 0 || rect.height <= 0 || !focal) return true
    if (![focal.x, focal.y, focal.w, focal.h].every(Number.isFinite)) return true
    const vp = viewport ?? rf?.getViewport()
    if (!vp) return true
    const { left, top, right, bottom } = toScreen({ x: focal.x, y: focal.y, w: focal.w, h: focal.h }, vp)
    // "In view" means some of it is on screen — a focal half off the
    // right edge is still findable; one entirely past an edge is lost.
    return right > VISIBLE_MARGIN_PX && left < rect.width - VISIBLE_MARGIN_PX
      && bottom > VISIBLE_MARGIN_PX && top < rect.height - VISIBLE_MARGIN_PX
  }, [rf, cards, containerRef])

  /** The reader's own "take me back to the focus": centre it at the
   *  readable zoom, whatever the board's size. Falls back to a plain fit
   *  when the focal has no geometry yet. */
  const recenter = useCallback(() => {
    if (!rf) return
    if (!frameFocus(reducedMotion ? 0 : 240)) {
      void rf.fitView({ padding: FIT_PADDING, duration: reducedMotion ? 0 : 240, maxZoom: FIT_MAX_ZOOM })
    }
  }, [rf, reducedMotion, frameFocus])

  // ── The extend-ghost nudge (fix round 1) ──────────────────────────
  //
  // Reported against the FIRST version of this hook: `ExtendGhost`
  // (FocusGraphView.tsx) draws the instant a pill's own fetch starts —
  // proven by its own test — but nothing told the CAMERA about it, so a
  // click near the pane's edge acknowledged with a shimmer the reader
  // could not see. This is a SEPARATE effect from the one above because
  // its trigger is different (a pill's `status` flipping to 'loading',
  // not a card arriving) and a `setViewport` translate rather than
  // `fitView`, because a ghost has no real node id to hand it.
  //
  // Deliberately NOT the same "already visible → do nothing" branch as
  // above: a ghost that IS already visible needs no nudge (the check
  // below finds nothing to correct and no-ops), so one function serves
  // both without a redundant up-front check.
  const loadingGhostsRef = useRef<Map<string, { card: FocusCard; dir: 'in' | 'out' }>>(new Map())
  useEffect(() => {
    if (!rf) return
    const current = new Map<string, { card: FocusCard; dir: 'in' | 'out' }>()
    for (const c of cards) {
      if (c.pillUp?.status === 'loading') current.set(`${c.id}:in`, { card: c, dir: 'in' })
      if (c.pillDown?.status === 'loading') current.set(`${c.id}:out`, { card: c, dir: 'out' })
    }
    const prev = loadingGhostsRef.current
    // Only NEWLY-loading pills — a pill that was already spinning last
    // render already got its chance to nudge the camera; re-nudging on
    // every subsequent render (while the fetch is still in flight) would
    // fight a reader who panned away from it on purpose.
    const justStarted = [...current.entries()].filter(([key]) => !prev.has(key)).map(([, v]) => v)
    if (justStarted.length === 0) {
      // Nothing new, so nothing that could be CANCELLED: safe to stamp
      // now, same as the arrival effect's own early return above.
      loadingGhostsRef.current = current
      return
    }

    // THE SAME invariant the arrival effect above is built around: stamp
    // only once the check has actually RUN, never when it is merely
    // scheduled. Stamping here (before the possibly-deferred branch
    // below) hit the exact bug that comment already documents — under
    // StrictMode's mount → cleanup → mount, run 1 stamps and schedules,
    // cleanup cancels the schedule, and run 2 sees "already seen" and
    // does nothing, so the nudge that was supposed to fire never does.
    const applyNudge = () => {
      loadingGhostsRef.current = current
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || !rf) return
      // One union box, the same pattern the arrival effect above uses
      // for multiple simultaneous arrivals — summing separate per-ghost
      // nudges could overshoot when more than one starts at once.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const { card, dir } of justStarted) {
        const g = ghostRect(card, dir)
        minX = Math.min(minX, g.x); maxX = Math.max(maxX, g.x + g.w)
        minY = Math.min(minY, g.y); maxY = Math.max(maxY, g.y + g.h)
      }
      if (!Number.isFinite(minX)) return
      const viewport = rf.getViewport()
      const nudge = minimalNudge({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, viewport, rect.width, rect.height)
      if (!nudge) return
      void rf.setViewport(
        { x: viewport.x + nudge.dx, y: viewport.y + nudge.dy, zoom: viewport.zoom },
        { duration: reducedMotion ? 0 : 240 },
      )
    }

    // Read-only peek at the SAME bookkeeping the effect above owns, to
    // answer one question: is a new-focal fit or an arrival ease ALSO
    // about to run this render? If so, `getViewport()` above would read
    // a viewport that is mid-flight to somewhere else, and applying the
    // nudge now would just be overwritten when that other move lands a
    // moment later — reproduced exactly this way on `walkFrontier.png`
    // (its BUSY pill starts loading on the SAME render as the initial
    // new-focal fit) before this guard existed. Wait past both that
    // effect's own delay (30ms) and its longest animation (320ms) before
    // reading the viewport for real; nothing to wait for in the — far
    // more common — case of a click on an already-settled board, so
    // that path stays immediate.
    const bookkeeping = framedRef.current
    const racingMainMove = !bookkeeping || bookkeeping.focal !== focalId
      || cards.some(c => !bookkeeping.ids.has(c.id) && !c.frameId)
    if (racingMainMove) {
      const t = window.setTimeout(applyNudge, 350)
      return () => window.clearTimeout(t)
    }
    applyNudge()
  }, [rf, focalId, cards, reducedMotion, containerRef])

  return useMemo(() => ({ grew, fitAll, recenter, focusInView }), [grew, fitAll, recenter, focusInView])
}

interface Rect { x: number; y: number; w: number; h: number }

/** Flow-space → screen-space, the same transform `LensPeek` already
 *  uses (`x * zoom + tx`). */
function toScreen(r: Rect, viewport: { x: number; y: number; zoom: number }) {
  return {
    left: r.x * viewport.zoom + viewport.x,
    top: r.y * viewport.zoom + viewport.y,
    right: (r.x + r.w) * viewport.zoom + viewport.x,
    bottom: (r.y + r.h) * viewport.zoom + viewport.y,
  }
}

/** Where an extend/page pill's ghost lands (Task 20, P5/fix round 1) —
 *  identical to `ExtendGhost`'s own geometry in FocusGraphView.tsx: one
 *  band further in the pill's own direction, at the card's own height. */
function ghostRect(card: FocusCard, dir: 'in' | 'out'): Rect {
  const band = card.band + (dir === 'in' ? -1 : 1)
  return { x: band * (CARD_W + BAND_GAP), y: card.y, w: CARD_W, h: card.h }
}

/**
 * Are every one of `ids` (by their FocusCard geometry) already inside
 * the pane, at the CURRENT pan/zoom? A card is "visible" with
 * `VISIBLE_MARGIN_PX` of slack on every edge.
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
    const { left, top, right, bottom } = toScreen({ x: c.x, y: c.y, w: c.w, h: c.h }, viewport)
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

/** How much CLEARANCE a nudge's own landing spot aims for — deliberately
 *  more than `VISIBLE_MARGIN_PX`'s tolerance. `VISIBLE_MARGIN_PX` decides
 *  "is this already close enough that the camera should not move at
 *  all," which is right to be lenient (an existing card sitting flush
 *  against an edge the reader put it at is not a bug). Landing a NUDGE
 *  exactly on that same lenient boundary produces a ghost sitting flush
 *  against the edge it was just moved to reveal — visually still mostly
 *  cut off, reproduced on `walkFrontier.png` before this constant existed
 *  as its own thing. A nudge should leave the reader something legible. */
const GHOST_LANDING_PADDING_PX = 40

/** The smallest translate (screen px) that brings `r` to a comfortably
 *  clear position inside the pane (`GHOST_LANDING_PADDING_PX`), or
 *  `null` if it already is, or its geometry is unknown. Pan only — never
 *  a zoom change, which is what makes this a NUDGE rather than the
 *  fuller re-fit the arrival effect above still falls back to. */
function minimalNudge(
  r: Rect,
  viewport: { x: number; y: number; zoom: number },
  paneW: number,
  paneH: number,
): { dx: number; dy: number } | null {
  const { left, top, right, bottom } = toScreen(r, viewport)
  if (![left, top, right, bottom].every(Number.isFinite)) return null
  let dx = 0
  if (left < GHOST_LANDING_PADDING_PX) dx = GHOST_LANDING_PADDING_PX - left
  else if (right > paneW - GHOST_LANDING_PADDING_PX) dx = (paneW - GHOST_LANDING_PADDING_PX) - right
  let dy = 0
  if (top < GHOST_LANDING_PADDING_PX) dy = GHOST_LANDING_PADDING_PX - top
  else if (bottom > paneH - GHOST_LANDING_PADDING_PX) dy = (paneH - GHOST_LANDING_PADDING_PX) - bottom
  return dx === 0 && dy === 0 ? null : { dx, dy }
}
