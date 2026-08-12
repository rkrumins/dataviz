import { useEffect, useRef } from 'react'

/**
 * How far `fitView` may zoom IN.
 *
 * A focused answer is usually SMALL (that is the point of focusing), so
 * a 1:1 cap left three cards adrift in an ocean of dots with 11px type.
 * Let a small picture fill its frame; 1.5 keeps the 11–12px card type
 * at a comfortable 16–18px without turning two cards into billboards.
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

/** What the camera needs to know about the picture. */
export interface CameraItem {
  id: string
  /** Items inside a frame never count as arrivals — the frame is the
   *  event; what happens inside it is its own business. */
  parentFrameId?: string
}

export interface CameraEdge {
  sourceCardId: string
  targetCardId: string
}

/**
 * Keep the camera honest about what just happened.
 *
 * A new focal is a new picture, so frame all of it. An EXPANSION is
 * different: new cards land a whole column out, and a pinned camera
 * leaves the answer off screen — the whole of "I can't expand
 * anything". Re-fitting everything instead yanks you off what you just
 * opened. So ease to exactly the items that ARRIVED plus the cards they
 * attach to (their edge partners) — the thing you clicked stays in
 * frame and the answer comes to you.
 *
 * The one invariant worth naming, because breaking it cost a whole
 * feature: **the bookkeeping is stamped only once the move has actually
 * happened.** Stamping when the move is merely SCHEDULED means a
 * cancelled run — StrictMode double-invokes effects, rapid re-renders
 * do the same — leaves the ref claiming this picture was framed while
 * its timeout was cleared; re-centering then never re-fits and the
 * camera stays pointing at the PREVIOUS graph.
 */
export function useFrameCamera(
  rf: CameraTarget | null,
  focalCardId: string,
  items: CameraItem[],
  edges: CameraEdge[],
  reducedMotion: boolean,
  /** React Flow's nodes-initialized signal. A fitView before nodes are
   *  measured silently no-ops — stamping then would freeze the camera
   *  on the default viewport forever. Until ready, do nothing and stamp
   *  nothing. */
  ready = true,
) {
  const framedRef = useRef<{ focal: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!rf || !ready) return
    const ids = new Set(items.map(i => i.id))
    const prev = framedRef.current
    const newFocal = !prev || prev.focal !== focalCardId
    const arrived = newFocal ? [] : items.filter(i => !prev!.ids.has(i.id) && !i.parentFrameId)
    if (!newFocal && arrived.length === 0) {
      // Nothing to move to, so nothing to cancel: safe to stamp now.
      framedRef.current = { focal: focalCardId, ids }
      return
    }
    const t = window.setTimeout(() => {
      framedRef.current = { focal: focalCardId, ids }
      if (newFocal) {
        void rf.fitView({ padding: 0.15, duration: reducedMotion ? 0 : 240, maxZoom: FIT_MAX_ZOOM })
        return
      }
      const arrivedIds = new Set(arrived.map(i => i.id))
      const anchors = new Set<string>()
      for (const e of edges) {
        if (arrivedIds.has(e.sourceCardId)) anchors.add(e.targetCardId)
        if (arrivedIds.has(e.targetCardId)) anchors.add(e.sourceCardId)
      }
      const frame = [
        ...arrivedIds,
        ...[...anchors].filter(id => ids.has(id)),
        // THE one unbreakable rule: the focal is in every frame this
        // camera ever eases to. The focal is the question; no answer
        // is allowed to displace it.
        focalCardId,
      ]
      void rf.fitView({
        nodes: frame.map(id => ({ id })),
        padding: 0.25,
        duration: reducedMotion ? 0 : 320,
        maxZoom: FIT_MAX_ZOOM,
      })
    }, 30)
    return () => window.clearTimeout(t)
  }, [rf, focalCardId, items, edges, reducedMotion, ready])
}
