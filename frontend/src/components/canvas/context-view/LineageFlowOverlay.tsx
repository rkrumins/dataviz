import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ColumnGeometryApi, ComputedEdge, OverflowBadge, OverflowDirection } from './types'
import { sameRow, sameRows } from './rowEquality'
import { edgeDashArray } from './edgeDash'
import { useDrawnEdgesStore } from '@/store/drawnEdges'
import { routeLine } from './lineRoute'
import { bySignificance, lineDash, nextRenderTier, type RenderTier } from './lineDensity'
import { delegatedLineState, hoverSpotlight, type Spotlight } from './hoverSpotlight'
import type { LineMotion } from './lineMotion'
import { LineMotionLayer } from './LineMotionLayer'

/**
 * Keep the previous viewport object when neither number moved.
 *
 * The scroll handler minted a fresh `{scrollTop, clientHeight}` on every
 * animation frame, so the overlay re-rendered — and re-filtered every edge —
 * per frame even when the scroller had not actually moved (a rubber-band, a
 * horizontal-only scroll, a resize that changed nothing vertically).
 */
function nextViewport(
  prev: { scrollTop: number; clientHeight: number },
  scrollTop: number,
  clientHeight: number,
): { scrollTop: number; clientHeight: number } {
  return prev.scrollTop === scrollTop && prev.clientHeight === clientHeight
    ? prev
    : { scrollTop, clientHeight }
}
import { groupAnchorProxies, anchorRailFingerprint } from './anchorRail'
import type { AnchorProxyCandidate } from './anchorRail'
import { useColumnPeripheryStore, PERIPHERY_PARTNER_CAP } from '@/store/columnPeriphery'
import { useAnchorRailStore } from '@/store/anchorRail'
import type { ColumnPeripherySummary } from '@/store/columnPeriphery'
import { formatRibbonCount, type FlowRibbon } from './flowRibbons'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useHoveredNodeId } from '@/hooks/useHighlightState'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'
import { OFF_CANVAS_STUB_WIDTH, portalLabel } from './ghostCues'
import { OffCanvasStub } from './OffCanvasStub'
import { unitNoun } from './connections/connectionUnits'
import type { OffCanvasLineage } from '@/hooks/useEdgeProjection'

// Global visibility tracker — which layer-node-* elements are currently in the viewport
const globalVisibleNodes = new Set<string>()

// Line routing — and the same-column lane geometry the canvas reserves its
// gutters from — lives in lineRoute.ts; re-exported for existing importers.
export {
  SAME_COLUMN_LANE_START,
  SAME_COLUMN_LANE_BASE,
  SAME_COLUMN_LANE_STEP,
  EXTREMITY_EDGE_GUTTER_PX,
} from './lineRoute'

/** How far a PORTAL chip sits in from the viewport's edge (see ghostCues). */
const PORTAL_INSET = 10

/** A row counts as visible this far above or below the canvas's view. */
const VISIBLE_MARGIN_PX = 100
/** ...and ANY distance sideways (see the visibility observer): past every
 *  canvas a view could be laid out on. */
const SIDEWAYS_REACH_PX = 100_000

/** The rail follows a hovered entity after this long on it... */
const RAIL_DWELL_MS = 250
/** ...and keeps its chips this long after the hover ends. */
const RAIL_LINGER_MS = 1500

const EMPTY_CHILD_MAP: ReadonlyMap<string, readonly string[]> = new Map()

function* concat<T>(a: Iterable<T>, b: Iterable<T>): Iterable<T> {
  yield* a
  yield* b
}

/** A projected line as the hover pool holds it: what ranking and drawing read. */
type PoolLine = {
  id: string
  source: string
  target: string
  bundleSize?: number
  edgeCount?: number
  confidence?: number
}

export function LineageFlowOverlay({
  nodes,
  edges,
  expandedNodes,
  selectEdge,
  isEdgePanelOpen,
  toggleEdgePanel,
  triggerRedrawRef,
  isTracing = false,
  traceResult = null,
  highlightedEdges,
  isHighlightActive = false,
  resolveEdgeColor,
  resolveEdgeStrokeStyle,
  onEdgeDoubleClick,
  showDirection = true,
  motion = 'focus',
  expandingEdgeIds,
  geometryRegistry,
  onRevealNode,
  flowRibbons,
  focusNodeId,
  childMap,
  hoverPool,
  hoverBudget = 500,
  offCanvasLineage,
  onBringInOffCanvas,
  layerNames,
}: {
  nodes: any[],
  edges: any[],
  expandedNodes: Set<string>,
  selectEdge: (id: string) => void,
  isEdgePanelOpen: boolean,
  toggleEdgePanel: () => void,
  triggerRedrawRef?: React.MutableRefObject<(() => void) | null>
  isTracing?: boolean,
  traceResult?: any | null,
  highlightedEdges?: Set<string>,
  isHighlightActive?: boolean,
  resolveEdgeColor?: (edgeType: string) => string,
  /** Sibling of `resolveEdgeColor` — the ontology's stroke style for the
   *  edge's primary type, honoured by `edgeDashArray` when the edge is not
   *  a roll-up. */
  resolveEdgeStrokeStyle?: (edgeType: string) => 'solid' | 'dashed' | 'dotted',
  /** Double-click handler — used for AGGREGATED-edge drill-down. */
  onEdgeDoubleClick?: (edgeId: string) => void,
  /** When true, render arrowheads. */
  showDirection?: boolean,
  /** Which lines move (lineMotion.ts) — already resolved against calm mode
   *  and the system's reduce-motion setting by the caller. */
  motion?: LineMotion,
  /** Edge ids whose drill-down is in flight — pulses them via `.nx-edge-expanding`. */
  expandingEdgeIds?: Set<string>,
  /** Per-column geometry APIs (keyed by layer id) — estimated row rects
   *  for unmounted rows, used by pass-through detection and badge
   *  partner classification. */
  geometryRegistry?: ReadonlyMap<string, ColumnGeometryApi>,
  /** Scroll a node into view on both axes (canvas reveal mechanism) —
   *  used by the clickable overflow badges. */
  onRevealNode?: (nodeId: string) => void,
  /** Macro flow bands per (layer → layer) pair — rendered beneath the
   *  edge layer in Adaptive's summarized state. */
  flowRibbons?: FlowRibbon[],
  /** The SELECTED node, driving the Anchor Rail at once — its off-screen
   *  partners dock as proxy chips in their owning columns. A hovered node
   *  drives it after a short dwell, which this overlay times itself; the
   *  chips reach the columns through the anchor-rail store. */
  focusNodeId?: string | null,
  /** Loaded containment children by parent — what a hover on an open
   *  container lights up (hoverSpotlight). */
  childMap?: ReadonlyMap<string, readonly string[]>,
  /** In On Hover / Adaptive: every line the canvas COULD draw. A hovered
   *  entity's lines come from here, strongest first, up to `hoverBudget` —
   *  drawn by this overlay rather than by a canvas re-render per hover. */
  hoverPool?: readonly PoolLine[],
  hoverBudget?: number,
  /** Per row: lineage whose far end is not on the canvas at all (never
   *  loaded) — drawn as a stub beside the row. See ghostCues. */
  offCanvasLineage?: ReadonlyMap<string, OffCanvasLineage>,
  /** A stub's click: bring that row's off-canvas partners in. */
  onBringInOffCanvas?: (nodeId: string, side: 'in' | 'out') => void,
  /** Layer display names by id — a portal chip names where lineage goes. */
  layerNames?: ReadonlyMap<string, string>,
}) {
  // Store computed abstract edges instead of direct React nodes for virtualization
  const [computedEdges, setComputedEdges] = useState<ComputedEdge[]>([])
  // Overflow indicators — badges at top/bottom of column gutters for off-screen connections
  const [overflowBadges, setOverflowBadges] = useState<OverflowBadge[]>([])
  // Trailing edge stubs — partial curves from visible nodes toward container boundary
  // Per-node lineage indicators — tight indigo ribbons that "peek out"
  // from behind each entity card on the side(s) with lineage. The
  // ribbon is rendered in the overlay's lower z-index so the card
  // chrome hides the inboard portion — visually it reads as a soft
  // glow tab integrated into the card design rather than a separate
  // decoration. Stroke width / opacity scale with the lineage count.
  // Flow ribbons — macro volume bands between layer columns, computed per
  // updateFlow frame (≤ MAX_FLOW_RIBBONS DOM rect reads).
  const [computedRibbons, setComputedRibbons] = useState<Array<{
    key: string
    pathD: string
    width: number
    label: string
    mx: number
    my: number
    /** Band endpoints — per-band userSpaceOnUse gradient coordinates.
     *  (An objectBoundingBox gradient on a straight horizontal stroke
     *  renders NOTHING per the SVG zero-height-bbox rule.) */
    sx: number
    tx: number
    /** Y at both band ends (pre-sag) — anchors the dock ports. */
    ey: number
  }>>([])
  // Proxy edges — focus edges docked to Anchor Rail chips. The chip is a
  // real rendered element, so this is measured geometry (unlike the
  // removed pass-through layer, which drew to estimates).
  const [proxyEdges, setProxyEdges] = useState<Array<{
    id: string; source: string; target: string; pathD: string; color: string
  }>>([])
  // Ghost lines — from a row to the PORTAL chip at the viewport edge for its
  // partners scrolled out of sight sideways. One per row and side, level with
  // the row, ending under a chip that is really rendered: measured geometry.
  const [ghostLines, setGhostLines] = useState<Array<{ key: string; pathD: string; color: string }>>([])
  // Off-canvas stubs — viewport coordinates, like the badges.
  const [offCanvasStubs, setOffCanvasStubs] = useState<Array<{
    key: string; nodeId: string; side: 'in' | 'out'; x: number; y: number; count: number
  }>>([])
  // Latest off-canvas map for updateFlow, which must not take it as a
  // dependency (its identity changes whenever the projection does).
  const offCanvasRef = useRef(offCanvasLineage)
  // Rail bookkeeping — refs so updateFlow never needs new dependencies.
  // dockedProxyIds bounds per-frame DOM lookups to chips that actually
  // exist (≤ rail cap per column), regardless of the focus node's fan.
  // The rail's focus: the selection at once, else a hovered node after a
  // dwell (`railTimerRef`) — `focusNodeIdRef` is whichever holds.
  const focusNodeIdRef = useRef<string | null>(null)
  const selectedFocusRef = useRef<string | null>(null)
  const dwellFocusRef = useRef<string | null>(null)
  const railTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const railFingerprintRef = useRef('')
  const dockedProxyIdsRef = useRef<Set<string>>(new Set())
  // Column periphery emission gate (see the summary block in updateFlow).
  const peripheryFpRef = useRef('')
  // Viewport tracking for virtualization
  const [viewport, setViewport] = useState({ scrollTop: 0, clientHeight: typeof window !== 'undefined' ? window.innerHeight : 1000 })
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const updateFlowRef = useRef<(() => void) | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  // Mouse position in viewport coordinates — used to position the hover panel
  // via React Portal at document body, escaping the canvas's stacking context.
  const [hoverMousePos, setHoverMousePos] = useState<{ x: number; y: number } | null>(null)
  // Persistent element cache — survives across updateFlow calls, cleared on node changes
  const elementCacheRef = useRef(new Map<string, HTMLElement>())
  // The hover spotlight (see "Hover spotlight" below) and the row elements it
  // has marked lit — read by the row observer too, which marks lit rows the
  // virtualizer mounts mid-hover.
  const spotlightRef = useRef<Spotlight | null>(null)
  const litRowsRef = useRef<HTMLElement[]>([])

  // Expand/collapse signal for the observer effects. The SET REFERENCE
  // (not its .size) — every expand/collapse mint a fresh Set upstream, so
  // the reference changes on ANY structural change, including
  // membership-preserving ones (collapse-one + expand-another) where the
  // size is unchanged. Keying on .size missed those and left the observer
  // rebuild (which clears stale visibility) from firing.
  const expandedNodesFingerprint = expandedNodes

  // Staged-change lookup map — keyed by edge ID. Recomputed when the staging
  // store's changes array changes; reads inside the edge .map() are O(1).
  const stagedEdgeChanges = useStagedChangesStore(s => s.changes)
  const stagedEdgeColorByEdgeId = useMemo(() => {
    const m = new Map<string, string>()
    stagedEdgeChanges.forEach(c => {
      if (c.type === 'create_edge') m.set(c.targetId, '#4ade80')
      else if (c.type === 'delete_edge') m.set(c.targetId, '#f87171')
      else if (c.type === 'edit_edge' || c.type === 'reverse_edge') m.set(c.targetId, '#fbbf24')
    })
    return m
  }, [stagedEdgeChanges])

  // Pre-bucket edges by their layer-node DOM-id endpoints so each redraw
  // can iterate O(visible-edges) instead of O(E). Recomputed only when
  // the `edges` reference itself changes — the index is consulted with
  // the latest `globalVisibleNodes` membership inside updateFlow.
  const edgeIndex = useMemo(() => {
    const bySource = new Map<string, any[]>()
    const byTarget = new Map<string, any[]>()
    for (const edge of edges) {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`
      let sList = bySource.get(sourceId)
      if (!sList) { sList = []; bySource.set(sourceId, sList) }
      sList.push(edge)
      let tList = byTarget.get(targetId)
      if (!tList) { tList = []; byTarget.set(targetId, tList) }
      tList.push(edge)
    }
    return { bySource, byTarget }
  }, [edges])


  // Debounced update function using requestAnimationFrame
  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      if (updateFlowRef.current) {
        updateFlowRef.current()
      }
    })
  }, [])

  useEffect(() => {
    offCanvasRef.current = offCanvasLineage
    scheduleUpdate()
  }, [offCanvasLineage, scheduleUpdate])

  // Clear periphery summaries and the rail when the overlay unmounts (lineage
  // flow toggled off) so columns never show stale counts or chips.
  useEffect(() => () => {
    useColumnPeripheryStore.getState().clear()
    useAnchorRailStore.getState().clear()
  }, [])

  // Selection changes redraw the overlay so the rail recomputes; the
  // ref keeps updateFlow's identity stable.
  useEffect(() => {
    selectedFocusRef.current = focusNodeId ?? null
    focusNodeIdRef.current = focusNodeId ?? dwellFocusRef.current
    scheduleUpdate()
  }, [focusNodeId, scheduleUpdate])

  // A hovered entity's lines, in On Hover / Adaptive — indexed by end once
  // per pool, ranked and capped once per hovered entity.
  const hoverPoolIndex = useMemo(() => {
    if (!hoverPool) return null
    const byEnd = new Map<string, PoolLine[]>()
    for (const line of hoverPool) {
      for (const end of line.source === line.target ? [line.source] : [line.source, line.target]) {
        let list = byEnd.get(end)
        if (!list) { list = []; byEnd.set(end, list) }
        list.push(line)
      }
    }
    return byEnd
  }, [hoverPool])
  const hoverLinesMemo = useRef<{ index: unknown; hovered: string | null; budget: number; lines: readonly PoolLine[] }>(
    { index: null, hovered: null, budget: 0, lines: [] },
  )
  const hoverLinesFor = useCallback((hovered: string | null): readonly PoolLine[] => {
    if (!hovered || !hoverPoolIndex) return []
    const memo = hoverLinesMemo.current
    if (memo.index !== hoverPoolIndex || memo.hovered !== hovered || memo.budget !== hoverBudget) {
      const all = hoverPoolIndex.get(hovered) ?? []
      hoverLinesMemo.current = {
        index: hoverPoolIndex,
        hovered,
        budget: hoverBudget,
        lines: all.length > hoverBudget ? [...all].sort(bySignificance).slice(0, hoverBudget) : all,
      }
    }
    return hoverLinesMemo.current.lines
  }, [hoverPoolIndex, hoverBudget])

  // Update paths function with optimizations
  const updateFlow = useCallback(() => {
    if (!containerRef.current) return
    // Read from the DOM, where the rows write it — never canvas state, so a
    // hover costs this pass and not a canvas re-render (hoverSpotlight.ts).
    const hovered = document.documentElement.dataset.hoveredNode ?? null

    const containerRect = containerRef.current.getBoundingClientRect()
    // Find scroll parent once
    if (!scrollParentRef.current) {
      // The outer canvas scroll container is `overflow-auto` (both axes),
      // NOT `overflow-y-auto` (that's the per-COLUMN scroller). Matching
      // only the latter bound the wrong ancestor (or null), leaving
      // viewport.scrollTop/clientHeight stale for the edge-virtualization cull.
      scrollParentRef.current = containerRef.current.closest('.overflow-auto') as HTMLElement
      if (scrollParentRef.current) {
        const sp = scrollParentRef.current
        setViewport(prev => nextViewport(prev, sp.scrollTop, sp.clientHeight))
      } else {
        setViewport(prev => nextViewport(prev, 0, containerRect.height || window.innerHeight))
      }
    }

    const newComputedEdges: ComputedEdge[] = []

    // Reuse persistent element cache (cleared on node changes via effect)
    const elementCache = elementCacheRef.current

    // ── Single-pass edge processing ──────────────────────────────────────
    // Classifies each edge as active (both visible), overflow (one visible),
    // or skip (neither visible) — avoiding a second iteration over all edges.
    const GUTTER_HALF = 24
    const BADGE_BUCKET = 80
    const MAX_BADGE_PARTNERS = 8
    const containerH = containerRect.height
    // Visible viewport box — the overlay's parent IS the outer
    // overflow-auto scroll container. Used to classify off-screen
    // partners into up/down/left/right.
    const viewportRect = containerRef.current.parentElement?.getBoundingClientRect() ?? containerRect

    const buckets = new Map<string, { gutterXs: number[], ys: number[], direction: OverflowDirection, colors: string[], edgeCount: number, partnerIds: string[], partnerSet: Set<string>, layerId: string | null, partnerLayerIds: Set<string>, ghostStarts: Map<string, { sx: number; sy: number; color: string }> }>()

    // Helper: look up or cache a DOM element. A cached element that has
    // DETACHED (expand/collapse and the virtualizer remount rows under
    // the SAME layer-node-* id) must never be reused — its
    // getBoundingClientRect returns stale coordinates, which is exactly
    // how ghost ribbons/badges end up drawn over empty canvas. Validate
    // isConnected and re-query when stale.
    const getEl = (id: string): HTMLElement | null => {
      let el = elementCache.get(id) || null
      if (el && !el.isConnected) {
        elementCache.delete(id)
        el = null
      }
      if (!el) {
        el = document.getElementById(id)
        if (el) elementCache.set(id, el)
      }
      return el
    }

    // Helper: clip box of the column scroller that owns a node element.
    // The overlay is NOT clipped by column scrollers, but the cards are —
    // the IntersectionObserver's rootMargin keeps rows "visible" up to
    // 100px past the clip edge, so anything anchored to such a row would
    // paint orphaned marks over empty canvas. Rect lookups are cached per
    // scroller per pass.
    const clipRects = new Map<Element, DOMRect>()
    const getClipRect = (el: HTMLElement): DOMRect | null => {
      const scroller = el.closest('.overflow-y-auto')
      if (!scroller) return null
      let r = clipRects.get(scroller)
      if (!r) {
        r = scroller.getBoundingClientRect()
        clipRects.set(scroller, r)
      }
      return r
    }
    // A row counts as in-column when its vertical center is inside the
    // owning scroller's clip box (more than half hidden → treat as gone).
    const isCenterClipped = (el: HTMLElement, rect: DOMRect): boolean => {
      const clip = getClipRect(el)
      if (!clip) return false
      const cy = rect.top + rect.height / 2
      return cy < clip.top || cy > clip.bottom
    }

    // Helper: estimated viewport-space rect for an UNMOUNTED node via the
    // column geometry registry (≤ a handful of columns; pure Map lookups
    // until the owning column is found).
    const estimateNodeRect = (nodeId: string): { top: number; height: number; left: number; right: number } | null => {
      if (!geometryRegistry) return null
      for (const api of geometryRegistry.values()) {
        if (api.hasNode(nodeId)) return api.getNodeRect(nodeId)
      }
      return null
    }

    // Per-pass caches for the overflow branch. A visible row's lines to
    // partners scrolled out of its column can number in the hundreds, and
    // a column scroll re-runs this pass every frame: read each row's rect
    // (and walk to its column's clip) once, and place each off-screen
    // partner once, rather than once per line. Measured on a 145-line board
    // with 3,490 such lines: ~9ms a frame, spent almost entirely here.
    const anchorCache = new Map<string, { rect: DOMRect } | null>()
    const overflowAnchor = (domId: string): { rect: DOMRect } | null => {
      let hit = anchorCache.get(domId)
      if (hit !== undefined) return hit
      const el = getEl(domId)
      if (!el || el.hasAttribute('data-fold-anchor')) {
        hit = null
      } else {
        const rect = el.getBoundingClientRect()
        hit = isCenterClipped(el, rect) ? null : { rect }
      }
      anchorCache.set(domId, hit)
      return hit
    }
    const partnerRects = new Map<string, { top: number; height: number; left: number; right: number } | null>()
    const partnerRect = (nodeId: string) => {
      let hit = partnerRects.get(nodeId)
      if (hit === undefined) {
        hit = getEl(`layer-node-${nodeId}`)?.getBoundingClientRect() ?? estimateNodeRect(nodeId)
        partnerRects.set(nodeId, hit)
      }
      return hit
    }

    // ── Anchor Rail collection (focus-scoped) ───────────────────────────
    // Edges incident to the SELECTED node whose partner row is scrolled
    // out of its column dock that partner as a proxy chip. Aggregation is
    // O(focus-incident candidate edges); the layer lookup is cached per
    // partner.
    const focusId = focusNodeIdRef.current
    const focusDomId = focusId ? `layer-node-${focusId}` : null
    const proxyCandidates = new Map<string, AnchorProxyCandidate>()
    const proxyEdgesNext: Array<{ id: string; source: string; target: string; pathD: string; color: string }> = []
    const owningLayerCache = new Map<string, string | null>()
    const findOwningLayer = (nodeId: string): string | null => {
      if (!geometryRegistry) return null
      const cached = owningLayerCache.get(nodeId)
      if (cached !== undefined) return cached
      let hit: string | null = null
      for (const [layerId, api] of geometryRegistry.entries()) {
        if (api.hasNode(nodeId)) { hit = layerId; break }
      }
      owningLayerCache.set(nodeId, hit)
      return hit
    }

    // Collect only edges with at least one endpoint currently in the
    // viewport — bounded by O(visible-edges) instead of O(E). Dedup via a
    // Set since an edge can appear in both indices when both endpoints
    // are visible.
    const candidateEdges = new Set<any>()
    globalVisibleNodes.forEach(nodeId => {
      const fromSrc = edgeIndex.bySource.get(nodeId)
      if (fromSrc) for (const e of fromSrc) candidateEdges.add(e)
      const fromTgt = edgeIndex.byTarget.get(nodeId)
      if (fromTgt) for (const e of fromTgt) candidateEdges.add(e)
    })
    for (const e of hoverLinesFor(hovered)) candidateEdges.add(e)

    candidateEdges.forEach(edge => {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`
      const sourceVisible = globalVisibleNodes.has(sourceId)
      const targetVisible = globalVisibleNodes.has(targetId)

      // ── Active edge: both endpoints visible ───────────────────────────
      if (sourceVisible && targetVisible) {
        const sourceEl = getEl(sourceId)
        const targetEl = getEl(targetId)

        // Two FOLDED layers (LayerColumn's fold anchors): the reader is not
        // looking at either, and a line between two spines is a tangle 6px
        // long. Lines between a spine and an open column are what the fold
        // is for, and draw below as usual.
        if (sourceEl?.hasAttribute('data-fold-anchor') && targetEl?.hasAttribute('data-fold-anchor')) return

        if (sourceEl && targetEl) {
          const sRect = sourceEl.getBoundingClientRect()
          const tRect = targetEl.getBoundingClientRect()
          // Both ends out of sight on the SAME side: the line never crosses
          // the view, so it costs a path and paints nothing.
          if ((sRect.right < viewportRect.left && tRect.right < viewportRect.left)
            || (sRect.left > viewportRect.right && tRect.left > viewportRect.right)) return

          const box = (r: DOMRect) => ({
            left: r.left - containerRect.left,
            right: r.right - containerRect.left,
            top: r.top - containerRect.top,
            height: r.height,
          })
          const { pathD, sx, sy, tx, ty } = routeLine(
            box(sRect), box(tRect), edge.groupIndex || 0, edge.source === edge.target,
          )
          const minY = Math.min(sy, ty)
          const maxY = Math.max(sy, ty)

          const primaryType = edge.types && edge.types.length > 0 ? edge.types[0] : (edge.originalType || '')
          const typeColor = resolveEdgeColor ? resolveEdgeColor(primaryType) : '#3b82f6'
          const dashArray = edgeDashArray(edge.isGhost || false, resolveEdgeStrokeStyle?.(primaryType))

          let color = typeColor
          let edgeOpacity = 0.6 + (edge.confidence || 0.4) * 0.4

          let baseStrokeWidth = 1.8
          if (edge.isBundled) {
            baseStrokeWidth = Math.min(2 + Math.log2(edge.edgeCount) * 0.6, 4)
          } else if (edge.isAggregated) {
            baseStrokeWidth = 2.2
          }

          let dynamicStrokeWidth = baseStrokeWidth

          const isEdgeHighlighted = isHighlightActive && highlightedEdges?.has(edge.id)
          const isEdgeDimmed = isHighlightActive && !highlightedEdges?.has(edge.id)

          let isTraceEdge = false
          let isFocusIncident = false
          if (isTracing && traceResult) {
            edgeOpacity = edge.isGhost ? 0.4 : 0.8
            dynamicStrokeWidth = baseStrokeWidth + 1
            const srcInUpstream = traceResult.upstreamNodes?.has(edge.source)
            const tgtInUpstream = traceResult.upstreamNodes?.has(edge.target)
            const srcInDownstream = traceResult.downstreamNodes?.has(edge.source)
            const tgtInDownstream = traceResult.downstreamNodes?.has(edge.target)

            if (srcInUpstream || tgtInUpstream) {
              color = '#06b6d4'
            } else if (srcInDownstream || tgtInDownstream) {
              color = '#f59e0b'
            } else if (!edge.isGhost) {
              color = '#a78bfa'
            }

            const focusId = traceResult.focusId
            isFocusIncident = !!focusId && (
              edge.source === focusId || edge.target === focusId
            )

            if (!srcInUpstream && !tgtInUpstream && !srcInDownstream && !tgtInDownstream && !isFocusIncident) {
              edgeOpacity = edge.isGhost ? 0.05 : 0.1
              dynamicStrokeWidth = Math.max(1, baseStrokeWidth - 1)
            } else {
              // Trace participants — including focus-incident — get the soft
              // outer drop-shadow glow via the `nx-edge-trace` class. The
              // stroke itself stays at the regular trace width so the focus
              // edges read as part of the same set rather than as bolded
              // emphasis lines.
              isTraceEdge = true
            }
          } else {
            if (isEdgeHighlighted) {
              edgeOpacity = 0.9
              dynamicStrokeWidth = baseStrokeWidth + 1
            } else if (isEdgeDimmed) {
              edgeOpacity = edge.isGhost ? 0.05 : 0.1
              dynamicStrokeWidth = Math.max(1, baseStrokeWidth - 1)
            } else {
              edgeOpacity = edgeOpacity * 0.5
              dynamicStrokeWidth = baseStrokeWidth * 0.75
            }
          }

          if (edge.isGhost) edgeOpacity = Math.min(0.7, edgeOpacity)

          const delegation = delegatedLineState(edge, hovered)
          if (delegation === 'hidden') return
          if (delegation === 'faint') {
            edgeOpacity = 0.15
            dynamicStrokeWidth = Math.max(1, baseStrokeWidth * 0.7)
          }

          newComputedEdges.push({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            minY, maxY, pathD, color, dynamicStrokeWidth, edgeOpacity,
            isGhost: edge.isGhost || false,
            isBundled: edge.isBundled || false,
            edgeCount: edge.edgeCount || 0,
            dashArray,
            sx, sy, tx, ty,
            types: Array.isArray(edge.types) && edge.types.length > 0
              ? edge.types
              : edge.originalType ? [edge.originalType] : [],
            confidence: edge.confidence || 0,
            isTraceEdge,
            isFocusIncident,
            isReverseFlow: !!edge.isReverseFlow,
            isBrowseBundle: !!(edge as any).isBrowseBundle,
            isBidirectional: !!(edge as any).isBidirectional,
          })
        }
        return
      }

      // ── Overflow edge: exactly one endpoint visible ───────────────────
      if (sourceVisible === targetVisible) return // neither visible — skip

      const visibleNodeId = sourceVisible ? sourceId : targetId
      const offscreenNodeId = sourceVisible ? targetId : sourceId
      const offscreenRawId = sourceVisible ? edge.target : edge.source

      // Distinguish SCROLLED-OFF from COLLAPSED-AWAY. An overflow mark
      // promises "there's a connection to something you can scroll to."
      // When a parent is collapsed, its descendants leave every column's
      // flat tree entirely — an overflow stub toward such a node points
      // at nothing reachable (the user would have to re-expand), and it
      // strands as a ghost after the collapse. The geometry registry's
      // hasNode is backed by the live flat-tree index, so a node absent
      // from every column has been collapsed away: skip its overflow
      // mark. (Guarded on the registry existing so we never suppress
      // legitimate overflow when geometry isn't wired.)
      if (geometryRegistry && !findOwningLayer(offscreenRawId)) return

      // A spine already marks every line it holds with a pin; a stub or a
      // badge hung off it as well would be the same fact twice. A row mostly
      // hidden by its column's clip is skipped too — its stubs/badges would
      // anchor to a card the user can't see. Active edges are exempt (they
      // bridge real cards and carry scroll continuity); these single-row
      // decorations are not.
      const anchor = overflowAnchor(visibleNodeId)
      if (!anchor) return
      const vRect = anchor.rect
      const gutterX = sourceVisible
        ? vRect.right - containerRect.left + GUTTER_HALF
        : vRect.left - containerRect.left - GUTTER_HALF
      const sy = vRect.top + vRect.height / 2 - containerRect.top

      // 4-way partner classification: exact DOM rect when the partner is
      // mounted (including mounted-but-horizontally-off-viewport cards),
      // registry estimate for vertically-unmounted rows, legacy y-guess
      // as a last resort. Dominant overshoot axis picks the direction so
      // horizontal scrolling gets left/right badges instead of a
      // meaningless up/down.
      const partnerId = offscreenNodeId.slice('layer-node-'.length)
      const pRect = partnerRect(partnerId)
      let direction: OverflowDirection
      if (pRect) {
        const px = (pRect.left + pRect.right) / 2
        const py = pRect.top + pRect.height / 2
        const dx = px < viewportRect.left ? px - viewportRect.left : px > viewportRect.right ? px - viewportRect.right : 0
        const dy = py < viewportRect.top ? py - viewportRect.top : py > viewportRect.bottom ? py - viewportRect.bottom : 0
        if (dx === 0 && dy === 0) {
          // Inside the viewport box but outside the IO margin edge case —
          // keep the legacy vertical guess.
          direction = sy > containerH * 0.5 ? 'up' : 'down'
        } else if (Math.abs(dy) >= Math.abs(dx)) {
          direction = dy < 0 ? 'up' : 'down'
        } else {
          direction = dx < 0 ? 'left' : 'right'
        }
      } else {
        direction = sy > containerH * 0.5 ? 'up' : 'down'
      }

      const primaryType = edge.types?.[0] || edge.originalType || ''
      const color = resolveEdgeColor ? resolveEdgeColor(primaryType) : '#3b82f6'

      // ── Anchor Rail docking ───────────────────────────────────────────
      // Focus-incident edge whose partner is scrolled away VERTICALLY in
      // an on-screen column: dock the partner as a proxy chip there.
      // (Horizontally off-viewport columns can't host a visible chip —
      // those keep the existing left/right badges.) When the chip is
      // already mounted, the edge anchors to its real rect and replaces
      // the anonymous stub/badge — identity instead of a count. DOM
      // lookups are gated on the docked-id set, so a hub with a huge fan
      // costs Map increments only.
      if (
        focusDomId &&
        (sourceId === focusDomId || targetId === focusDomId) &&
        (direction === 'up' || direction === 'down')
      ) {
        const owningLayer = findOwningLayer(partnerId)
        if (owningLayer) {
          const bundleCount = (edge.edgeCount as number) || 1
          const prev = proxyCandidates.get(partnerId)
          if (prev) prev.count += bundleCount
          else proxyCandidates.set(partnerId, { nodeId: partnerId, layerId: owningLayer, count: bundleCount, color, direction })
          if (dockedProxyIdsRef.current.has(partnerId)) {
            const chipEl = document.getElementById(`anchor-proxy-${partnerId}`)
            if (chipEl) {
              const cRect = chipEl.getBoundingClientRect()
              const chipCy = (cRect.top + cRect.bottom) / 2 - containerRect.top
              const chipCx = (cRect.left + cRect.right) / 2 - containerRect.left
              const focusCx = (vRect.left + vRect.right) / 2 - containerRect.left
              let pathD: string
              if (Math.abs(chipCx - focusCx) < 40) {
                // Same column — bow out through the left lane.
                const px = vRect.left - containerRect.left - 8
                const ex2 = cRect.left - containerRect.left - 4
                const bow = Math.min(px, ex2) - 36
                pathD = `M ${px} ${sy} C ${bow} ${sy}, ${bow} ${chipCy}, ${ex2} ${chipCy}`
              } else if (chipCx > focusCx) {
                const px = vRect.right - containerRect.left + 6
                const ex2 = cRect.left - containerRect.left - 4
                pathD = `M ${px} ${sy} C ${px + (ex2 - px) * 0.4} ${sy}, ${ex2 - (ex2 - px) * 0.15} ${chipCy}, ${ex2} ${chipCy}`
              } else {
                const px = vRect.left - containerRect.left - 8
                const ex2 = cRect.right - containerRect.left + 4
                pathD = `M ${px} ${sy} C ${px + (ex2 - px) * 0.4} ${sy}, ${ex2 - (ex2 - px) * 0.15} ${chipCy}, ${ex2} ${chipCy}`
              }
              proxyEdgesNext.push({
                id: `proxy-edge-${edge.source}-${edge.target}`,
                source: sourceId, target: targetId, pathD, color,
              })
              return // the docked edge replaces the stub/badge for this connection
            }
          }
        }
      }

      const isHorizontal = direction === 'left' || direction === 'right'
      // Vertical buckets group PER LAYER — the layer that OWNS THE
      // PARTNER, because an up/down badge is a navigation promise:
      // "scroll THIS column up/down to find these". Keying/positioning
      // on the visible endpoint's column drew "↑ 86" over a column with
      // one entity while all 86 partners lived in a different column
      // (and clicking it scrolled that other column). One up-badge and
      // one down-badge per partner column, count = that layer's
      // off-screen connections; gutter-x bucketing remains the fallback
      // when the registry can't resolve the partner. Horizontal buckets
      // group by the visible endpoint's row band so badges land next to
      // the rows whose partners are off-screen sideways.
      const partnerLayer = isHorizontal ? null : findOwningLayer(partnerId)
      const bucketKey = isHorizontal
        ? `${direction}-${Math.round(sy / BADGE_BUCKET) * BADGE_BUCKET}`
        : `${partnerLayer ?? Math.round(gutterX / BADGE_BUCKET) * BADGE_BUCKET}-${direction}`
      // Badge x — over the PARTNER's column when its rect (real or
      // registry-estimated) is known, clamped into the viewport;
      // otherwise the visible endpoint's gutter.
      const badgeX = !isHorizontal && pRect
        ? Math.max(
            viewportRect.left - containerRect.left + 40,
            Math.min(
              viewportRect.right - containerRect.left - 40,
              (pRect.left + pRect.right) / 2 - containerRect.left,
            ),
          )
        : gutterX
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { gutterXs: [], ys: [], direction, colors: [], edgeCount: 0, partnerIds: [], partnerSet: new Set(), layerId: partnerLayer, partnerLayerIds: new Set(), ghostStarts: new Map() })
      }
      const bucket = buckets.get(bucketKey)!
      bucket.gutterXs.push(badgeX)
      bucket.ys.push(sy)
      bucket.edgeCount++
      // Distinct partner ENTITIES — kept separately from edgeCount so the
      // tooltip's "+N more" never subtracts entities from edges.
      bucket.partnerSet.add(partnerId)
      if (!bucket.colors.includes(color)) bucket.colors.push(color)
      if (bucket.partnerIds.length < MAX_BADGE_PARTNERS && !bucket.partnerIds.includes(partnerId)) {
        bucket.partnerIds.push(partnerId)
      }

      // Sideways: the badge becomes a PORTAL that names where the lineage
      // goes, and the row gets ONE ghost line to it — per row and side, not
      // per edge, and level with the row. The per-edge trailing stubs this
      // file once had ran every row to a SHARED exit point on the edge, so a
      // tall column fanned into a moiré that never felt tied to a card; a
      // line per row at the row's own height cannot fan.
      if (isHorizontal) {
        const owner = findOwningLayer(partnerId)
        if (owner) bucket.partnerLayerIds.add(owner)
        if (!bucket.ghostStarts.has(visibleNodeId)) {
          bucket.ghostStarts.set(visibleNodeId, {
            sx: direction === 'right' ? vRect.right - containerRect.left + 6 : vRect.left - containerRect.left - 8,
            sy,
            color,
          })
        }
      }
    })

    // Keep the previous array when nothing moved — see rowEquality.ts. A scroll
    // or resize tick that changes no geometry must cost zero edge renders.
    setComputedEdges(prev => (sameRows(prev, newComputedEdges) ? prev : newComputedEdges))

    // ── Per-node lineage ribbons ────────────────────────────────────────
    //
    // For every visible entity that has lineage on either side, emit a
    // tight indigo ribbon that PEEKS OUT from behind the card's edge.
    // The overlay sits at z-[5] and the card chrome at z-[10]+, so the
    // inboard portion of the ribbon is hidden naturally by the card —
    // the visible result is a soft glow tab attached to the card edge.
    // No external spacing, no floating decorations, no arrows trying to
    // bridge gaps. Just a quiet "this side has lineage" indicator that
    // reads as part of the card design.
    //
    // The ribbon vertical extent is sized to the card's own height
    // (45%) so it always feels proportional, whether the entity is a
    // tall layer card or a tight leaf row.
    // Per-node in/out + external hairlines used to be computed here from
    // node rects and drawn in this overlay. They are now rendered INSIDE
    // each FlatTreeItem (anchored to the row box), so they track the
    // card's width/position and unmount with it — no overlay coordinate
    // math, no stale/offset/ghost marks. Nothing to emit here.

    // Vertical buckets attributed to a column fold into that column's
    // PERIPHERY SUMMARY — LayerColumn merges them into its own
    // "↑ N rows · M connections" chips, so rows and connections read as
    // one labeled statement instead of two unlabeled numbers floating
    // near each other. Floating badges remain only for buckets that
    // can't be attributed to a column: all horizontal (left/right)
    // directions plus the rare unresolvable-partner vertical fallback.
    const badges: OverflowBadge[] = []
    const ghostLinesNext: Array<{ key: string; pathD: string; color: string }> = []
    const peripherySummaries: Record<string, ColumnPeripherySummary> = {}
    buckets.forEach((bucket) => {
      const horizontal = bucket.direction === 'left' || bucket.direction === 'right'
      if (!horizontal && bucket.layerId) {
        const s = peripherySummaries[bucket.layerId] ??= { upEdges: 0, upEntities: 0, upPartnerIds: [], downEdges: 0, downEntities: 0, downPartnerIds: [] }
        if (bucket.direction === 'up') {
          s.upEdges += bucket.edgeCount
          s.upEntities += bucket.partnerSet.size
          for (const id of bucket.partnerIds) {
            if (s.upPartnerIds.length >= PERIPHERY_PARTNER_CAP) break
            if (!s.upPartnerIds.includes(id)) s.upPartnerIds.push(id)
          }
        } else {
          s.downEdges += bucket.edgeCount
          s.downEntities += bucket.partnerSet.size
          for (const id of bucket.partnerIds) {
            if (s.downPartnerIds.length >= PERIPHERY_PARTNER_CAP) break
            if (!s.downPartnerIds.includes(id)) s.downPartnerIds.push(id)
          }
        }
        return
      }
      // SCROLLPORT-relative coordinates — the badge layer is a sticky
      // pin at the scroll container's viewport corner. Content-space
      // coordinates here previously EXTENDED the scrollable area: an
      // HTML badge placed at "viewport right" in content space sits
      // past the columns, so every scroll revealed more scrollable
      // width — the canvas scrolled horizontally forever.
      const viewX = (x: number) => x + containerRect.left - viewportRect.left
      const viewY = (y: number) => y + containerRect.top - viewportRect.top
      const avgY = bucket.ys.reduce((a, b) => a + b, 0) / bucket.ys.length
      if (horizontal) {
        // The portal chip hugs the edge (see the badge layer); its ghost
        // lines end just inside it, under the chip, so each reads as
        // running INTO it.
        const ex = bucket.direction === 'right'
          ? viewportRect.right - containerRect.left - PORTAL_INSET - 4
          : viewportRect.left - containerRect.left + PORTAL_INSET + 4
        bucket.ghostStarts.forEach((start, rowId) => {
          const reach = ex - start.sx
          // A row that itself runs past the edge (its column is the one the
          // edge cuts) is already AT the portal — a line would run backwards.
          if ((bucket.direction === 'right' ? reach : -reach) < 12) return
          ghostLinesNext.push({
            key: `${bucket.direction}:${rowId}`,
            pathD: `M ${start.sx} ${start.sy} C ${start.sx + reach * 0.45} ${start.sy}, ${ex - reach * 0.2} ${avgY}, ${ex} ${avgY}`,
            color: start.color,
          })
        })
      }
      badges.push({
        gutterX: horizontal
          ? (bucket.direction === 'left' ? PORTAL_INSET : viewportRect.width - PORTAL_INSET)
          : viewX(bucket.gutterXs.reduce((a, b) => a + b, 0) / bucket.gutterXs.length),
        y: horizontal
          ? viewY(avgY)
          : (bucket.direction === 'up' ? 52 : viewportRect.height - 30),
        direction: bucket.direction,
        count: bucket.edgeCount,
        color: bucket.colors[0] || '#3b82f6',
        partnerIds: bucket.partnerIds,
        partnerTotal: bucket.partnerSet.size,
        partnerLayerIds: [...bucket.partnerLayerIds],
      })
    })
    setOverflowBadges(prev => (sameRows(prev, badges) ? prev : badges))
    setGhostLines(prev => (sameRows(prev, ghostLinesNext) ? prev : ghostLinesNext))

    // ── Off-canvas stubs — lineage whose far end was never loaded ─────────
    // Per visible row, beside its card and inside the viewport only: the
    // badge layer is pinned to the viewport, and anything placed past its
    // edge would widen the scrollable area (the bug the badge layer's
    // sticky pin exists to prevent).
    const stubsNext: Array<{ key: string; nodeId: string; side: 'in' | 'out'; x: number; y: number; count: number }> = []
    const offCanvas = offCanvasRef.current
    if (offCanvas && offCanvas.size > 0) {
      globalVisibleNodes.forEach(domId => {
        const nodeId = domId.slice('layer-node-'.length)
        const lineage = offCanvas.get(nodeId)
        if (!lineage) return
        const el = getEl(domId)
        if (!el || el.hasAttribute('data-fold-anchor')) return
        const r = el.getBoundingClientRect()
        if (isCenterClipped(el, r)) return
        // In the row's upper third, not on its centre line: the centre is
        // where the column's own same-column lanes attach, in the same half
        // of the gap, and a count sitting on them reads as theirs.
        const y = r.top + r.height * 0.3 - viewportRect.top
        if (y < 0 || y > viewportRect.height) return
        const right = r.right - viewportRect.left
        const left = r.left - viewportRect.left
        if (lineage.out > 0 && right >= 0 && right + OFF_CANVAS_STUB_WIDTH <= viewportRect.width) {
          stubsNext.push({ key: `${nodeId}:out`, nodeId, side: 'out', x: right, y, count: lineage.out })
        }
        if (lineage.in > 0 && left - OFF_CANVAS_STUB_WIDTH >= 0 && left <= viewportRect.width) {
          stubsNext.push({ key: `${nodeId}:in`, nodeId, side: 'in', x: left, y, count: lineage.in })
        }
      })
    }
    setOffCanvasStubs(prev => (sameRows(prev, stubsNext) ? prev : stubsNext))
    setProxyEdges(prev => (sameRows(prev, proxyEdgesNext) ? prev : proxyEdgesNext))

    // Periphery emission — through the dedicated store so only the
    // columns whose numbers changed re-render (never the canvas), and
    // only when content actually changed (this pass runs per frame).
    const peripheryFp = Object.keys(peripherySummaries).sort().map(k => {
      const s = peripherySummaries[k]
      return `${k}:${s.upEdges}:${s.upEntities}:${s.upPartnerIds.join(',')}:${s.downEdges}:${s.downEntities}:${s.downPartnerIds.join(',')}`
    }).join('|')
    if (peripheryFp !== peripheryFpRef.current) {
      peripheryFpRef.current = peripheryFp
      useColumnPeripheryStore.getState().setSummaries(peripherySummaries)
    }

    // Rail payload — pushed to React only on real content change (this
    // pass runs per frame during scroll). The docked-id set updates in
    // lockstep so next frame's edges anchor to the freshly-mounted chips.
    //
    // TRANSIENT-EMPTY GUARD: an empty candidate frame while the SAME node
    // stays focused is visibility flicker (observer rebuild, resize
    // churn), not user intent — emitting it would unmount the chips and,
    // worse, feed an emit → canvas re-render → observer churn → emit
    // oscillation. Keep the existing rail through those frames; the rail
    // clears when focus changes or ends.
    const railGroups = groupAnchorProxies(proxyCandidates.values())
    const railFp = anchorRailFingerprint(focusId, railGroups)
    const prevFp = railFingerprintRef.current
    const prevFocusId = prevFp === '' ? null : prevFp.split('|', 1)[0]
    const transientEmpty = railFp === '' && focusId !== null && prevFocusId === focusId
    if (railFp !== prevFp && !transientEmpty) {
      railFingerprintRef.current = railFp
      dockedProxyIdsRef.current = new Set(
        Array.from(railGroups.values()).flatMap(g => g.proxies.map(p => p.nodeId)),
      )
      useAnchorRailStore.getState().publish(railFp === '' ? new Map() : railGroups, railFp === '' ? null : focusId)
    }

    // Flow ribbons — one gradient band per (layer → layer) pair, stacked
    // around the viewport's vertical center, thickness log-scaled to
    // total volume. Bounded work: ≤ MAX_FLOW_RIBBONS column-rect reads.
    {
      const nextRibbons: typeof computedRibbons = []
      if (flowRibbons && flowRibbons.length > 0) {
        const maxCount = Math.max(...flowRibbons.map(r => r.count))
        const widths = flowRibbons.map(r =>
          Math.max(10, Math.min(38, 10 + 28 * (Math.log2(1 + r.count) / Math.log2(1 + maxCount)))))
        const GAP = 12
        const totalH = widths.reduce((a, b) => a + b + GAP, -GAP)
        const centerY = (viewportRect.top + viewportRect.bottom) / 2 - containerRect.top
        let yCursor = centerY - totalH / 2
        flowRibbons.forEach((r, i) => {
          const w = widths[i]
          const bandY = yCursor + w / 2
          yCursor += w + GAP
          const srcEl = document.querySelector(`[data-layer-id="${CSS.escape(r.sourceLayerId)}"]`)
          const tgtEl = document.querySelector(`[data-layer-id="${CSS.escape(r.targetLayerId)}"]`)
          if (!srcEl || !tgtEl) return
          const s = srcEl.getBoundingClientRect()
          const t = tgtEl.getBoundingClientRect()
          const sx = s.right - containerRect.left + 4
          const tx = t.left - containerRect.left - 4
          if (tx <= sx) return // reverse-flow pair — bands read left→right only
          const spread = Math.max((tx - sx) * 0.4, 40)
          // Gentle sag so the band reads as flow, not a ruler line (and
          // the path's bbox is never zero-height).
          const sag = Math.min(28, (tx - sx) * 0.04) + i * 2
          nextRibbons.push({
            key: `${r.sourceLayerId}->${r.targetLayerId}`,
            pathD: `M ${sx} ${bandY} C ${sx + spread} ${bandY + sag}, ${tx - spread} ${bandY + sag}, ${tx} ${bandY}`,
            width: w,
            label: `${formatRibbonCount(r.count)} flows`,
            mx: (sx + tx) / 2,
            my: bandY + sag * 0.75,
            sx,
            tx,
            ey: bandY,
          })
        })
      }
      setComputedRibbons(prev => (prev.length === 0 && nextRibbons.length === 0 ? prev : nextRibbons))
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeIndex, selectEdge, isEdgePanelOpen, toggleEdgePanel, isTracing, traceResult, highlightedEdges, isHighlightActive, resolveEdgeColor, resolveEdgeStrokeStyle, hoveredEdgeId, geometryRegistry, flowRibbons, hoverLinesFor])

  // NOTE: an earlier "pass-through edges" layer drew ESTIMATED dashed
  // curves for edges whose endpoints were both unmounted. Removed after
  // repeated user testing: ambient edges anchored to estimated positions
  // of content that is not on screen consistently read as broken
  // ("lines going to nodes that don't exist"). Off-screen awareness is
  // carried by layers that never fake geometry: per-node hairline
  // indicators, directional badges (count + click-to-jump), density
  // gutters, and flow ribbons.

  // Store updateFlow in ref for ResizeObserver access and expose to parent
  useEffect(() => {
    updateFlowRef.current = updateFlow
    if (triggerRedrawRef) {
      triggerRedrawRef.current = scheduleUpdate
    }
  }, [updateFlow, scheduleUpdate, triggerRedrawRef])

  // Flow-ribbon changes need a redraw because updateFlow's identity
  // changes but the observers above don't refire — without this, swapping
  // the ribbon set leaves the previous geometry until the next
  // scroll / resize / hover.
  useEffect(() => {
    scheduleUpdate()
  }, [flowRibbons, scheduleUpdate])

  // ResizeObserver + IntersectionObserver for node elements.
  // Uses MutationObserver to dynamically track layer-node-* elements as they're
  // added/removed by the virtualizer (which mounts/unmounts DOM elements on scroll).
  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    // Drawer open/close width-animates the canvas for ~400ms, which fires
    // EVERY node's ResizeObserver each animation frame; each fire funnels
    // into updateFlow's mass getBoundingClientRect (forced reflow), pinning
    // the main thread on large graphs. Leading+trailing throttle: redraw at
    // most once per RESIZE_THROTTLE_MS during the animation, with a
    // guaranteed trailing settle pass so edges land on final anchors.
    // Scroll/hover keep their per-frame rAF cadence (separate effects).
    const RESIZE_THROTTLE_MS = 120
    let lastResizeRun = 0
    let resizeTrailingTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      const now = Date.now()
      if (now - lastResizeRun >= RESIZE_THROTTLE_MS) {
        lastResizeRun = now
        scheduleUpdate()
      } else if (resizeTrailingTimer === null) {
        resizeTrailingTimer = setTimeout(() => {
          resizeTrailingTimer = null
          lastResizeRun = Date.now()
          scheduleUpdate()
        }, RESIZE_THROTTLE_MS)
      }
    })

    // VISIBLE = in view VERTICALLY, anywhere sideways. The root is the canvas
    // scroller with an unbounded sideways margin, so a row in a column
    // scrolled out of sight sideways still counts: it is mounted, its rect is
    // real, and the line to it is drawn exactly — running off the edge of the
    // view toward it, as a line does in any diagram. Measured against the
    // WINDOW, as this was, every such row dropped out, and scrolling sideways
    // cut every line to a column the moment it left the view (it became a
    // portal chip instead). Vertically nothing changes: IntersectionObserver
    // clips through every ancestor up to its root, so a row scrolled out of
    // its own column is still out.
    const scroller = container.parentElement || container
    // Fresh IntersectionObserver per effect lifecycle (no stale singleton)
    const visibilityObserver = new IntersectionObserver((entries) => {
      let changed = false
      entries.forEach(entry => {
        const id = entry.target.id
        if (!id) return
        if (entry.isIntersecting) {
          if (!globalVisibleNodes.has(id)) {
            globalVisibleNodes.add(id)
            changed = true
          }
        } else {
          if (globalVisibleNodes.has(id)) {
            globalVisibleNodes.delete(id)
            changed = true
          }
        }
      })
      if (changed) scheduleUpdate()
    }, {
      root: scroller,
      rootMargin: `${VISIBLE_MARGIN_PX}px ${SIDEWAYS_REACH_PX}px`,
      threshold: 0,
    })

    // Track which elements we're currently observing
    const observedElements = new Set<Element>()

    const observeElement = (el: Element) => {
      if (observedElements.has(el)) return
      observedElements.add(el)
      resizeObserver.observe(el)
      visibilityObserver.observe(el)
      // A lit row the virtualizer mounts mid-hover arrives lit.
      const spot = spotlightRef.current
      if (spot && el instanceof HTMLElement && spot.rows.has(el.id.slice('layer-node-'.length))) {
        el.setAttribute('data-spot-lit', '')
        litRowsRef.current.push(el)
      }
    }

    const unobserveElement = (el: Element) => {
      if (!observedElements.has(el)) return
      observedElements.delete(el)
      resizeObserver.unobserve(el)
      visibilityObserver.unobserve(el)
      if (el.id) {
        globalVisibleNodes.delete(el.id)
        // Evict the detached element so a remount re-queries a fresh
        // one instead of anchoring to a stale rect (ghost marks).
        elementCacheRef.current.delete(el.id)
      }
    }

    // The overlay is a sibling of the layer columns, so we need to observe
    // the common parent that contains both.
    const observeRoot = container.parentElement || container

    // Observe the CONTAINER itself, not just the node rows. Opening/closing
    // the EntityDrawer (or any panel) narrows the canvas without necessarily
    // resizing the fixed-width columns — so node ResizeObservers may never
    // fire, leaving ribbons/badges anchored to their pre-drawer positions.
    // A container-level observer guarantees a redraw on that width change.
    resizeObserver.observe(observeRoot)
    if (observeRoot !== container) resizeObserver.observe(container)

    // Scan for already-present node elements. SEED visibility synchronously
    // from rect math (mirroring the IO config: window root + 100px margin):
    // this effect re-runs whenever the node set changes identity, and its
    // cleanup just cleared globalVisibleNodes — waiting for the async
    // IntersectionObserver callbacks would leave the edge layer BLANK for
    // a frame or more on every rebuild (visible as edges blinking on
    // graph updates). The IO then confirms/corrects the seeded state.
    const seedVisibility = (el: Element, box: DOMRect) => {
      if (!el.id || globalVisibleNodes.has(el.id)) return
      const r = el.getBoundingClientRect()
      if (
        r.bottom >= box.top - VISIBLE_MARGIN_PX && r.top <= box.bottom + VISIBLE_MARGIN_PX &&
        (r.width > 0 || r.height > 0)
      ) {
        globalVisibleNodes.add(el.id)
      }
    }
    const scanAndObserve = () => {
      const box = scroller.getBoundingClientRect()
      observeRoot.querySelectorAll('[id^="layer-node-"]').forEach(el => {
        seedVisibility(el, box)
        observeElement(el)
      })
    }
    scanAndObserve()

    // Re-scan after next frame — virtualizer may mount items slightly after this effect runs
    const scanRaf = requestAnimationFrame(() => {
      scanAndObserve()
      scheduleUpdate()
    })

    // MutationObserver to pick up elements added/removed by the virtualizer
    const mutationObserver = new MutationObserver((mutations) => {
      let changed = false
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added instanceof HTMLElement) {
            if (added.id?.startsWith('layer-node-')) {
              observeElement(added)
              changed = true
            }
            added.querySelectorAll('[id^="layer-node-"]').forEach(el => {
              observeElement(el)
              changed = true
            })
          }
        }
        for (const removed of mutation.removedNodes) {
          if (removed instanceof HTMLElement) {
            if (removed.id?.startsWith('layer-node-')) {
              unobserveElement(removed)
              changed = true
            }
            removed.querySelectorAll('[id^="layer-node-"]').forEach(el => {
              unobserveElement(el)
              changed = true
            })
          }
        }
      }
      if (changed) scheduleUpdate()
    })

    mutationObserver.observe(observeRoot, { childList: true, subtree: true })

    return () => {
      cancelAnimationFrame(scanRaf)
      if (resizeTrailingTimer !== null) {
        clearTimeout(resizeTrailingTimer)
        resizeTrailingTimer = null
      }
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      visibilityObserver.disconnect()
      observedElements.clear()
      globalVisibleNodes.clear()
      elementCacheRef.current.clear()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [nodes, expandedNodesFingerprint, scheduleUpdate])

  // Attach scroll listener to the parent container for Viewport Edge Virtualization
  useEffect(() => {
    if (!containerRef.current) return
    // Outer scroll container is `overflow-auto` (see updateFlow note).
    const scrollParent = containerRef.current.closest('.overflow-auto') as HTMLElement
    if (!scrollParent) return

    let rafId: number | null = null
    const handleScroll = () => {
      if (rafId !== null) return // debounce
      rafId = requestAnimationFrame(() => {
        setViewport(prev => nextViewport(prev, scrollParent.scrollTop, scrollParent.clientHeight))
        rafId = null
      })
    }

    // Capture initial
    handleScroll()

    scrollParent.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll, { passive: true })

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      scrollParent.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [])

  // Listeners for window resize and scroll
  useEffect(() => {
    // Initial draw with longer timeout to account for animation duration
    const timer = setTimeout(() => {
      requestAnimationFrame(() => {
        updateFlow()
      })
    }, 400)

    // Resize
    const handleResize = () => scheduleUpdate()
    window.addEventListener('resize', handleResize)

    // Scroll
    const handleScroll = () => scheduleUpdate()
    window.addEventListener('scroll', handleScroll, true)

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
      clearTimeout(timer)
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [updateFlow, scheduleUpdate, expandedNodesFingerprint])

  // ── 4.2 Hover spotlight ─────────────────────────────────────────────────────
  //
  // Hovering an entity lights it, its lines and the entities at their far
  // ends, and dims the rest (hoverSpotlight.ts). All of it is applied here,
  // straight to the DOM, so a hover re-renders nothing:
  //
  //  * lines — `data-flow-hover` on this container and `data-edge-hot` on the
  //    lit lines; globals.css dims the others;
  //  * rows — `data-row-spotlight` on the canvas scroller dims every card and
  //    `data-spot-lit` keeps the lit ones lit. A row the virtualizer mounts
  //    mid-hover is marked as it arrives (the row observer below). Marks,
  //    not a generated stylesheet: rewriting a <style> restyled all ~4,600
  //    elements on the page per hover (26–40 ms each, measured); a mark
  //    restyles the rows it touches;
  //  * the drawn set — a hover can ADD lines (the hovered entity's own in On
  //    Hover / Adaptive, an open container's own it stood aside for): one
  //    measure pass here;
  //  * the Anchor Rail — follows a hovered entity after a dwell, lingers after.
  //
  // It used to be canvas state: every change of the hovered row re-rendered
  // ContextViewCanvas, every column, row and line — 100–180 ms of main thread
  // per row the pointer crossed (measured 2026-09-21).
  //
  // A `MutationObserver` on the one attribute the rows write drives it — no
  // polling. No spotlight during a trace, or while a selection's own
  // highlight is on: a click highlight wins over hover, as it always has.
  const hotEdgesRef = useRef<SVGGElement[]>([])
  const spotlightScrollerRef = useRef<HTMLElement | null>(null)
  // Latest inputs for the observer callback, which is bound once. Synced
  // before the recompute effect below, which reads them.
  const spotlightInputs = useRef({ edges, childMap, allowed: true, hoverLinesFor })
  useEffect(() => {
    spotlightInputs.current = { edges, childMap, allowed: !isTracing && !isHighlightActive, hoverLinesFor }
  })

  /** Mark the lit lines. Re-run after every render too: React may have
   *  re-created the <g> elements. O(drawn lines), only while a spotlight is on. */
  const markHotLines = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    // Detached nodes (React re-rendered under us) ignore this harmlessly.
    for (const g of hotEdgesRef.current) g.removeAttribute('data-edge-hot')
    hotEdgesRef.current = []
    const spot = spotlightRef.current
    if (!spot) {
      container.removeAttribute('data-flow-hover')
      return
    }
    container.setAttribute('data-flow-hover', '')
    const hot: SVGGElement[] = []
    container.querySelectorAll<SVGGElement>('g[data-edge-id]').forEach(g => {
      if (spot.lines.has(g.getAttribute('data-edge-id') ?? '')) {
        g.setAttribute('data-edge-hot', '')
        hot.push(g)
      }
    })
    hotEdgesRef.current = hot
  }, [])
  useEffect(() => { markHotLines() })

  const applySpotlight = useCallback(() => {
    const scroller = containerRef.current?.parentElement
    if (!scroller) return
    const hovered = document.documentElement.dataset.hoveredNode ?? null
    const { edges: lines, childMap: children, allowed, hoverLinesFor: linesOf } = spotlightInputs.current
    const spot = allowed && hovered
      ? hoverSpotlight(hovered, children ?? EMPTY_CHILD_MAP, concat(lines, linesOf(hovered)))
      : null
    spotlightRef.current = spot
    for (const el of litRowsRef.current) el.removeAttribute('data-spot-lit')
    litRowsRef.current = []
    if (spot) {
      for (const id of spot.rows) {
        const el = document.getElementById(`layer-node-${id}`)
        if (el) {
          el.setAttribute('data-spot-lit', '')
          litRowsRef.current.push(el)
        }
      }
    }
    scroller.toggleAttribute('data-row-spotlight', spot !== null)
    spotlightScrollerRef.current = scroller
    markHotLines()
  }, [markHotLines])

  // The board under a hover changed (lines, the selection's highlight, a
  // trace starting): the spotlight follows.
  useEffect(() => {
    applySpotlight()
  }, [edges, childMap, isTracing, isHighlightActive, hoverLinesFor, applySpotlight])

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const onHover = () => {
      applySpotlight()
      const hovered = document.documentElement.dataset.hoveredNode ?? null
      // The rail follows a hovered entity only once the pointer DWELLS (a
      // drive-by must not flash chips), and when the hover ends it LINGERS
      // long enough for the pointer to travel to a chip — a rail that
      // dismissed itself en route could never be used.
      if (railTimerRef.current) clearTimeout(railTimerRef.current)
      railTimerRef.current = setTimeout(() => {
        railTimerRef.current = null
        dwellFocusRef.current = hovered
        const next = selectedFocusRef.current ?? hovered
        if (next !== focusNodeIdRef.current) {
          focusNodeIdRef.current = next
          scheduleUpdate()
        }
      }, hovered ? RAIL_DWELL_MS : RAIL_LINGER_MS)
      // A hover can add lines — its own, and an open container's own.
      scheduleUpdate()
    }
    const observer = new MutationObserver(onHover)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-hovered-node'],
    })
    return () => {
      observer.disconnect()
      if (railTimerRef.current) clearTimeout(railTimerRef.current)
    }
  }, [applySpotlight, scheduleUpdate])

  useEffect(() => () => {
    for (const el of litRowsRef.current) el.removeAttribute('data-spot-lit')
    spotlightScrollerRef.current?.removeAttribute('data-row-spotlight')
  }, [])

  const VIEWPORT_MARGIN = 400
  // VERY FAST Virtualization Filter: Only render edges that intersect the scroll
  // viewport. Memoized: this ran on EVERY render of the overlay, re-walking the
  // full edge list each time — and with the two guards above the common render is
  // now one where neither `computedEdges` nor `viewport` moved at all.
  const visibleEdges = useMemo(() => computedEdges.filter(edge => {
    if (edge.maxY < viewport.scrollTop - VIEWPORT_MARGIN) return false
    if (edge.minY > viewport.scrollTop + viewport.clientHeight + VIEWPORT_MARGIN) return false
    return true
  }), [computedEdges, viewport])

  // Publish how many edges are actually PAINTED — `visibleEdges`, the
  // viewport-culled subset the `<g data-edge-id>` elements are rendered from,
  // not the wider `computedEdges` set it is culled out of — for
  // ConnectionsPanel's "N drawn". Zeroed on unmount, which is also when
  // Lineage is off.
  const setDrawn = useDrawnEdgesStore(s => s.setDrawn)
  useEffect(() => {
    setDrawn(visibleEdges.length)
    return () => setDrawn(0)
  }, [visibleEdges.length, setDrawn])

  // ── Density-adaptive render tier (lineDensity.ts) ─────────────────────
  //
  // Premium  (≤ 200 visible)    — per-edge gradient, dashed roll-ups.
  // Standard (201 – 800)        — solid colour strokes.
  // Coalesced (> 800)           — the same; hit paths go focus-only.
  //
  // Sticky by 10% at each boundary, so a count landing in batches around
  // one does not flip the board's look per batch. The hovered, selected and
  // trace-focus lines keep the premium treatment in every tier. What MOVES
  // is decided separately (LineMotionLayer).
  const [renderTier, setRenderTier] = useState<RenderTier>('premium')
  const nextTier = nextRenderTier(visibleEdges.length, renderTier)
  if (nextTier !== renderTier) setRenderTier(nextTier)
  // "Always" moves every line only while the board is sparse; past that it
  // is the flicker this setting exists to prevent, so it falls back to focus.
  const lineMotion: LineMotion = motion === 'all' && renderTier !== 'premium' ? 'focus' : motion

  // ── Shared SVG defs — one marker per unique color, one gradient per color+direction ──
  // Avoids creating 500+ <marker> and 200+ <linearGradient> elements per render.
  const sharedDefs = useMemo(() => {
    const markerColors = new Set<string>()
    // Include ALL visible edges (ghost or not) — ghost edges represent finer-
    // level lineage delegated up to a visible ancestor (e.g. column→column
    // TRANSFORMS bubbled to the parent Dataset). They are still directional
    // and the user must see where the data flows.
    visibleEdges.forEach(e => markerColors.add(e.color))

    return {
      markerColors: Array.from(markerColors),
      gradientKeys: [] as string[],
    }
  }, [visibleEdges])

  // Display names for badge tooltips — id → name over the rendered node
  // hierarchy (children included so partners below collapsed roots still
  // resolve).
  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>()
    const stack: Array<{ id?: string; name?: string; children?: unknown[] }> = [...nodes]
    while (stack.length > 0) {
      const n = stack.pop()
      if (!n?.id) continue
      if (!m.has(n.id)) m.set(n.id, n.name ?? n.id)
      if (Array.isArray(n.children)) stack.push(...(n.children as typeof stack))
    }
    return m
  }, [nodes])

  // Badge click → reveal the nearest off-screen partner (estimated
  // distance to the viewport center; ≤ MAX_BADGE_PARTNERS lookups).
  const handleBadgeClick = useCallback((badge: OverflowBadge) => {
    if (!onRevealNode || badge.partnerIds.length === 0) return
    let pick = badge.partnerIds[0]
    const vp = containerRef.current?.parentElement?.getBoundingClientRect()
    if (vp && badge.partnerIds.length > 1) {
      const centerX = vp.left + vp.width / 2
      const centerY = vp.top + vp.height / 2
      let best = Infinity
      for (const id of badge.partnerIds) {
        let rect: { top: number; height: number; left: number; right: number } | null =
          document.getElementById(`layer-node-${id}`)?.getBoundingClientRect() ?? null
        if (!rect && geometryRegistry) {
          for (const api of geometryRegistry.values()) {
            if (api.hasNode(id)) { rect = api.getNodeRect(id); break }
          }
        }
        if (!rect) continue
        const d = Math.abs(rect.top + rect.height / 2 - centerY)
          + Math.abs((rect.left + rect.right) / 2 - centerX)
        if (d < best) { best = d; pick = id }
      }
    }
    onRevealNode(pick)
  }, [onRevealNode, geometryRegistry])

  // Hit-layer handlers — hoisted so the extracted HitLayer / FocusHitLayer
  // components below can share them.
  const handleHitEnter = useCallback((edgeId: string, e: React.MouseEvent) => {
    setHoveredEdgeId(edgeId)
    setHoverMousePos({ x: e.clientX, y: e.clientY })
  }, [])
  const handleHitMove = useCallback((e: React.MouseEvent) => {
    setHoverMousePos({ x: e.clientX, y: e.clientY })
  }, [])
  const handleHitLeave = useCallback(() => {
    setHoveredEdgeId(null)
    setHoverMousePos(null)
  }, [])
  const handleHitClick = useCallback((edgeId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    selectEdge(edgeId)
    if (!isEdgePanelOpen) toggleEdgePanel()
  }, [selectEdge, isEdgePanelOpen, toggleEdgePanel])
  const handleHitDoubleClick = useCallback((edgeId: string, e: React.MouseEvent) => {
    if (!onEdgeDoubleClick) return
    e.stopPropagation()
    e.preventDefault()
    onEdgeDoubleClick(edgeId)
  }, [onEdgeDoubleClick])

  return (
    <>
    {/* ── VISUAL LAYER ─── z-[5]: behind node columns, no pointer events ── */}
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-[5]">
      <svg className="w-full h-full overflow-visible pointer-events-none">
        <defs>
          <style>
            {`
              @keyframes edgeFlow {
                to { stroke-dashoffset: -28; }
              }
              .edge-direction-flow {
                animation: edgeFlow 1.4s linear infinite;
              }
              @keyframes lineageStubFlow {
                to { stroke-dashoffset: -14; }
              }
              .lineage-stub-flow {
                animation: lineageStubFlow 1.6s linear infinite;
              }
              .lineage-stub-group {
                transition: opacity 220ms ease;
              }
              @media (prefers-reduced-motion: reduce) {
                .edge-direction-flow, .lineage-stub-flow {
                  animation: none;
                }
              }
            `}
          </style>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>

          {/* Shared arrowhead markers — one per unique color.
              Sized 12×10: discreet but readable. Direction is also encoded
              in the per-edge gradient stroke (faded at source, full color at
              target); the arrowhead is the confirming cue. Marker fill stays
              solid even when the stroke gradient is at low opacity at the
              source end, so the tip is always crisply visible. */}
          {sharedDefs.markerColors.map(c => {
            const safeId = c.replace(/[^a-zA-Z0-9]/g, '')
            return (
              <marker
                key={safeId}
                id={`arrow-${safeId}`}
                markerWidth="12"
                markerHeight="10"
                refX="11"
                refY="5"
                // auto-start-reverse lets the same marker serve markerEnd
                // (forward arrowhead) AND markerStart (reversed at the
                // source end) for bidirectional edges — one marker def per
                // color instead of two.
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <polygon points="0 0, 12 5, 0 10, 2 5" fill={c} stroke={c} strokeWidth="0.5" />
              </marker>
            )
          })}

          {/* Shared overflow gradients — one per color+direction. Vertical
              directions fade along y, horizontal (left/right) along x —
              always from the visible node toward the exit edge. */}
          {sharedDefs.gradientKeys.map(key => {
            const [c, dir] = key.split('|')
            const safeId = `of-${c.replace(/[^a-zA-Z0-9]/g, '')}-${dir}`
            const axis = dir === 'left' || dir === 'right'
              ? { x1: dir === 'left' ? '100%' : '0%', x2: dir === 'left' ? '0%' : '100%', y1: '0', y2: '0' }
              : { x1: '0', x2: '0', y1: dir === 'up' ? '100%' : '0%', y2: dir === 'up' ? '0%' : '100%' }
            return (
              <linearGradient key={safeId} id={safeId} {...axis}>
                <stop offset="0%" stopColor={c} stopOpacity="0.35" />
                <stop offset="70%" stopColor={c} stopOpacity="0.12" />
                <stop offset="100%" stopColor={c} stopOpacity="0" />
              </linearGradient>
            )
          })}
        </defs>
        {/* ── Flow ribbons — macro volume bands beneath the edge layer.
            Sankey-style: thickness encodes total edge count between the
            two layers; the count pill states it exactly. Per-band
            userSpaceOnUse gradients (indigo → violet, brightening toward
            the consumer side) — an objectBoundingBox gradient dies on
            near-horizontal strokes. ── */}
        {computedRibbons.map((r, i) => (
          <g key={`ribbon-${r.key}`} className="pointer-events-none">
            <defs>
              <linearGradient
                id={`flow-ribbon-g-${i}`}
                gradientUnits="userSpaceOnUse"
                x1={r.sx}
                x2={r.tx}
                y1={0}
                y2={0}
              >
                <stop offset="0%" stopColor="rgb(99, 102, 241)" stopOpacity="0.16" />
                <stop offset="55%" stopColor="rgb(129, 140, 248)" stopOpacity="0.30" />
                <stop offset="100%" stopColor="rgb(139, 92, 246)" stopOpacity="0.44" />
              </linearGradient>
            </defs>
            {/* Butt caps: round caps turned band ends into detached blobs.
                Dock ports at each column edge make the band read as
                volume flowing OUT of one layer INTO the next. */}
            <path
              d={r.pathD}
              stroke={`url(#flow-ribbon-g-${i})`}
              strokeWidth={r.width}
              fill="none"
              strokeLinecap="butt"
            />
            <rect
              x={r.sx - 1.5}
              y={r.ey - (r.width * 1.15) / 2}
              width={3.5}
              height={r.width * 1.15}
              rx={1.75}
              fill="rgb(99, 102, 241)"
              opacity={0.55}
            />
            <rect
              x={r.tx - 2}
              y={r.ey - (r.width * 1.15) / 2}
              width={3.5}
              height={r.width * 1.15}
              rx={1.75}
              fill="rgb(139, 92, 246)"
              opacity={0.6}
            />
            <g transform={`translate(${r.mx}, ${r.my})`}>
              <rect x={-34} y={-10} width={68} height={20} rx={10} fill="var(--color-canvas-elevated, #fff)" opacity={0.85} />
              <rect x={-34} y={-10} width={68} height={20} rx={10} fill="rgb(99, 102, 241)" opacity={0.10} />
              <text
                x={0}
                y={3.5}
                textAnchor="middle"
                fontSize="10"
                fontWeight={650}
                fill="rgb(79, 70, 229)"
              >
                {r.label}
              </text>
            </g>
          </g>
        ))}

        {visibleEdges.map(edge => {
          const isThisEdgeHovered = hoveredEdgeId === edge.id
          const isConnectedToSelected = !!(isHighlightActive && highlightedEdges?.has(edge.id))
          // Highlight on hover OR when connected to the selected node
          const isHighlighted = isThisEdgeHovered
            || hoveredEdgeId === edge.source || hoveredEdgeId === edge.target
            || isConnectedToSelected
          // Spotlight focus modes:
          // - Click-highlight (a node is selected): edges connected to it stay
          //   full, others fade to 8%.
          // - Edge hover: the hovered edge stays full, others fade to 8%.
          // - Otherwise: nothing dims.
          // Click-highlight wins over edge-hover when both are active.
          const groupOpacity = isHighlightActive
            ? (isConnectedToSelected ? 1 : 0.08)
            : hoveredEdgeId !== null
              ? (isThisEdgeHovered ? 1 : 0.08)
              : 1
          const detailed = renderTier === 'premium' || isHighlighted
          return (
            <EdgeLine
              key={edge.id}
              edge={edge}
              groupOpacity={groupOpacity}
              isHighlighted={isHighlighted}
              isHovered={isThisEdgeHovered}
              premiumLook={detailed || !!edge.isFocusIncident}
              dash={lineDash(edge, detailed)}
              showDirection={showDirection}
              stagedColor={stagedEdgeColorByEdgeId.get(edge.id)}
              isExpanding={expandingEdgeIds?.has(edge.id) ?? false}
              // The bundle count, on the lines being looked at only: on every
              // line, the counts of a fan stacked into columns of numbers.
              // A trace keeps its wires bare (the cards say "N on this lineage").
              showCount={!isTracing && isHighlighted && edge.isBundled && edge.edgeCount > 1}
            />
          )
        })}

        {/* Per-node lineage hairlines now render inside each FlatTreeItem
            (anchored to the row box) — see FlatTreeItem. */}

        {/* ── Proxy edges — the selected node's connections docked to
            Anchor Rail chips. The chip is real rendered DOM, so this is
            measured geometry. Solid and near-full opacity: these ARE the
            focused node's flows, each with a named destination. ── */}
        {/* Ghost lines to the portal chips — dashed and faint: they say
            where lineage goes, not what it is. Under the columns like every
            line, so a row they pass reads above them. */}
        {ghostLines.map(g => (
          <path
            key={g.key}
            data-ghost-line={g.key}
            d={g.pathD}
            stroke={g.color}
            strokeWidth={1.3}
            strokeDasharray="4 5"
            fill="none"
            opacity={0.5}
            strokeLinecap="round"
            className="pointer-events-none"
          />
        ))}
        {proxyEdges.map(pe => (
          <g key={pe.id} data-edge-id={pe.id} data-edge-src={pe.source} data-edge-tgt={pe.target}>
            <path
              d={pe.pathD}
              stroke={pe.color}
              strokeWidth={1.6}
              fill="none"
              opacity={0.85}
              strokeLinecap="round"
              className="pointer-events-none"
            />
          </g>
        ))}
      </svg>
      <LineMotionLayer
        lines={visibleEdges}
        mode={lineMotion}
        hoveredEdgeId={hoveredEdgeId}
        highlighted={isHighlightActive ? highlightedEdges ?? null : null}
      />

      {/* Edge hover panel rendered via Portal — escapes the canvas's z-[5]
          stacking context so it always sits above the column content (z-10)
          and the EntityDrawer (z-50). See issue #2 fix. */}
    </div>

    {/* ── Overflow badges — interactive. A sibling of the visual layer at
        z-40 (above the z-30 columns) so the badge buttons are actually
        hit-testable; the wrapper stays pointer-events-none and only the
        buttons opt back in, so canvas interactions beneath are
        unaffected. Tooltip lists off-screen partners; click reveals the
        nearest one via the canvas's two-axis reveal mechanism. ── */}
    {/* Zero-size sticky pin at the scrollport's top-left corner: badges
        position in VIEWPORT coordinates inside it, so they can never
        extend the scrollable area (content-space badges at "viewport
        right" previously made the canvas scroll horizontally forever —
        each scroll pushed the badge, and the scroll extent, further). */}
    <div className="sticky top-0 left-0 z-40 h-0 w-0 overflow-visible pointer-events-none">
      {overflowBadges.map((badge, i) => {
        const isHorizontal = badge.direction === 'left' || badge.direction === 'right'
        if (isHorizontal) {
          // A PORTAL: where the lineage goes, named — the entity and its
          // layer, or how many and in which layers — hugging the edge it
          // leaves by. The dashed border is the ghost: this is a way out of
          // the view, not something in it.
          const names = badge.partnerIds.map(id => nodeNameById.get(id) ?? id)
          const layers = badge.partnerLayerIds.map(id => layerNames?.get(id) ?? id)
          const label = portalLabel(names, badge.partnerTotal, layers)
          const toRight = badge.direction === 'right'
          const extra = badge.partnerTotal - badge.partnerIds.length
          return (
            <div
              key={`portal-${i}`}
              className="absolute pointer-events-none"
              style={{
                left: badge.gutterX,
                top: badge.y,
                transform: toRight ? 'translate(-100%, -50%)' : 'translate(0, -50%)',
              }}
            >
              <InfoTooltip
                side={toRight ? 'left' : 'right'}
                content={
                  <div>
                    <p className="font-semibold mb-1">
                      {badge.count} {unitNoun(badge.count, 'lines')} out of sight, {toRight ? 'to the right' : 'to the left'}
                    </p>
                    {names.map((name, j) => (
                      <div key={j} className="flex items-center gap-1.5 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: badge.color }} />
                        <span className="truncate text-ink-muted">{name}</span>
                      </div>
                    ))}
                    {extra > 0 && <p className="text-ink-muted mt-0.5">+{extra} more {extra === 1 ? 'entity' : 'entities'}</p>}
                    <p className="mt-1.5 text-ink-muted italic">Click to scroll there</p>
                  </div>
                }
              >
                <button
                  type="button"
                  data-canvas-interactive
                  data-portal={badge.direction}
                  aria-label={`${label} — ${badge.count} ${unitNoun(badge.count, 'lines')} out of sight ${toRight ? 'to the right' : 'to the left'}. Scroll there`}
                  className="pointer-events-auto flex items-center gap-1 max-w-[10rem] px-2 py-[3px] rounded-full border border-dashed shadow-sm cursor-pointer hover:scale-[1.03] active:scale-95 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                  style={{
                    color: badge.color,
                    borderColor: `${badge.color}80`,
                    backgroundColor: 'color-mix(in srgb, var(--nx-bg-elevated) 92%, transparent)',
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleBadgeClick(badge)
                  }}
                >
                  {!toRight && (
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" className="flex-shrink-0" aria-hidden>
                      <path d="M8.5 3L4.5 7L8.5 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  <span className="truncate text-[10.5px] font-medium">{label}</span>
                  {toRight && (
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" className="flex-shrink-0" aria-hidden>
                      <path d="M5.5 3L9.5 7L5.5 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </InfoTooltip>
            </div>
          )
        }
        const rotation = badge.direction === 'up' ? undefined
          : badge.direction === 'down' ? 'rotate(180deg)'
          : badge.direction === 'left' ? 'rotate(-90deg)'
          : 'rotate(90deg)'
        const shown = badge.partnerIds
          .map(id => nodeNameById.get(id) ?? id)
        // Entities minus entities — subtracting the shown ENTITY names
        // from the CONNECTION count produced fictional "+178 more" lines.
        const extra = badge.partnerTotal - badge.partnerIds.length
        return (
          <div
            key={`overflow-${i}`}
            className="absolute pointer-events-none"
            style={{
              left: badge.gutterX,
              top: badge.y,
              transform: isHorizontal ? 'translate(-50%, -50%)' : 'translateX(-50%)',
            }}
          >
            <InfoTooltip
              side={isHorizontal ? (badge.direction === 'left' ? 'right' : 'left') : 'bottom'}
              content={
                <div>
                  <p className="font-semibold mb-1">
                    {badge.count} off-screen connection{badge.count === 1 ? '' : 's'}
                  </p>
                  {shown.map((name, j) => (
                    <div key={j} className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: badge.color }}
                      />
                      <span className="truncate text-ink-muted">{name}</span>
                    </div>
                  ))}
                  {extra > 0 && <p className="text-ink-muted/70 mt-0.5">+{extra} more {extra === 1 ? 'entity' : 'entities'}</p>}
                  <p className="mt-1.5 text-ink-muted/60 italic">Click to scroll to it</p>
                </div>
              }
            >
              {/* Glass pill — same visual family as the column's
                  "N above / N below" chips (rounded-full, backdrop blur,
                  color-tinted glass, soft color glow, scale on hover) so
                  the off-screen affordances read as one system. */}
              <button
                type="button"
                data-canvas-interactive
                className="pointer-events-auto flex items-center gap-1 px-2 py-[3px] rounded-full backdrop-blur-md border border-white/10 shadow-md cursor-pointer hover:scale-105 active:scale-95 transition-transform"
                style={{
                  color: badge.color,
                  backgroundColor: `${badge.color}22`,
                  boxShadow: `0 4px 14px ${badge.color}25`,
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  handleBadgeClick(badge)
                }}
              >
                {/* Chevron */}
                <svg
                  width="12" height="12" viewBox="0 0 14 14" fill="none"
                  className="flex-shrink-0"
                  style={rotation ? { transform: rotation } : undefined}
                >
                  <path
                    d="M3 8.5L7 4.5L11 8.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {/* Count */}
                <span className="text-[10px] font-semibold tabular-nums leading-none">
                  {badge.count}
                </span>
              </button>
            </InfoTooltip>
          </div>
        )
      })}
      {offCanvasStubs.map(stub => (
        <OffCanvasStub
          key={stub.key}
          side={stub.side}
          count={stub.count}
          x={stub.x}
          y={stub.y}
          onBringIn={onBringInOffCanvas ? () => onBringInOffCanvas(stub.nodeId, stub.side) : undefined}
        />
      ))}
    </div>
    {hoveredEdgeId && hoverMousePos && (() => {
      const edge = computedEdges.find(e => e.id === hoveredEdgeId)
      if (!edge) return null
      // Resolve source/target node display names via DOM — the elementCache
      // already has the rendered node refs.
      const sourceEl = document.getElementById(`layer-node-${edge.source}`)
      const targetEl = document.getElementById(`layer-node-${edge.target}`)
      // A line into a folded layer ends on a fold anchor, which carries the
      // row's name as `data-label` (LayerColumn) instead of the row's text.
      const sourceName = sourceEl?.querySelector('.line-clamp-2')?.textContent?.trim()
        || sourceEl?.getAttribute('data-label') || edge.source
      const targetName = targetEl?.querySelector('.line-clamp-2')?.textContent?.trim()
        || targetEl?.getAttribute('data-label') || edge.target
      const typeLabel = edge.types.length > 0 ? edge.types.join(' · ') : 'RELATIONSHIP'
      const confPct = edge.confidence > 0 ? Math.round(edge.confidence * 100) : null

      // Position above-right of the cursor; flip below if near top, left if near right edge.
      const margin = 18
      const panelW = 280
      const panelH = 140
      let left = hoverMousePos.x + margin
      let top = hoverMousePos.y - panelH - margin
      if (left + panelW > window.innerWidth - 8) left = hoverMousePos.x - panelW - margin
      if (top < 8) top = hoverMousePos.y + margin

      return createPortal(
        <div
          className="fixed pointer-events-none"
          style={{ left, top, zIndex: 9999, width: panelW }}
          role="tooltip"
        >
          <div
            className="rounded-xl border shadow-2xl px-3.5 py-3"
            style={{
              background: 'rgba(15, 17, 23, 0.96)',
              backdropFilter: 'blur(14px)',
              borderColor: `${edge.color}55`,
              boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px ${edge.color}33`,
            }}
          >
            {/* Type chip header */}
            <div className="flex items-center gap-2 mb-2 pb-2 border-b border-white/[0.06]">
              <span
                className="px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider uppercase"
                style={{ background: `${edge.color}22`, color: edge.color, border: `1px solid ${edge.color}44` }}
              >
                {typeLabel}
              </span>
              {edge.edgeCount > 1 && (
                <span className="text-[10px] text-white/50 tabular-nums">
                  ×{edge.edgeCount.toLocaleString()} bundled
                </span>
              )}
              {edge.isBidirectional && (
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider"
                  style={{ background: `${edge.color}1a`, color: edge.color, border: `1px solid ${edge.color}33` }}
                  title="Flow exists in both directions between these endpoints"
                >
                  Two-way
                </span>
              )}
            </div>

            {/* Source → Target with arrow */}
            <div className="flex items-center gap-2 text-[12px] leading-tight">
              <div className="flex-1 min-w-0">
                <p className="text-[9px] font-semibold uppercase tracking-wider text-white/40 mb-0.5">From</p>
                <p className="text-white/90 truncate font-medium" title={sourceName}>{sourceName}</p>
              </div>
              <svg width="22" height="14" viewBox="0 0 22 14" className="flex-shrink-0">
                <defs>
                  <marker id="hover-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <polygon points="0 0, 5 3, 0 6" fill={edge.color} />
                  </marker>
                </defs>
                <line x1="2" y1="7" x2="16" y2="7" stroke={edge.color} strokeWidth="1.5" markerEnd="url(#hover-arrow)" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-[9px] font-semibold uppercase tracking-wider text-white/40 mb-0.5">To</p>
                <p className="text-white/90 truncate font-medium" title={targetName}>{targetName}</p>
              </div>
            </div>

            {confPct !== null && (
              <div className="flex items-center gap-1.5 mt-2.5 pt-2 border-t border-white/[0.06]">
                <span className="text-[9px] uppercase tracking-wider text-white/40">Confidence</span>
                <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${confPct}%`, backgroundColor: edge.color }} />
                </div>
                <span className="text-[10px] text-white/70 tabular-nums font-semibold">{confPct}%</span>
              </div>
            )}

            <p className="text-[9px] text-white/30 mt-2 italic">Click to open details · Double-click to drill in</p>
          </div>
        </div>,
        document.body,
      )
    })()}

    {/* ── HIT LAYER ─── z-20: above columns, transparent, only click/hover paths ──
     *  Positioned identically to the visual layer but invisible. Sits above the
     *  z-10 column container.
     *
     *  Pointer-events policy: each <path> uses `pointer-events: stroke` (set via
     *  inline style — Tailwind has no utility) so events fire only when the
     *  pointer is on the actual stroked geometry, not the path's bounding box.
     *  Combined with a tighter strokeWidth (6 vs the prior 14), this keeps the
     *  whole canvas clickable at high edge density — clicks anywhere off an
     *  edge fall through to the node layer below.
     *
     *  Density gate: above HIT_DENSITY_LIMIT visible edges, a full per-edge
     *  hit overlay would form a coverage mesh that occludes nodes. In that
     *  regime we render a FOCUS-scoped hit layer instead: edges incident to
     *  the hovered/selected node (bounded by one node's fan, not the canvas
     *  total) stay hoverable and clickable, so every visible relationship
     *  remains interrogable at any density. Nodes always remain clickable.
     */}
    {visibleEdges.length <= HIT_DENSITY_LIMIT ? (
      <HitLayer
        edges={visibleEdges}
        onEnter={handleHitEnter}
        onMove={handleHitMove}
        onLeave={handleHitLeave}
        onClickEdge={handleHitClick}
        onDoubleClickEdge={handleHitDoubleClick}
      />
    ) : (
      <FocusHitLayer
        visibleEdges={visibleEdges}
        hoveredEdgeId={hoveredEdgeId}
        highlightedEdges={highlightedEdges}
        isHighlightActive={isHighlightActive}
        onEnter={handleHitEnter}
        onMove={handleHitMove}
        onLeave={handleHitLeave}
        onClickEdge={handleHitClick}
        onDoubleClickEdge={handleHitDoubleClick}
      />
    )}
    </>
  )
}

/**
 * One drawn line — still. What moves is LineMotionLayer's.
 *
 * Memoised by VALUE: every measure pass builds fresh ComputedEdge objects, so
 * identity says nothing, and while one column scrolls most lines on the board
 * have not moved. Only the ones that did re-render.
 */
interface EdgeLineProps {
  edge: ComputedEdge
  groupOpacity: number
  isHighlighted: boolean
  isHovered: boolean
  premiumLook: boolean
  dash: string
  showDirection: boolean
  stagedColor: string | undefined
  isExpanding: boolean
  showCount: boolean
}

const LINE_TRANSITION = { transition: 'opacity 0.12s ease' }

const EdgeLine = React.memo(function EdgeLine({
  edge, groupOpacity, isHighlighted, isHovered, premiumLook, dash, showDirection,
  stagedColor, isExpanding, showCount,
}: EdgeLineProps) {
  const { pathD, color, dynamicStrokeWidth, edgeOpacity, isGhost, sx, sy, tx, ty } = edge
  // Per-edge gradient id — direction is encoded in the stroke itself. Fades
  // from a soft tint of the type color at the source to full saturation at
  // the target. Only premium-look edges get one; the rest take the solid
  // colour (the arrowhead still gives the direction).
  const gradId = `edge-grad-${edge.id.replace(/[^a-zA-Z0-9]/g, '')}`
  const coreOpacity = isHighlighted ? Math.min(0.95, edgeOpacity * 1.2) : edgeOpacity
  const marker = `url(#arrow-${color.replace(/[^a-zA-Z0-9]/g, '')})`
  const edgeClasses = [
    edge.isTraceEdge ? 'nx-edge-trace' : null,
    isExpanding ? 'nx-edge-expanding' : null,
  ].filter(Boolean).join(' ') || undefined
  return (
    <g
      data-edge-id={edge.id}
      data-edge-src={edge.source}
      data-edge-tgt={edge.target}
      className={edgeClasses}
      // Opacity inline ONLY when this line is dimmed: an inline `opacity: 1`
      // outranks the stylesheet, and the hover spotlight dims lines from
      // there (`[data-flow-hover]`, globals.css) — it never could while every
      // line carried one.
      style={groupOpacity === 1 ? LINE_TRANSITION : { opacity: groupOpacity, transition: LINE_TRANSITION.transition }}
    >
      {/* `userSpaceOnUse` from the source to the target end aligns the
          gradient to the edge's direction — approximate on a curve, right
          to the eye. */}
      {premiumLook && (
        <defs>
          <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1={sx} y1={sy} x2={tx} y2={ty}>
            <stop offset="0%" stopColor={color} stopOpacity={coreOpacity * 0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={coreOpacity} />
          </linearGradient>
        </defs>
      )}

      {/* SUBTLE GLOW — only on highlight, thin halo */}
      {isHighlighted && (
        <path
          d={pathD}
          style={{
            stroke: color,
            strokeWidth: dynamicStrokeWidth + 2,
            fill: 'none',
            strokeOpacity: edgeOpacity * 0.2,
            strokeLinecap: 'round',
            transition: 'all 0.3s ease',
          }}
          className="pointer-events-none"
        />
      )}

      {/* STAGED-CHANGE HALO — visible whenever this edge has a pending change */}
      {stagedColor && (
        <path
          d={pathD}
          style={{
            stroke: stagedColor,
            strokeWidth: dynamicStrokeWidth + 4,
            fill: 'none',
            strokeOpacity: 0.55,
            strokeLinecap: 'round',
            strokeDasharray: '4 3',
          }}
          className="pointer-events-none"
        />
      )}

      {/* CORE LINE — the gradient carries the opacity in its stops; a fixed
          opacity is used when the solid-colour fallback runs. */}
      <path
        d={pathD}
        style={{
          stroke: premiumLook ? `url(#${gradId})` : color,
          strokeWidth: dynamicStrokeWidth,
          fill: 'none',
          strokeOpacity: premiumLook ? 1 : coreOpacity,
          strokeDasharray: dash,
          strokeLinecap: 'round',
          transition: 'stroke-width 0.2s ease',
        }}
        markerEnd={showDirection ? marker : undefined}
        markerStart={showDirection && edge.isBidirectional ? marker : undefined}
        className="pointer-events-none"
      />

      {showCount && (
        <g data-edge-badge={edge.edgeCount} transform={`translate(${(sx + tx) / 2}, ${(sy + ty) / 2})`}>
          <rect x="-8" y="-6" width="16" height="12" rx="6" fill="currentColor" opacity="0.08" />
          <text x="0" y="3" fill="currentColor" fontSize="8px" fontWeight="500" textAnchor="middle" opacity="0.6">
            {edge.edgeCount}
          </text>
        </g>
      )}

      {/* Source terminal dot */}
      {!isGhost && (
        <circle cx={sx} cy={sy} r={isHighlighted ? 3 : 2.5} fill={color} style={{ opacity: edgeOpacity * 0.8, transition: 'r 0.2s ease' }} />
      )}

      {/* Endpoint rings — only on the spotlight-hovered edge, pinning both
          anchor points. */}
      {isHovered && (
        <>
          <circle cx={sx} cy={sy} r={14} fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.6} className="pointer-events-none" />
          <circle cx={tx} cy={ty} r={14} fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.6} className="pointer-events-none" />
        </>
      )}
    </g>
  )
}, (a, b) =>
  a.groupOpacity === b.groupOpacity
  && a.isHighlighted === b.isHighlighted
  && a.isHovered === b.isHovered
  && a.premiumLook === b.premiumLook
  && a.dash === b.dash
  && a.showDirection === b.showDirection
  && a.stagedColor === b.stagedColor
  && a.isExpanding === b.isExpanding
  && a.showCount === b.showCount
  && sameRow(a.edge, b.edge),
)

const HIT_DENSITY_LIMIT = 1200

type HitLayerHandlers = {
  onEnter: (edgeId: string, e: React.MouseEvent) => void
  onMove: (e: React.MouseEvent) => void
  onLeave: () => void
  onClickEdge: (edgeId: string, e: React.MouseEvent) => void
  onDoubleClickEdge: (edgeId: string, e: React.MouseEvent) => void
}

function HitLayer({ edges, onEnter, onMove, onLeave, onClickEdge, onDoubleClickEdge }: {
  edges: ComputedEdge[]
} & HitLayerHandlers) {
  return (
    <div className="absolute inset-0 pointer-events-none z-20">
      <svg className="w-full h-full overflow-visible pointer-events-none">
        {edges.map(edge => (
          <path
            key={`hit-${edge.id}`}
            d={edge.pathD}
            fill="none"
            stroke="transparent"
            strokeWidth={6}
            style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
            data-canvas-interactive
            onMouseEnter={(e) => onEnter(edge.id, e)}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            onClick={(e) => onClickEdge(edge.id, e)}
            onDoubleClick={(e) => onDoubleClickEdge(edge.id, e)}
          />
        ))}
      </svg>
    </div>
  )
}

/** Keeps the last non-null value alive for `ms` after it clears, so the
 *  pointer can travel from a node card onto an incident edge's hit path
 *  without the path unmounting underneath it. */
function useLingering(value: string | null, ms: number): string | null {
  const [lingered, setLingered] = useState<string | null>(value)
  useEffect(() => {
    if (value !== null) {
      // rAF defers the write off the effect's synchronous path; the
      // rendered output uses `value` directly while it's non-null, so
      // the one-frame lag is unobservable.
      const raf = requestAnimationFrame(() => setLingered(value))
      return () => cancelAnimationFrame(raf)
    }
    const timer = setTimeout(() => setLingered(null), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return value ?? lingered
}

/** Focus-scoped hit layer for above-HIT_DENSITY_LIMIT density: only edges
 *  incident to the hovered node, the selection-highlighted set, or the
 *  currently hovered edge get hit paths. Mounts useHoveredNodeId in this
 *  child so its rAF-driven re-renders never touch the main overlay. */
function FocusHitLayer({ visibleEdges, hoveredEdgeId, highlightedEdges, isHighlightActive, ...handlers }: {
  visibleEdges: ComputedEdge[]
  hoveredEdgeId: string | null
  highlightedEdges?: Set<string>
  isHighlightActive?: boolean
} & HitLayerHandlers) {
  const hoveredNodeId = useHoveredNodeId()
  const effectiveNode = useLingering(hoveredNodeId, 400)
  const focus = useMemo(() => visibleEdges.filter(e =>
    (effectiveNode !== null && (e.source === effectiveNode || e.target === effectiveNode)) ||
    (isHighlightActive && highlightedEdges?.has(e.id)) ||
    e.id === hoveredEdgeId
  ), [visibleEdges, effectiveNode, isHighlightActive, highlightedEdges, hoveredEdgeId])
  if (focus.length === 0) return null
  return <HitLayer edges={focus} {...handlers} />
}
