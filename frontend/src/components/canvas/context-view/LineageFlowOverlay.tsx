import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ColumnGeometryApi, ComputedEdge, OverflowBadge, OverflowDirection, OverflowEdge, PassThroughEdge } from './types'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useHoveredNodeId } from '@/hooks/useHighlightState'
import { InfoTooltip } from '../search/panel/builder-atoms/InfoTooltip'

// Global visibility tracker — which layer-node-* elements are currently in the viewport
const globalVisibleNodes = new Set<string>()

// Same-column edges route through a left lane. Lane `index`'s leftmost
// control point sits at node.left - SAME_COLUMN_LANE_START - (BASE +
// index * STEP) from the container left edge. These are exported so the
// canvas can reserve a matching scroll-content gutter (see
// EXTREMITY_EDGE_GUTTER_PX) and the two stay in sync.
export const SAME_COLUMN_LANE_START = 6
export const SAME_COLUMN_LANE_BASE = 24
export const SAME_COLUMN_LANE_STEP = 8
// Horizontal gutter reserved on each side of the layer columns so the
// outermost same-column lanes (and the rightmost columns' outgoing-edge
// starts) aren't clipped by the overflow-auto scroll container. Sized to
// keep the first 4 lanes unclipped (≈ 62px).
export const EXTREMITY_EDGE_GUTTER_PX =
  SAME_COLUMN_LANE_START + SAME_COLUMN_LANE_BASE + SAME_COLUMN_LANE_STEP * 4

export function LineageFlowOverlay({
  nodes,
  edges,
  nodeStubCounts,
  showStubs = false,
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
  onEdgeDoubleClick,
  showDirection = true,
  expandingEdgeIds,
  geometryRegistry,
  onRevealNode,
}: {
  nodes: any[],
  edges: any[],
  /**
   * Per-node lineage counts for the stub indicators. Drives a short
   * partial-edge marker on each entity card: a quiet inbound arrow on
   * the left if `in > 0`, a quiet outbound arrow on the right if
   * `out > 0`. The stubs are entity-anchored decorations — they never
   * attempt to span across to a partner node. Hover/select on an entity
   * materializes the real edges over these markers.
   */
  nodeStubCounts?: Map<string, { in: number; out: number }>,
  /** When true, render the per-node stub indicators. */
  showStubs?: boolean,
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
  /** Double-click handler — used for AGGREGATED-edge drill-down. */
  onEdgeDoubleClick?: (edgeId: string) => void,
  /** When true, render arrowheads + animated mid-edge chevron flow. */
  showDirection?: boolean,
  /** Edge ids whose drill-down is in flight — pulses them via `.nx-edge-expanding`. */
  expandingEdgeIds?: Set<string>,
  /** Per-column geometry APIs (keyed by layer id) — estimated row rects
   *  for unmounted rows, used by pass-through detection and badge
   *  partner classification. */
  geometryRegistry?: ReadonlyMap<string, ColumnGeometryApi>,
  /** Scroll a node into view on both axes (canvas reveal mechanism) —
   *  used by the clickable overflow badges. */
  onRevealNode?: (nodeId: string) => void,
}) {
  // Store computed abstract edges instead of direct React nodes for virtualization
  const [computedEdges, setComputedEdges] = useState<ComputedEdge[]>([])
  // Overflow indicators — badges at top/bottom of column gutters for off-screen connections
  const [overflowBadges, setOverflowBadges] = useState<OverflowBadge[]>([])
  // Trailing edge stubs — partial curves from visible nodes toward container boundary
  const [overflowEdges, setOverflowEdges] = useState<OverflowEdge[]>([])
  // Per-node lineage indicators — tight indigo ribbons that "peek out"
  // from behind each entity card on the side(s) with lineage. The
  // ribbon is rendered in the overlay's lower z-index so the card
  // chrome hides the inboard portion — visually it reads as a soft
  // glow tab integrated into the card design rather than a separate
  // decoration. Stroke width / opacity scale with the lineage count.
  const [computedStubs, setComputedStubs] = useState<Array<{
    nodeId: string
    side: 'in' | 'out'
    count: number
    cx: number; cy: number  // ribbon center
    width: number; height: number
    /** 'full' = three-layer ribbon (stubs mode); 'quiet' = slim always-on
     *  tab rendered in every other mode. */
    variant: 'full' | 'quiet'
  }>>([])
  // Pass-through edges — both endpoints off-viewport, path crosses the
  // visible box. Computed on a debounced settle pass (never per frame).
  const [passThroughEdges, setPassThroughEdges] = useState<PassThroughEdge[]>([])
  const passThroughTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const computePassThroughRef = useRef<(() => void) | null>(null)

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

  // Stable fingerprint for expandedNodes — O(1) instead of O(N log N) sort+join.
  // Size alone is sufficient because React will re-render when the Set reference changes,
  // and we only need this for effect dependency tracking (not equality).
  const expandedNodesFingerprint = expandedNodes.size

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

  // Update paths function with optimizations
  const updateFlow = useCallback(() => {
    if (!containerRef.current) return

    const containerRect = containerRef.current.getBoundingClientRect()
    // Find scroll parent once
    if (!scrollParentRef.current) {
      scrollParentRef.current = containerRef.current.closest('.overflow-y-auto') as HTMLElement
      if (scrollParentRef.current) {
        setViewport({
          scrollTop: scrollParentRef.current.scrollTop,
          clientHeight: scrollParentRef.current.clientHeight
        })
      } else {
        setViewport({
          scrollTop: 0,
          clientHeight: containerRect.height || window.innerHeight
        })
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
    const MAX_STUBS_PER_BUCKET = 6
    const MAX_BADGE_PARTNERS = 8
    const containerH = containerRect.height
    // Visible viewport box — the overlay's parent IS the outer
    // overflow-auto scroll container. Used to classify off-screen
    // partners into up/down/left/right.
    const viewportRect = containerRef.current.parentElement?.getBoundingClientRect() ?? containerRect

    const buckets = new Map<string, { gutterXs: number[], ys: number[], direction: OverflowDirection, colors: string[], edgeCount: number, partnerIds: string[] }>()
    const trailingEdges: OverflowEdge[] = []
    const bucketStubCount = new Map<string, number>()

    // Helper: look up or cache a DOM element
    const getEl = (id: string): HTMLElement | null => {
      let el = elementCache.get(id) || null
      if (!el) {
        el = document.getElementById(id)
        if (el) elementCache.set(id, el)
      }
      return el
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

    candidateEdges.forEach(edge => {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`
      const sourceVisible = globalVisibleNodes.has(sourceId)
      const targetVisible = globalVisibleNodes.has(targetId)

      // ── Active edge: both endpoints visible ───────────────────────────
      if (sourceVisible && targetVisible) {
        const sourceEl = getEl(sourceId)
        const targetEl = getEl(targetId)

        if (sourceEl && targetEl) {
          const sRect = sourceEl.getBoundingClientRect()
          const tRect = targetEl.getBoundingClientRect()

          let sx = sRect.right - containerRect.left + 6
          let sy = sRect.top + sRect.height / 2 - containerRect.top
          let tx = tRect.left - containerRect.left - 8
          let ty = tRect.top + tRect.height / 2 - containerRect.top

          const minY = Math.min(sy, ty)
          const maxY = Math.max(sy, ty)

          let pathD = ''
          const isSameColumn = Math.abs(sRect.left - tRect.left) < 50
          const isSelf = edge.source === edge.target
          const index = edge.groupIndex || 0
          // Sibling case: same row band, different columns. The default
          // Bézier would cut through whatever node sits between the
          // endpoints. Route through a dedicated lane above (downstream)
          // or below (upstream) the row band instead.
          const ROW_OVERLAP_PX = Math.min(sRect.height, tRect.height) * 0.5
          const isSibling = !isSelf
            && !isSameColumn
            && Math.abs(sRect.top - tRect.top) < ROW_OVERLAP_PX

          // Same-column branch — route through the LEFT gutter (instead of
          // the right-margin fan that visually collides with cross-layer
          // outgoing edges in the column gap). Every edge stays visible —
          // lineage tools must show every connection by default; rolling
          // up intra-column edges into a chip hides what the user came to see.
          if (isSameColumn && !isSelf) {
            sx = sRect.left - containerRect.left - SAME_COLUMN_LANE_START
            tx = tRect.left - containerRect.left - SAME_COLUMN_LANE_START
            const curveDist = -(SAME_COLUMN_LANE_BASE + index * SAME_COLUMN_LANE_STEP)  // negative = leftward
            pathD = `M ${sx} ${sy} C ${sx + curveDist} ${sy}, ${tx + curveDist} ${ty}, ${tx} ${ty}`
          } else if (isSibling) {
            // Direction: left-to-right (downstream) → route ABOVE the row band.
            // Right-to-left (upstream) → route BELOW. Separating directions
            // into different lanes prevents above/below collisions on the
            // same row.
            const downstream = tx > sx
            const laneOffset = (downstream ? -1 : 1) * (28 + index * 6)
            // Anchor entry/exit slightly off-centre toward the lane direction.
            // Tightened from ±30% to ±18% so the edge enters the node a hair
            // off-centre rather than at the top/bottom corner — reads cleaner
            // with the gradient stroke.
            const quadrantSign = downstream ? -1 : 1
            sy = sRect.top + sRect.height / 2 - containerRect.top + (quadrantSign * sRect.height * 0.18)
            ty = tRect.top + tRect.height / 2 - containerRect.top + (quadrantSign * tRect.height * 0.18)
            // Control points pulled vertically off the row band.
            const cx1 = sx + Math.max(40, Math.abs(tx - sx) * 0.3)
            const cx2 = tx - Math.max(40, Math.abs(tx - sx) * 0.3)
            const cy1 = sy + laneOffset
            const cy2 = ty + laneOffset
            pathD = `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${tx} ${ty}`
          } else {
            const dist = Math.abs(tx - sx)
            const spread = Math.max(dist * 0.5, 24)
            pathD = `M ${sx} ${sy} C ${sx + spread} ${sy}, ${tx - spread} ${ty}, ${tx} ${ty}`
          }

          const primaryType = edge.types && edge.types.length > 0 ? edge.types[0] : (edge.originalType || '')
          const typeColor = resolveEdgeColor ? resolveEdgeColor(primaryType) : '#3b82f6'

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

          if (edge.isDelegated) return
          if (edge.isResidual) {
            edgeOpacity = 0.15
            dynamicStrokeWidth = Math.max(1, baseStrokeWidth * 0.7)
          }

          // Reverse-flow geometric reroute only — no visual styling change.
          // The edge points back upstream (target layer < source layer);
          // routing it through a deeper sub-row arc keeps the forward
          // flow uncluttered (no zigzag through other rows). Visually it
          // reads identically to forward edges: same type color, same
          // gradient fade, same chevron animation, same arrowhead. Only
          // the path geometry differs.
          let isRev = false
          if ((edge as any).isReverseFlow) {
            isRev = true
            const dist = Math.abs(tx - sx)
            const arcDepth = Math.max(60, dist * 0.35)
            const cx1 = sx + Math.max(40, dist * 0.25)
            const cx2 = tx - Math.max(40, dist * 0.25)
            pathD = `M ${sx} ${sy} C ${cx1} ${sy + arcDepth}, ${cx2} ${ty + arcDepth}, ${tx} ${ty}`
          }

          newComputedEdges.push({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            minY, maxY, pathD, color, dynamicStrokeWidth, edgeOpacity,
            isGhost: edge.isGhost || false,
            isBundled: edge.isBundled || false,
            edgeCount: edge.edgeCount || 0,
            sx, sy, tx, ty,
            types: Array.isArray(edge.types) && edge.types.length > 0
              ? edge.types
              : edge.originalType ? [edge.originalType] : [],
            confidence: edge.confidence || 0,
            isTraceEdge,
            isFocusIncident,
            isReverseFlow: isRev,
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

      const visibleEl = getEl(visibleNodeId)
      if (!visibleEl) return

      const vRect = visibleEl.getBoundingClientRect()
      const gutterX = sourceVisible
        ? vRect.right - containerRect.left + GUTTER_HALF
        : vRect.left - containerRect.left - GUTTER_HALF
      const sx = sourceVisible
        ? vRect.right - containerRect.left + 6
        : vRect.left - containerRect.left - 8
      const sy = vRect.top + vRect.height / 2 - containerRect.top

      // 4-way partner classification: exact DOM rect when the partner is
      // mounted (including mounted-but-horizontally-off-viewport cards),
      // registry estimate for vertically-unmounted rows, legacy y-guess
      // as a last resort. Dominant overshoot axis picks the direction so
      // horizontal scrolling gets left/right badges instead of a
      // meaningless up/down.
      const partnerId = offscreenNodeId.slice('layer-node-'.length)
      const offscreenEl = getEl(offscreenNodeId)
      const pRect = offscreenEl?.getBoundingClientRect() ?? estimateNodeRect(partnerId)
      let direction: OverflowDirection
      let partnerY: number | null = null
      if (pRect) {
        const px = (pRect.left + pRect.right) / 2
        const py = pRect.top + pRect.height / 2
        partnerY = py - containerRect.top
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

      const isHorizontal = direction === 'left' || direction === 'right'
      // Vertical buckets group by gutter x; horizontal buckets group by
      // the visible endpoint's row band so badges land next to the rows
      // whose partners are off-screen sideways.
      const bucketKey = isHorizontal
        ? `${direction}-${Math.round(sy / BADGE_BUCKET) * BADGE_BUCKET}`
        : `${Math.round(gutterX / BADGE_BUCKET) * BADGE_BUCKET}-${direction}`
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, { gutterXs: [], ys: [], direction, colors: [], edgeCount: 0, partnerIds: [] })
      }
      const bucket = buckets.get(bucketKey)!
      bucket.gutterXs.push(gutterX)
      bucket.ys.push(sy)
      bucket.edgeCount++
      if (!bucket.colors.includes(color)) bucket.colors.push(color)
      if (bucket.partnerIds.length < MAX_BADGE_PARTNERS && !bucket.partnerIds.includes(partnerId)) {
        bucket.partnerIds.push(partnerId)
      }

      const stubCount = bucketStubCount.get(bucketKey) ?? 0
      if (stubCount >= MAX_STUBS_PER_BUCKET) return
      bucketStubCount.set(bucketKey, stubCount + 1)

      let ex: number
      let ey: number
      if (isHorizontal) {
        // Exit horizontally toward the viewport edge, nudged a few px
        // toward the partner's row when known, fanned vertically per stub.
        ex = direction === 'left'
          ? viewportRect.left - containerRect.left
          : viewportRect.right - containerRect.left
        const nudge = partnerY !== null ? Math.max(-24, Math.min(24, partnerY - sy)) : 0
        ey = sy + nudge + (stubCount - MAX_STUBS_PER_BUCKET / 2) * 3
      } else {
        ey = direction === 'up' ? 0 : containerH
        ex = gutterX + (stubCount - MAX_STUBS_PER_BUCKET / 2) * 3
      }

      const cp1x = sx + (ex - sx) * 0.4
      const cp2x = ex
      const cp2y = sy + (ey - sy) * 0.6

      const pathD = `M ${sx} ${sy} C ${cp1x} ${sy}, ${cp2x} ${cp2y}, ${ex} ${ey}`
      const safeColor = color.replace(/[^a-zA-Z0-9]/g, '')
      const gradId = `of-${safeColor}-${direction}`

      trailingEdges.push({
        id: `overflow-edge-${edge.source}-${edge.target}`,
        pathD, color, direction, gradientId: gradId,
        sy, ey,
      })
    })

    setComputedEdges(newComputedEdges)

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
    if (nodeStubCounts && nodeStubCounts.size > 0) {
      // Always-on in/out indicators: every render mode shows whether a
      // node has loaded lineage on each side. Stubs mode keeps the full
      // three-layer ribbon; other modes get a QUIET slim tab so the
      // indicator doesn't double-encode against the materialized edges.
      // Sized to be confidently visible without dominating the card.
      // 7px core + 4px halo around it gives a soft glow tab that reads
      // at a glance. ~5.5px peeks out beyond the card edge (1.5px overlap
      // hides any hard inboard edge behind the card chrome).
      const variant: 'full' | 'quiet' = showStubs ? 'full' : 'quiet'
      const RIBBON_W = variant === 'full' ? 7 : 4
      const RIBBON_HEIGHT_RATIO = variant === 'full' ? 0.55 : 0.4
      const RIBBON_INSET = 1.5
      const newStubs: typeof computedStubs = []
      globalVisibleNodes.forEach(domId => {
        const nodeId = domId.startsWith('layer-node-') ? domId.slice('layer-node-'.length) : domId
        const counts = nodeStubCounts.get(nodeId)
        if (!counts) return
        const el = getEl(domId)
        if (!el) return
        const rect = el.getBoundingClientRect()
        const midY = rect.top + rect.height / 2 - containerRect.top
        const height = Math.max(18, rect.height * RIBBON_HEIGHT_RATIO)
        if (counts.in > 0) {
          // Inbound ribbon center sits `(RIBBON_W/2 - RIBBON_INSET)` to
          // the left of the card-left edge — so part of the pill peeks
          // out, the rest is hidden by the card chrome.
          const cardLeft = rect.left - containerRect.left
          newStubs.push({
            nodeId, side: 'in', count: counts.in,
            cx: cardLeft - (RIBBON_W / 2 - RIBBON_INSET),
            cy: midY,
            width: RIBBON_W,
            height,
            variant,
          })
        }
        if (counts.out > 0) {
          const cardRight = rect.right - containerRect.left
          newStubs.push({
            nodeId, side: 'out', count: counts.out,
            cx: cardRight + (RIBBON_W / 2 - RIBBON_INSET),
            cy: midY,
            width: RIBBON_W,
            height,
            variant,
          })
        }
      })
      setComputedStubs(newStubs)
    } else if (computedStubs.length > 0) {
      setComputedStubs([])
    }

    const badges: OverflowBadge[] = []
    buckets.forEach((bucket) => {
      const horizontal = bucket.direction === 'left' || bucket.direction === 'right'
      // Left/right badges pin to the visible viewport edge (overlay
      // coords) at the average row band; up/down badges keep their
      // gutter-centered placement.
      const avgX = horizontal
        ? (bucket.direction === 'left'
            ? viewportRect.left - containerRect.left + 14
            : viewportRect.right - containerRect.left - 14)
        : bucket.gutterXs.reduce((a, b) => a + b, 0) / bucket.gutterXs.length
      const avgY = bucket.ys.reduce((a, b) => a + b, 0) / bucket.ys.length
      badges.push({
        gutterX: avgX,
        y: avgY,
        direction: bucket.direction,
        count: bucket.edgeCount,
        color: bucket.colors[0] || '#3b82f6',
        partnerIds: bucket.partnerIds,
      })
    })
    setOverflowBadges(badges)
    setOverflowEdges(trailingEdges)

    // Pass-through settle pass — debounced 150ms so the O(projected-edges)
    // scan never runs on the per-frame path. updateFlow already fires on
    // every scroll / IO / mutation / resize trigger, so re-arming here
    // keeps the pass fresh without any new listeners.
    if (passThroughTimerRef.current) clearTimeout(passThroughTimerRef.current)
    passThroughTimerRef.current = setTimeout(() => {
      passThroughTimerRef.current = null
      computePassThroughRef.current?.()
    }, 150)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeIndex, selectEdge, isEdgePanelOpen, toggleEdgePanel, isTracing, traceResult, highlightedEdges, isHighlightActive, resolveEdgeColor, hoveredEdgeId, showStubs, nodeStubCounts, geometryRegistry])

  // ── Pass-through edges — both endpoints off-viewport, path crosses the
  // visible box. Runs only on the debounced settle pass above. Cost:
  // O(projected edges) with O(1) per rejected edge (two Set lookups +
  // memoized column resolution + interval tests); rect math only for
  // edges whose horizontal strip crosses the viewport. Endpoint rects
  // are exact for mounted cards (including mounted-but-horizontally-
  // off-viewport ones) and virtualizer estimates for unmounted rows.
  const computePassThrough = useCallback(() => {
    if (!containerRef.current) return
    if (!geometryRegistry || geometryRegistry.size === 0) {
      setPassThroughEdges(prev => (prev.length === 0 ? prev : []))
      return
    }
    const containerRect = containerRef.current.getBoundingClientRect()
    const viewportRect = containerRef.current.parentElement?.getBoundingClientRect()
    if (!viewportRect) return

    const colCache = new Map<string, ColumnGeometryApi | null>()
    const resolveCol = (id: string): ColumnGeometryApi | null => {
      const cached = colCache.get(id)
      if (cached !== undefined) return cached
      let col: ColumnGeometryApi | null = null
      for (const api of geometryRegistry.values()) {
        if (api.hasNode(id)) { col = api; break }
      }
      colCache.set(id, col)
      return col
    }
    // Exact DOM rect when the card is mounted (horizontal off-viewport
    // cards are still mounted by their column), estimate otherwise.
    const rectOf = (id: string, col: ColumnGeometryApi) =>
      document.getElementById(`layer-node-${id}`)?.getBoundingClientRect() ?? col.getNodeRect(id)

    const result: PassThroughEdge[] = []
    for (const edge of edges) {
      if (globalVisibleNodes.has(`layer-node-${edge.source}`)) continue
      if (globalVisibleNodes.has(`layer-node-${edge.target}`)) continue
      const srcCol = resolveCol(edge.source)
      if (!srcCol) continue
      const tgtCol = resolveCol(edge.target)
      if (!tgtCol || srcCol === tgtCol) continue
      const sRect = rectOf(edge.source, srcCol)
      if (!sRect) continue
      const tRect = rectOf(edge.target, tgtCol)
      if (!tRect) continue
      // X pre-test: the horizontal strip the edge travels must cross the
      // viewport box.
      const xA = sRect.right
      const xB = tRect.left
      if (Math.max(xA, xB) < viewportRect.left || Math.min(xA, xB) > viewportRect.right) continue
      // Y test — exact for the monotone cross-column cubic: the curve's
      // y stays within [sy, ty].
      const syAbs = sRect.top + sRect.height / 2
      const tyAbs = tRect.top + tRect.height / 2
      if (Math.max(syAbs, tyAbs) < viewportRect.top || Math.min(syAbs, tyAbs) > viewportRect.bottom) continue

      // Overlay coords — same anchors and curve family as the main pass.
      const sx = sRect.right - containerRect.left + 6
      const sy = syAbs - containerRect.top
      const tx = tRect.left - containerRect.left - 8
      const ty = tyAbs - containerRect.top
      const dist = Math.abs(tx - sx)
      const spread = Math.max(dist * 0.5, 24)
      const pathD = `M ${sx} ${sy} C ${sx + spread} ${sy}, ${tx - spread} ${ty}, ${tx} ${ty}`
      const primaryType = edge.types?.[0] || edge.originalType || ''
      const color = resolveEdgeColor ? resolveEdgeColor(primaryType) : '#3b82f6'
      result.push({ id: `pt-${edge.id}`, source: edge.source, target: edge.target, pathD, color })
    }
    setPassThroughEdges(prev => (prev.length === 0 && result.length === 0 ? prev : result))
  }, [edges, geometryRegistry, resolveEdgeColor])

  useEffect(() => {
    computePassThroughRef.current = computePassThrough
  }, [computePassThrough])

  // Store updateFlow in ref for ResizeObserver access and expose to parent
  useEffect(() => {
    updateFlowRef.current = updateFlow
    if (triggerRedrawRef) {
      triggerRedrawRef.current = scheduleUpdate
    }
  }, [updateFlow, scheduleUpdate, triggerRedrawRef])

  // Stubs mode toggles + stub-count changes need a redraw because
  // updateFlow's identity changes but the observers above don't refire —
  // without this, switching to stubs (or swapping the per-node counts)
  // leaves the canvas showing the previous geometry until the next
  // scroll / resize / hover.
  useEffect(() => {
    scheduleUpdate()
  }, [showStubs, nodeStubCounts, scheduleUpdate])

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
      root: null,
      rootMargin: '100px',
      threshold: 0,
    })

    // Track which elements we're currently observing
    const observedElements = new Set<Element>()

    const observeElement = (el: Element) => {
      if (observedElements.has(el)) return
      observedElements.add(el)
      resizeObserver.observe(el)
      visibilityObserver.observe(el)
    }

    const unobserveElement = (el: Element) => {
      if (!observedElements.has(el)) return
      observedElements.delete(el)
      resizeObserver.unobserve(el)
      visibilityObserver.unobserve(el)
      if (el.id) globalVisibleNodes.delete(el.id)
    }

    // The overlay is a sibling of the layer columns, so we need to observe
    // the common parent that contains both.
    const observeRoot = container.parentElement || container

    // Scan for already-present node elements
    const scanAndObserve = () => {
      observeRoot.querySelectorAll('[id^="layer-node-"]').forEach(el => observeElement(el))
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
      if (passThroughTimerRef.current !== null) {
        clearTimeout(passThroughTimerRef.current)
        passThroughTimerRef.current = null
      }
    }
  }, [nodes, expandedNodesFingerprint, scheduleUpdate])

  // Attach scroll listener to the parent container for Viewport Edge Virtualization
  useEffect(() => {
    if (!containerRef.current) return
    const scrollParent = containerRef.current.closest('.overflow-y-auto') as HTMLElement
    if (!scrollParent) return

    let rafId: number | null = null
    const handleScroll = () => {
      if (rafId !== null) return // debounce
      rafId = requestAnimationFrame(() => {
        setViewport({
          scrollTop: scrollParent.scrollTop,
          clientHeight: scrollParent.clientHeight
        })
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

  // ── 4.2 Hover Preview ────────────────────────────────────────────────────────
  // Pure DOM/CSS — zero React re-renders. Reads document.dataset.hoveredNode set
  // by FlatTreeItem, then dims/highlights visual edge <g> elements directly.
  useEffect(() => {
    let rafId: number
    let lastNode: string | undefined

    const tick = () => {
      const hovered = document.documentElement.dataset.hoveredNode
      if (hovered !== lastNode) {
        lastNode = hovered
        const groups = containerRef.current?.querySelectorAll<SVGGElement>('g[data-edge-id]')
        groups?.forEach(g => {
          if (!hovered) {
            g.style.removeProperty('opacity')
          } else if (g.dataset.edgeSrc === hovered || g.dataset.edgeTgt === hovered) {
            g.style.opacity = '1'
          } else {
            g.style.opacity = '0.06'
          }
        })
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  // VERY FAST Virtualization Filter: Only render edges that intersect the scroll viewport
  const VIEWPORT_MARGIN = 400
  const visibleEdges = computedEdges.filter(edge => {
    if (edge.maxY < viewport.scrollTop - VIEWPORT_MARGIN) return false
    if (edge.minY > viewport.scrollTop + viewport.clientHeight + VIEWPORT_MARGIN) return false
    return true
  })

  // ── Density-adaptive render tier ───────────────────────────────────────
  //
  // Premium  (≤ 200 visible)    — full treatment: per-edge gradient,
  //                                animated chevron flow, particles, glow.
  // Standard (201 – 800)        — drop animated chevron + particles unless
  //                                edge is hovered or focus-incident; pool
  //                                gradient defs by color (~10 vs N).
  // Coalesced (> 800)           — strip everything except the core stroke +
  //                                shared color gradient + arrowhead. Hover
  //                                still reads through the hit layer (now
  //                                gated to ≤1200 edges in Part 3).
  //
  // Premium feel concentrates on the user's focus. The hovered / focus-
  // incident subset always gets the Premium treatment regardless of tier
  // (`focus + context` fisheye, Part 5).
  const renderTier: 'premium' | 'standard' | 'coalesced' =
    visibleEdges.length <= 200 ? 'premium'
    : visibleEdges.length <= 800 ? 'standard'
    : 'coalesced'

  // ── Shared SVG defs — one marker per unique color, one gradient per color+direction ──
  // Avoids creating 500+ <marker> and 200+ <linearGradient> elements per render.
  const sharedDefs = useMemo(() => {
    const markerColors = new Set<string>()
    // Include ALL visible edges (ghost or not) — ghost edges represent finer-
    // level lineage delegated up to a visible ancestor (e.g. column→column
    // TRANSFORMS bubbled to the parent Dataset). They are still directional
    // and the user must see where the data flows.
    visibleEdges.forEach(e => markerColors.add(e.color))

    const gradientKeys = new Set<string>()
    overflowEdges.forEach(e => gradientKeys.add(`${e.color}|${e.direction}`))

    return { markerColors: Array.from(markerColors), gradientKeys: Array.from(gradientKeys) }
  }, [visibleEdges, overflowEdges])

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
              @keyframes dashFlow {
                from { stroke-dashoffset: 400; }
                to { stroke-dashoffset: 0; }
              }
              .flow-particles {
                animation: dashFlow 20s linear infinite;
              }
              .flow-particles-ghost {
                animation: dashFlow 40s linear infinite;
              }
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
                .flow-particles, .flow-particles-ghost, .edge-direction-flow, .lineage-stub-flow {
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
        {visibleEdges.map(edge => {
          const isHovered = hoveredEdgeId === edge.id
          const isSourceHovered = hoveredEdgeId === edge.source
          const isTargetHovered = hoveredEdgeId === edge.target
          // Highlight on hover OR when connected to the selected node
          const isHighlighted = isHovered || isSourceHovered || isTargetHovered || (isHighlightActive && highlightedEdges?.has(edge.id))
          const { pathD, color, dynamicStrokeWidth, edgeOpacity, isGhost, isBundled, sx, sy, tx, ty } = edge
          // Staged-change marker — colored halo around the edge if there's a pending change.
          const stagedEdgeColor: string | undefined = stagedEdgeColorByEdgeId.get(edge.id)

          // Spotlight focus modes:
          // - Click-highlight (a node is selected): edges connected to it stay
          //   full, others fade to 8%.
          // - Edge hover: the hovered edge stays full, others fade to 8%.
          // - Otherwise: nothing dims.
          // Click-highlight wins over edge-hover when both are active.
          const isConnectedToSelected = isHighlightActive && highlightedEdges?.has(edge.id)
          const isEdgeHoverSpotlight = !isHighlightActive && hoveredEdgeId !== null
          const isThisEdgeHovered = hoveredEdgeId === edge.id
          const groupOpacity = isHighlightActive
            ? (isConnectedToSelected ? 1 : 0.08)
            : isEdgeHoverSpotlight
              ? (isThisEdgeHovered ? 1 : 0.08)
              : 1

          // Per-edge gradient id — direction is encoded in the stroke itself.
          // Fades from a soft tint of the type color at the source to full
          // saturation at the target. The arrowhead is the confirming cue.
          //
          // Tier policy: only Premium tier (and the focus-incident /
          // hovered subset in any tier) gets the per-edge gradient. Other
          // edges fall back to the solid color stroke — direction is still
          // unmistakable via the arrowhead. Eliminates N <linearGradient>
          // defs per render at high density.
          const isPremiumLook =
            renderTier === 'premium' || isHighlighted || edge.isFocusIncident
          const gradId = `edge-grad-${edge.id.replace(/[^a-zA-Z0-9]/g, '')}`
          const coreOpacity = isHighlighted ? Math.min(0.95, edgeOpacity * 1.2) : edgeOpacity

          const isExpanding = expandingEdgeIds?.has(edge.id) ?? false
          const edgeClasses = [
            edge.isTraceEdge ? 'nx-edge-trace' : null,
            isExpanding ? 'nx-edge-expanding' : null,
          ].filter(Boolean).join(' ') || undefined
          return (
            <g
              key={edge.id}
              data-edge-id={edge.id}
              data-edge-src={edge.source}
              data-edge-tgt={edge.target}
              className={edgeClasses}
              style={{ opacity: groupOpacity, transition: 'opacity 0.12s ease' }}
            >
              {/* Per-edge directional gradient. `userSpaceOnUse` with start/
                  end at the path's source/target endpoints aligns the gradient
                  vector to the actual edge direction — approximate for curves
                  but visually correct. Source stop at 35% of edge opacity gives
                  the soft-tint start; target stop at full edge opacity.
                  Skipped for non-premium-look edges to keep DOM count down. */}
              {isPremiumLook && (
                <defs>
                  <linearGradient
                    id={gradId}
                    gradientUnits="userSpaceOnUse"
                    x1={sx}
                    y1={sy}
                    x2={tx}
                    y2={ty}
                  >
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
              {stagedEdgeColor && (
                <path
                  d={pathD}
                  style={{
                    stroke: stagedEdgeColor,
                    strokeWidth: dynamicStrokeWidth + 4,
                    fill: 'none',
                    strokeOpacity: 0.55,
                    strokeLinecap: 'round',
                    strokeDasharray: '4 3',
                  }}
                  className="pointer-events-none"
                />
              )}

              {/* CORE LINE — stroke uses the per-edge gradient so direction
                  is encoded in the line itself (faded at source, full at
                  target). strokeOpacity is intentionally 1 when the gradient
                  carries opacity in its stops; a fixed opacity is used when
                  the solid-color fallback runs. Reverse-flow edges use the
                  same styling as forward — only their path geometry differs. */}
              <path
                d={pathD}
                style={{
                  stroke: isPremiumLook ? `url(#${gradId})` : color,
                  strokeWidth: dynamicStrokeWidth,
                  fill: 'none',
                  strokeOpacity: isPremiumLook ? 1 : coreOpacity,
                  strokeDasharray: isGhost ? '6 4' : 'none',
                  strokeLinecap: 'round',
                  transition: 'stroke-width 0.2s ease',
                }}
                markerEnd={showDirection ? `url(#arrow-${color.replace(/[^a-zA-Z0-9]/g, '')})` : undefined}
                markerStart={showDirection && edge.isBidirectional ? `url(#arrow-${color.replace(/[^a-zA-Z0-9]/g, '')})` : undefined}
                className="pointer-events-none"
              />

              {/* DIRECTION FLOW — animated chevron flowing source → target.
                  Renders for ALL edges in Premium tier; in Standard /
                  Coalesced tiers we limit it to the focus + context subset
                  (hovered, focus-incident) so density doesn't melt the
                  paint pipeline. Reverse-flow edges follow the same rules
                  as forward — chevron animates along their downward arc. */}
              {showDirection && isPremiumLook && (
                <>
                  {/* White underlay — gives the colored dashes contrast against any background */}
                  <path
                    d={pathD}
                    style={{
                      stroke: 'white',
                      strokeWidth: Math.max(2.5, dynamicStrokeWidth * 1.2),
                      fill: 'none',
                      strokeOpacity: isGhost ? 0.10 : 0.18,
                      strokeLinecap: 'round',
                      strokeDasharray: '10 18',
                      strokeDashoffset: 4,
                    }}
                    className="pointer-events-none edge-direction-flow"
                  />
                  {/* Foreground colored chevron — bright, opaque, marches forward */}
                  <path
                    d={pathD}
                    style={{
                      stroke: color,
                      strokeWidth: Math.max(2, dynamicStrokeWidth * 1.05),
                      fill: 'none',
                      strokeOpacity: isGhost ? 0.7 : 0.95,
                      strokeLinecap: 'round',
                      strokeDasharray: '10 18',
                    }}
                    className="pointer-events-none edge-direction-flow"
                  />
                </>
              )}

              {/* ANIMATED PARTICLES — only on hover/highlight, minimal */}
              {!isGhost && isHighlighted && (
                <path
                  d={pathD}
                  style={{
                    stroke: color,
                    strokeWidth: Math.max(0.75, dynamicStrokeWidth * 0.35),
                    fill: 'none',
                    strokeOpacity: 0.6,
                    strokeLinecap: 'round',
                    strokeDasharray: '2 18',
                  }}
                  className="pointer-events-none flow-particles"
                />
              )}
              {isGhost && (
                <path
                  d={pathD}
                  style={{
                    stroke: color,
                    strokeWidth: Math.max(0.75, dynamicStrokeWidth * 0.35),
                    fill: 'none',
                    strokeOpacity: isHighlighted ? 0.5 : 0.25,
                    strokeLinecap: 'round',
                    strokeDasharray: '4 10',
                  }}
                  className="pointer-events-none flow-particles-ghost"
                />
              )}

              {/* Bundle count — minimal pill */}
              {isBundled && !isGhost && (
                <g transform={`translate(${(sx + tx) / 2}, ${(sy + ty) / 2})`}>
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

              {/* Endpoint rings — only on the spotlight-hovered edge. Visually
                  pin the focus by ringing both anchor points. r=14 sized to
                  hug the node edge-anchor area; pointer-events off so they
                  don't capture hits. */}
              {isThisEdgeHovered && (
                <>
                  <circle cx={sx} cy={sy} r={14} fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.6} className="pointer-events-none" />
                  <circle cx={tx} cy={ty} r={14} fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.6} className="pointer-events-none" />
                </>
              )}

              <title>{edge.source} → {edge.target} {isBundled ? `(${edge.edgeCount} bundled logs)` : ''}</title>
            </g>
          )
        })}

        {/* ── Per-node lineage ribbons ────────────────────────────────────
            Indigo accents that peek out from behind each entity card on
            the side(s) with lineage. Three layers compose the premium
            look without external decoration:

              1. Halo  — wider, blurry-tinted pill behind the core, gives
                         the ribbon a soft glow against the card edge.
              2. Core  — narrower pill with a vertical fade gradient.
              3. Sheen — thin highlight stripe inside the core, lifts the
                         ribbon off the canvas (faux specular).

            The overlay sits at z-[5] beneath the card chrome (z-[10+])
            so the inboard half of every layer is hidden by the card.
            Native SVG <title> on each group provides the hover tooltip
            ("8 incoming connections" / etc.) so the user can confirm
            meaning. Hover/select the entity materializes the real edges
            and these indicators recede behind them. ─────────────────── */}
        {computedStubs.length > 0 && (
          <>
            <defs>
              {/* Halo: wider gradient, lighter tones, generous fade.
                  Sits behind the core to create a soft glow without
                  needing an expensive SVG filter. */}
              <linearGradient id="lineage-ribbon-halo" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(129, 140, 248)" stopOpacity="0" />
                <stop offset="50%" stopColor="rgb(129, 140, 248)" stopOpacity="0.55" />
                <stop offset="100%" stopColor="rgb(129, 140, 248)" stopOpacity="0" />
              </linearGradient>
              {/* Core: vertical fade with full saturation in the middle.
                  rgb(79, 70, 229) is indigo-600 — slightly deeper than the
                  accent-lineage indigo-500 so the ribbon reads as a
                  punctuated accent against the card. */}
              <linearGradient id="lineage-ribbon-core" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(99, 102, 241)" stopOpacity="0" />
                <stop offset="18%" stopColor="rgb(99, 102, 241)" stopOpacity="0.65" />
                <stop offset="50%" stopColor="rgb(79, 70, 229)" stopOpacity="1" />
                <stop offset="82%" stopColor="rgb(99, 102, 241)" stopOpacity="0.65" />
                <stop offset="100%" stopColor="rgb(99, 102, 241)" stopOpacity="0" />
              </linearGradient>
              {/* Sheen: a thin highlight stripe running down one side of
                  the core. Adds a subtle "glass" depth so the ribbon
                  doesn't read as flat fill. */}
              <linearGradient id="lineage-ribbon-sheen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(255, 255, 255, 0)" />
                <stop offset="45%" stopColor="rgba(255, 255, 255, 0.35)" />
                <stop offset="55%" stopColor="rgba(255, 255, 255, 0.35)" />
                <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
              </linearGradient>
            </defs>
            {computedStubs.map(stub => {
              const key = `ribbon-${stub.nodeId}-${stub.side}`
              // Opacity scales subtly with lineage volume — light pairs
              // get a quieter ribbon, heavy fan-in nodes get a stronger
              // accent. log2 cap keeps the difference perceptible
              // without making heavy-traffic nodes shout.
              const intensity = Math.min(0.75 + Math.log2(Math.max(1, stub.count)) * 0.06, 1)
              const label = stub.count > 1
                ? `${stub.count.toLocaleString()} ${stub.side === 'in' ? 'incoming' : 'outgoing'} connections`
                : `${stub.count} ${stub.side === 'in' ? 'incoming' : 'outgoing'} connection`
              // Quiet variant (non-stubs modes): core pill only, dimmer —
              // an always-on "has lineage this side" tab that doesn't
              // compete with the materialized edges next to it.
              if (stub.variant === 'quiet') {
                return (
                  <g key={key} className="pointer-events-none" opacity={intensity * 0.55}>
                    <rect
                      x={stub.cx - stub.width / 2}
                      y={stub.cy - stub.height / 2}
                      width={stub.width}
                      height={stub.height}
                      rx={stub.width / 2}
                      ry={stub.width / 2}
                      fill="url(#lineage-ribbon-core)"
                    />
                    <title>{label}</title>
                  </g>
                )
              }
              const haloW = stub.width + 6
              const haloH = stub.height + 4
              const sheenW = Math.max(1.4, stub.width * 0.38)
              const sheenInset = stub.side === 'in'
                ? stub.width * 0.18   // sheen toward the card-facing side
                : -stub.width * 0.18
              return (
                <g key={key} className="pointer-events-none" opacity={intensity}>
                  {/* Halo */}
                  <rect
                    x={stub.cx - haloW / 2}
                    y={stub.cy - haloH / 2}
                    width={haloW}
                    height={haloH}
                    rx={haloW / 2}
                    ry={haloW / 2}
                    fill="url(#lineage-ribbon-halo)"
                  />
                  {/* Core */}
                  <rect
                    x={stub.cx - stub.width / 2}
                    y={stub.cy - stub.height / 2}
                    width={stub.width}
                    height={stub.height}
                    rx={stub.width / 2}
                    ry={stub.width / 2}
                    fill="url(#lineage-ribbon-core)"
                  />
                  {/* Sheen */}
                  <rect
                    x={stub.cx - sheenW / 2 + sheenInset}
                    y={stub.cy - stub.height / 2 + 2}
                    width={sheenW}
                    height={stub.height - 4}
                    rx={sheenW / 2}
                    ry={sheenW / 2}
                    fill="url(#lineage-ribbon-sheen)"
                  />
                  <title>{label}</title>
                </g>
              )
            })}
          </>
        )}

        {/* ── Trailing overflow edges — partial S-curves fading toward container edge ── */}
        {overflowEdges.map(oe => (
          <path
            key={oe.id}
            d={oe.pathD}
            stroke={`url(#${oe.gradientId})`}
            strokeWidth={1.4}
            fill="none"
            strokeDasharray="6 4"
            strokeLinecap="round"
            className="pointer-events-none"
          />
        ))}

        {/* ── Pass-through edges — both endpoints off-viewport but the path
            crosses the visible box. Estimated geometry (virtualizer
            offsets), so they render dashed + dimmed in the coalesced
            style: no gradients, markers, or animation, and never any hit
            layer. data-edge-* attributes keep the DOM hover-dimming loop
            consistent — hovering any node dims these like every other
            non-incident edge. ── */}
        {passThroughEdges.map(pt => (
          <g key={pt.id} data-edge-id={pt.id} data-edge-src={pt.source} data-edge-tgt={pt.target}>
            <path
              d={pt.pathD}
              stroke={pt.color}
              strokeWidth={1.3}
              fill="none"
              strokeOpacity={0.28}
              strokeDasharray="5 5"
              strokeLinecap="round"
              className="pointer-events-none"
            />
          </g>
        ))}
      </svg>

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
    <div className="absolute inset-0 pointer-events-none z-40">
      {overflowBadges.map((badge, i) => {
        const isHorizontal = badge.direction === 'left' || badge.direction === 'right'
        const rotation = badge.direction === 'up' ? undefined
          : badge.direction === 'down' ? 'rotate(180deg)'
          : badge.direction === 'left' ? 'rotate(-90deg)'
          : 'rotate(90deg)'
        const shown = badge.partnerIds
          .map(id => nodeNameById.get(id) ?? id)
        const extra = badge.count - badge.partnerIds.length
        return (
          <div
            key={`overflow-${i}`}
            className="absolute pointer-events-none"
            style={{
              left: badge.gutterX,
              transform: 'translateX(-50%)',
              ...(isHorizontal
                ? { top: badge.y - 24 }
                : badge.direction === 'up' ? { top: 52 } : { bottom: 12 }),
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
                    <p key={j} className="truncate text-ink-muted">{name}</p>
                  ))}
                  {extra > 0 && <p className="text-ink-muted/70">+{extra} more</p>}
                  <p className="mt-1 text-ink-muted/60 italic">Click to scroll to it</p>
                </div>
              }
            >
              <button
                type="button"
                data-canvas-interactive
                className="pointer-events-auto flex flex-col items-center gap-0.5 cursor-pointer rounded-md px-1 py-0.5 hover:bg-white/[0.06] transition-colors"
                style={{ color: badge.color }}
                onClick={(e) => {
                  e.stopPropagation()
                  handleBadgeClick(badge)
                }}
              >
                {/* Chevron */}
                <svg
                  width="14" height="14" viewBox="0 0 14 14" fill="none"
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
                <span
                  className="text-[10px] font-semibold tabular-nums leading-none"
                  style={{ opacity: 0.85 }}
                >
                  {badge.count}
                </span>
                {/* Accent line */}
                <div
                  className="rounded-full"
                  style={{
                    width: Math.min(24, 8 + badge.count * 3),
                    height: 2,
                    backgroundColor: badge.color,
                    opacity: 0.4,
                  }}
                />
              </button>
            </InfoTooltip>
          </div>
        )
      })}
    </div>
    {hoveredEdgeId && hoverMousePos && (() => {
      const edge = computedEdges.find(e => e.id === hoveredEdgeId)
      if (!edge) return null
      // Resolve source/target node display names via DOM — the elementCache
      // already has the rendered node refs.
      const sourceEl = document.getElementById(`layer-node-${edge.source}`)
      const targetEl = document.getElementById(`layer-node-${edge.target}`)
      const sourceName = sourceEl?.querySelector('.line-clamp-2')?.textContent?.trim() || edge.source
      const targetName = targetEl?.querySelector('.line-clamp-2')?.textContent?.trim() || edge.target
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
