/**
 * useHighlightState - Extracted from ReferenceModelCanvas.tsx
 *
 * Encapsulates:
 * - highlightState: connected nodes/edges for selected node (client-side BFS)
 * - isHighlightActive: derived boolean indicating if any edges are highlighted
 */

import { useMemo } from 'react'
import type { HierarchyNode } from '../components/canvas/context-view/types'

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

export interface UseHighlightStateResult {
  highlightState: { nodes: Set<string>, edges: Set<string> }
  isHighlightActive: boolean
}

// ============================================
// Hook
// ============================================

export function useHighlightState({
  selectedNodeId,
  visibleLineageEdges,
  isTracing,
  displayMap,
  childMap,
}: UseHighlightStateOptions): UseHighlightStateResult {

  // Click-to-highlight: compute connected nodes/edges for selected node (client-side only, no backend call)
  // When a node is expanded, its edges are projected to visible descendants — so we match against
  // the selected node AND all its descendants to keep highlight working after expansion.
  const highlightState = useMemo(() => {
    if (isTracing || !selectedNodeId) {
      return { nodes: new Set<string>(), edges: new Set<string>() }
    }
    // Build set of selected node + all descendants
    const selectedAndDescendants = new Set<string>([selectedNodeId])
    const queue = [selectedNodeId]
    while (queue.length > 0) {
      const curr = queue.pop()!
      const children = childMap.get(curr) || []
      for (const child of children) {
        if (!selectedAndDescendants.has(child)) {
          selectedAndDescendants.add(child)
          queue.push(child)
        }
      }
    }

    const connectedNodes = new Set<string>([selectedNodeId])
    const connectedEdges = new Set<string>()
    const selectedUrn = displayMap.get(selectedNodeId)?.urn

    visibleLineageEdges.forEach((edge: any) => {
      const matches = selectedAndDescendants.has(edge.source) || selectedAndDescendants.has(edge.target) ||
        (selectedUrn && (edge.source === selectedUrn || edge.target === selectedUrn))
      if (matches) {
        connectedEdges.add(edge.id)
        connectedNodes.add(edge.source)
        connectedNodes.add(edge.target)
      }
    })
    return { nodes: connectedNodes, edges: connectedEdges }
  }, [selectedNodeId, visibleLineageEdges, isTracing, displayMap, childMap])

  const isHighlightActive = highlightState.edges.size > 0

  return { highlightState, isHighlightActive }
}
