/**
 * useHighlightState - Click-to-highlight connected nodes/edges
 * useHoverHighlight - Hover-to-highlight connected nodes/edges (lighter visual)
 *
 * Both share the same BFS logic to find connected nodes/edges for a given focal node.
 */

import { useMemo, useState, useEffect, useRef } from 'react'
import type { HierarchyNode } from '@/types/hierarchy'

// ============================================
// Types
// ============================================

export interface UseHighlightStateOptions {
  selectedNodeId: string | null
  visibleLineageEdges: any[]
  isTracing: boolean
  displayMap: Map<string, HierarchyNode>
  childMap: Map<string, string[]>
}

export interface HighlightSet {
  nodes: Set<string>
  edges: Set<string>
}

export interface UseHighlightStateResult {
  highlightState: HighlightSet
  isHighlightActive: boolean
}

// ============================================
// Shared: compute connected nodes/edges for a focal node
// ============================================

const EMPTY: HighlightSet = { nodes: new Set(), edges: new Set() }

function computeConnected(
  focalNodeId: string | null,
  visibleLineageEdges: any[],
  displayMap: Map<string, HierarchyNode>,
  childMap: Map<string, string[]>,
): HighlightSet {
  if (!focalNodeId) return EMPTY

  // Build set of focal node + all containment descendants
  const focalAndDescendants = new Set<string>([focalNodeId])
  const queue = [focalNodeId]
  while (queue.length > 0) {
    const curr = queue.pop()!
    const children = childMap.get(curr) || []
    for (const child of children) {
      if (!focalAndDescendants.has(child)) {
        focalAndDescendants.add(child)
        queue.push(child)
      }
    }
  }

  const connectedNodes = new Set<string>([focalNodeId])
  const connectedEdges = new Set<string>()
  const focalUrn = displayMap.get(focalNodeId)?.urn

  visibleLineageEdges.forEach((edge: any) => {
    const matches = focalAndDescendants.has(edge.source) || focalAndDescendants.has(edge.target) ||
      (focalUrn && (edge.source === focalUrn || edge.target === focalUrn))
    if (matches) {
      connectedEdges.add(edge.id)
      connectedNodes.add(edge.source)
      connectedNodes.add(edge.target)
    }
  })

  return { nodes: connectedNodes, edges: connectedEdges }
}

// ============================================
// Click highlight hook (existing behavior)
// ============================================

export function useHighlightState({
  selectedNodeId,
  visibleLineageEdges,
  isTracing,
  displayMap,
  childMap,
}: UseHighlightStateOptions): UseHighlightStateResult {

  const highlightState = useMemo(() => {
    if (isTracing || !selectedNodeId) return EMPTY
    return computeConnected(selectedNodeId, visibleLineageEdges, displayMap, childMap)
  }, [selectedNodeId, visibleLineageEdges, isTracing, displayMap, childMap])

  const isHighlightActive = highlightState.edges.size > 0

  return { highlightState, isHighlightActive }
}

// ============================================
// Standalone hovered-node tracker (reads dataset.hoveredNode via rAF)
// Can be called independently so the hoveredNodeId is available
// before useEdgeProjection (which useHoverHighlight depends on).
// ============================================

export function useHoveredNodeId(): string | null {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const prevRef = useRef<string | null>(null)

  useEffect(() => {
    let rafId: number
    const tick = () => {
      const current = document.documentElement.dataset.hoveredNode ?? null
      if (current !== prevRef.current) {
        prevRef.current = current
        setHoveredNodeId(current)
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return hoveredNodeId
}

// ============================================
// Hover highlight hook (uses hoveredNodeId from above)
// ============================================

export interface UseHoverHighlightOptions {
  hoveredNodeId: string | null
  visibleLineageEdges: any[]
  isTracing: boolean
  displayMap: Map<string, HierarchyNode>
  childMap: Map<string, string[]>
  /** Skip hover highlight when click-highlight is active */
  isClickHighlightActive: boolean
}

export interface UseHoverHighlightResult {
  hoverHighlight: HighlightSet
  isHoverActive: boolean
}

export function useHoverHighlight({
  hoveredNodeId,
  visibleLineageEdges,
  isTracing: _isTracing,
  displayMap,
  childMap,
  isClickHighlightActive,
}: UseHoverHighlightOptions): UseHoverHighlightResult {
  // Hover highlight runs in BOTH trace and non-trace mode. In trace mode,
  // `visibleLineageEdges` is already trace-filtered, so highlighting the
  // hovered node's incident edges naturally surfaces its immediate
  // upstream/downstream neighbors *within* the trace context.
  const hoverHighlight = useMemo(() => {
    if (isClickHighlightActive || !hoveredNodeId) return EMPTY
    return computeConnected(hoveredNodeId, visibleLineageEdges, displayMap, childMap)
  }, [hoveredNodeId, visibleLineageEdges, isClickHighlightActive, displayMap, childMap])

  const isHoverActive = hoverHighlight.edges.size > 0

  return { hoverHighlight, isHoverActive }
}
