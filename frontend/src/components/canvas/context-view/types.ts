// Re-export HierarchyNode from shared types for backward compatibility
export type { HierarchyNode } from '@/types/hierarchy'
import type { HierarchyNode } from '@/types/hierarchy'

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

export type OverflowDirection = 'up' | 'down' | 'left' | 'right'

export type OverflowBadge = {
  /** Horizontal center of the badge in the gutter (relative to container) */
  gutterX: number
  /** Vertical anchor (relative to container) — used by left/right badges;
   *  up/down badges keep their fixed top/bottom placement. */
  y: number
  direction: OverflowDirection
  count: number
  color: string
  /** Off-screen partner node ids for tooltip / click-to-jump, capped at
   *  MAX_BADGE_PARTNERS; `count` keeps the true total. */
  partnerIds: string[]
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

/** Edge whose BOTH endpoints are off-viewport but whose path crosses the
 *  visible box. Geometry is estimated (virtualizer offsets), rendered
 *  dashed/dimmed to signal estimation. Never participates in the hit
 *  layer — its endpoints are unmounted. */
export type PassThroughEdge = {
  id: string
  source: string
  target: string
  pathD: string
  color: string
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
