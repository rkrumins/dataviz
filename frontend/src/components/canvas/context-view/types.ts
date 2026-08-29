// Re-export HierarchyNode from shared types for backward compatibility
export type { HierarchyNode } from '@/types/hierarchy'
import type { HierarchyNode } from '@/types/hierarchy'
import type { AncestorRef, SearchHit } from '@/types/search'

export interface FlatTreeNode {
  node: HierarchyNode
  depth: number
  isLast: boolean
  parentIsLast: boolean[]  // Track which parents are "last" for proper tree lines
  isLoadMore?: boolean
  loadMoreCount?: number
  isSearchBox?: boolean
  isSkeleton?: boolean
  skeletonIndex?: number
  isFailed?: boolean
  /** A hit of the view search that lives INSIDE this row's container.
   *  Virtual: it is rendered from the search result alone and is never
   *  written to the canvas store, so `node` is the PARENT (the same
   *  convention `isLoadMore` uses) and `hit` is the entity shown. */
  isSearchHit?: boolean
  hit?: SearchHit
  /** The steps between the container and the hit, ancestors above the
   *  container cut away — see `inlineSearchHits`. */
  crumbs?: AncestorRef[]
  /** Set on the single trailing row instead of `hit`: how many hits the
   *  inline cap left for the panel to show. */
  overflow?: number
}

/** Imperative geometry API each LayerColumn registers with the canvas.
 *  Lets the edge overlay estimate row positions WITHOUT mounting rows —
 *  offsets come from the column virtualizer's measurements cache, so
 *  they are exact for measured rows and estimate-derived for unmounted
 *  ones. */
export interface ColumnGeometryApi {
  /** O(1): does this column's flatTree contain a row for nodeId? */
  hasNode(nodeId: string): boolean
  /** Estimated viewport-space rect for the node's row. null when the
   *  column is collapsed or the node has no row here. Compensates for
   *  canvas zoom (CSS scale on the columns wrapper). */
  getNodeRect(nodeId: string): { top: number; height: number; left: number; right: number } | null
}

/** Docked stand-in chip for an off-screen partner of the FOCUSED
 *  (selected) node. Rendered as real DOM in the owning column's Anchor
 *  Rail; the edge overlay anchors focus edges to the chip's actual
 *  rect — never to an estimated position. */
export type AnchorProxy = {
  nodeId: string
  /** Bundled edge count between the focused node and this partner. */
  count: number
  color: string
  /** Where the real row sits relative to the canvas viewport. */
  direction: 'up' | 'down'
}

export type AnchorProxyGroup = {
  proxies: AnchorProxy[]
  /** Partners beyond the rail cap — surfaced as "+N · Open lens". */
  moreCount: number
}

export type OverflowDirection = 'up' | 'down' | 'left' | 'right'

export type OverflowBadge = {
  /** Horizontal center of the badge, SCROLLPORT-relative (the badge
   *  layer is sticky-pinned to the scroll container's viewport —
   *  content-space coordinates would extend the scrollable area). */
  gutterX: number
  /** Vertical center of the badge, scrollport-relative. */
  y: number
  direction: OverflowDirection
  count: number
  color: string
  /** Off-screen partner node ids for tooltip / click-to-jump, capped at
   *  MAX_BADGE_PARTNERS; `count` keeps the true total. */
  partnerIds: string[]
  /** Distinct off-screen partner ENTITIES (uncapped). `count` counts
   *  connections; the tooltip's "+N more" must subtract entities from
   *  entities, never from `count`. */
  partnerTotal: number
}

/** A partial edge drawn from a visible node toward the container boundary,
 *  indicating an off-screen connection in that direction. */
export type OverflowEdge = {
  id: string
  /** SVG path for the trailing curve */
  pathD: string
  color: string
  direction: OverflowDirection
  /** Unique gradient ID for the fade mask */
  gradientId: string
  /** Start Y (visible node) and end Y (container edge) for gradient coords */
  sy: number
  ey: number
}

export type ComputedEdge = {
  id: string
  source: string
  target: string
  minY: number
  maxY: number
  pathD: string
  color: string
  dynamicStrokeWidth: number
  edgeOpacity: number
  isGhost: boolean
  isBundled: boolean
  edgeCount: number
  /** SVG `stroke-dasharray` for this edge — see `edgeDash.ts`. */
  dashArray: string
  sx: number
  sy: number
  tx: number
  ty: number
  // For tooltip display
  types: string[]
  confidence: number
  /** True when an active trace touches either endpoint — drives the cinematic glow + flow animation. */
  isTraceEdge?: boolean
  /** True when an endpoint is the trace focus — emphasised more strongly. */
  isFocusIncident?: boolean
  /**
   * True when this edge points back upstream (target's layer index <
   * source's). Renderer routes these in a dedicated dimmed lane so the
   * canonical left→right flow stays clean. Computed in useEdgeProjection
   * via `nodeLayerIndexMap`.
   */
  isReverseFlow?: boolean
  /**
   * True when the projection meta-bundled this edge from many fine-grained
   * leaf-pair edges up to a containment-parent pair (browse-mode rollup).
   * Drives the badge label "+N pairs" instead of "+N edges".
   */
  isBrowseBundle?: boolean
  /**
   * True when the projection collapsed an A→B and a B→A bundle into a
   * single record. Renderer should draw a dual-arrowhead path
   * (markerStart + markerEnd) to communicate two-way flow.
   */
  isBidirectional?: boolean
}
