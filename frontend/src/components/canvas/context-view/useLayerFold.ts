/**
 * The canvas's fold window: which layers are open, which are spines, and the
 * ways a reader moves the window (see layerFold.ts for the rules).
 *
 * Two kinds of input move it:
 *
 *   * EXPLICIT — a spine clicked, a layer-strip pill, the strip's ‹ ›, a
 *     reveal ("take me to this row"). These re-anchor the window: a layer
 *     asked for by name opens with the window centred on it.
 *   * IMPLICIT — the selected row's layer is kept open, so when the entity
 *     drawer takes 500px off the canvas the window slides to keep the row
 *     rather than folding it away under the reader.
 *
 * The canvas width is read through `useSyncExternalStore` — the house
 * pattern for DOM measurements (see useScrollGeometry) — and the snapshot is
 * the fold RESULT, not the width. The drawer animates the width over ~400ms;
 * the canvas re-renders only on the frames where a layer actually folds or
 * opens, not on every pixel of the slide.
 *
 * Reveal and selection are props the window follows, so they are applied in
 * render with the `seen !== current` idiom rather than from an effect (a set
 * state in an effect is a lint ERROR in this codebase).
 */
import { useCallback, useMemo, useState, useSyncExternalStore, type RefObject } from 'react'

import { EXPANDED_COLUMN_MIN_WIDTH_PX } from './fitZoom'
import { computeLayerFold, SPINE_MAX_WIDTH_PX, type FoldAnchor } from './layerFold'

/** LayerColumn's personal-width store: a drag-resize a reader made for
 *  themselves, which outranks the view's authored width. */
const PERSONAL_WIDTHS_KEY = 'nx-layer-widths'

let cachedRaw: string | null | undefined
let cachedWidths: Record<string, unknown> = {}

/** Parsed once per change of the stored string — this is read on every
 *  resize frame, and the string is almost never different. */
function personalWidths(): Record<string, unknown> {
  let raw: string | null
  try { raw = localStorage.getItem(PERSONAL_WIDTHS_KEY) } catch { return {} }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    try { cachedWidths = JSON.parse(raw ?? '{}') ?? {} } catch { cachedWidths = {} }
  }
  return cachedWidths
}

export interface UseLayerFoldArgs {
  /** In column order. `width` is the view's authored column width. */
  layers: ReadonlyArray<{ id: string; width?: number | null }>
  /** The canvas's horizontal scroller: its width is what the run must fit. */
  scrollRef: RefObject<HTMLElement | null>
  /** Canvas zoom — the columns get 1/zoom layout px per screen px. */
  zoom: number
  /** Layout px the columns wrapper spends on things that are not layers:
   *  its gutters and, in draft, the add-layer column. */
  reservedWidth: number
  /** The reader's preference. Off, only the layers they fold by hand fold. */
  enabled: boolean
  /** The layer a rendered row lives in. */
  layerOf: (nodeId: string) => string | undefined
  /** A reveal — its row's layer opens if it was folded. */
  revealTarget: { id: string; pulse: number } | null
  /** The one selected row, when exactly one is selected. */
  selectedNodeId: string | null
}

export interface LayerFoldState {
  folded: ReadonlySet<string>
  spineWidth: number
  openIds: ReadonlySet<string>
  /** Something is folded to fit — not counting what the reader folded. */
  active: boolean
  /** The layers, all open, would not fit — folding has something to do,
   *  whether or not it is on. */
  overflows: boolean
  canStep: { back: boolean; forward: boolean }
  /** Open this layer with the window centred on it. No-op when open. */
  focusLayer: (layerId: string) => void
  /** The column's own fold button, and a click on its spine. */
  setLayerFolded: (layerId: string, folded: boolean) => void
  /** Slide the window one layer. */
  step: (direction: 1 | -1) => void
}

interface Snapshot { folded: string[]; spineWidth: number; first: number; last: number; overflows: boolean }

const NOTHING_FOLDED = JSON.stringify({ folded: [], spineWidth: SPINE_MAX_WIDTH_PX, first: -1, last: -1, overflows: false })

export function useLayerFold({
  layers,
  scrollRef,
  zoom,
  reservedWidth,
  enabled,
  layerOf,
  revealTarget,
  selectedNodeId,
}: UseLayerFoldArgs): LayerFoldState {
  const [anchor, setAnchor] = useState<FoldAnchor | null>(null)
  const [keepOpenId, setKeepOpenId] = useState<string | null>(null)
  const [userFolded, setUserFolded] = useState<ReadonlySet<string>>(() => new Set())

  const subscribe = useCallback((onChange: () => void) => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return () => {}
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollRef])

  const getSnapshot = () => {
    const el = scrollRef.current
    const available = el ? el.clientWidth / zoom - reservedWidth : 0
    const personal = personalWidths()
    const result = computeLayerFold({
      layers: layers.map(layer => {
        const own = personal[layer.id]
        return { id: layer.id, width: typeof own === 'number' ? own : (layer.width ?? EXPANDED_COLUMN_MIN_WIDTH_PX) }
      }),
      available,
      anchor,
      keepOpenId,
      userFolded,
    })
    const folded = enabled ? [...result.folded] : layers.filter(l => userFolded.has(l.id)).map(l => l.id)
    const snapshot: Snapshot = {
      folded,
      spineWidth: enabled ? result.spineWidth : SPINE_MAX_WIDTH_PX,
      first: result.first,
      last: result.last,
      overflows: result.overflows,
    }
    return JSON.stringify(snapshot)
  }

  const key = useSyncExternalStore(subscribe, getSnapshot, () => NOTHING_FOLDED)
  const { folded, spineWidth, first, last, overflows } = useMemo(() => {
    const snapshot = JSON.parse(key) as Snapshot
    return { ...snapshot, folded: new Set(snapshot.folded) as ReadonlySet<string> }
  }, [key])

  const openIds = useMemo(
    () => new Set(layers.filter(layer => !folded.has(layer.id)).map(layer => layer.id)) as ReadonlySet<string>,
    [layers, folded],
  )

  const focusLayer = useCallback((layerId: string) => {
    if (!folded.has(layerId)) return
    setUserFolded(prev => {
      if (!prev.has(layerId)) return prev
      const next = new Set(prev)
      next.delete(layerId)
      return next
    })
    setAnchor({ layerId, align: 'center' })
    setKeepOpenId(layerId)
  }, [folded])

  const setLayerFolded = useCallback((layerId: string, fold: boolean) => {
    if (!fold) { focusLayer(layerId); return }
    setUserFolded(prev => (prev.has(layerId) ? prev : new Set(prev).add(layerId)))
    setKeepOpenId(prev => (prev === layerId ? null : prev))
  }, [focusLayer])

  // The next layer the window can open toward `direction` from its first
  // open layer — hand-folded layers are stepped over, or stepping back would
  // stall behind one.
  const stepTarget = (direction: 1 | -1): number => {
    if (first === -1) return -1
    let i = first + direction
    while (i >= 0 && i < layers.length && userFolded.has(layers[i].id)) i += direction
    return i >= 0 && i < layers.length ? i : -1
  }

  const step = (direction: 1 | -1) => {
    const target = stepTarget(direction)
    if (target === -1) return
    setAnchor({ layerId: layers[target].id, align: 'start' })
    // Stepping away from the selected row's layer is exactly what was asked
    // for, so it no longer holds the window.
    setKeepOpenId(null)
  }

  // ── Following the reader (render-phase; see the header) ────────────────
  const [handledPulse, setHandledPulse] = useState(-1)
  if (revealTarget && revealTarget.pulse !== handledPulse) {
    const layerId = layerOf(revealTarget.id)
    // A row whose layer is not known yet is still arriving — try again on
    // the render that brings it, rather than dropping the reveal.
    if (layerId) {
      setHandledPulse(revealTarget.pulse)
      if (folded.has(layerId)) focusLayer(layerId)
    }
  }

  const selectedLayer = selectedNodeId ? layerOf(selectedNodeId) : undefined
  const [seenSelectedLayer, setSeenSelectedLayer] = useState<string | undefined>(undefined)
  if (selectedLayer !== seenSelectedLayer) {
    setSeenSelectedLayer(selectedLayer)
    if (selectedLayer) setKeepOpenId(selectedLayer)
  }

  return {
    folded,
    spineWidth,
    openIds,
    active: enabled && overflows,
    overflows,
    canStep: {
      back: enabled && overflows && stepTarget(-1) !== -1,
      // Forward is possible while an openable layer lies past the window's
      // far edge; a step from there re-anchors one layer on.
      forward: enabled && overflows && last !== -1 && layers.slice(last + 1).some(layer => !userFolded.has(layer.id)),
    },
    focusLayer,
    setLayerFolded,
    step,
  }
}
