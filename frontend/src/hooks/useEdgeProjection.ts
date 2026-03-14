/**
 * useEdgeProjection - Extracted from ReferenceModelCanvas.tsx
 *
 * Encapsulates:
 * - lineageEdges: aggregated + expanded detailed + trace/regular edges
 * - visibleLineageEdges: edge projection/roll-up to visible ancestors
 */

import { useMemo } from 'react'
import { normalizeEdgeType } from '@/services/ontologyService'
import type { HierarchyNode } from '../components/canvas/context-view/types'

// ============================================
// Types
// ============================================

export interface UseEdgeProjectionOptions {
  edges: any[]
  aggregatedEdges: Map<string, any>
  nodesByLayer: Map<string, HierarchyNode[]>
  expandedNodes: Set<string>
  displayFlat: HierarchyNode[]
  displayMap: Map<string, HierarchyNode>
  urnToIdMap: Map<string, string>
  showLineageFlow: boolean
  isTracing: boolean
  traceContextSet: Set<string>
  isContainmentEdge: (edgeType: string) => boolean
}

// ============================================
// Hook
// ============================================

export function useEdgeProjection({
  edges,
  aggregatedEdges,
  nodesByLayer,
  expandedNodes,
  displayFlat,
  displayMap,
  urnToIdMap,
  showLineageFlow,
  isTracing,
  traceContextSet,
  isContainmentEdge,
}: UseEdgeProjectionOptions): { lineageEdges: any[], visibleLineageEdges: any[] } {

  const lineageEdges = useMemo(() => {
    // When tracing, always compute edges even if flow toggle is off (Trace overrides)
    if (!showLineageFlow && !isTracing) return []

    // 1. Aggregated Edges (Always show if Flow is ON)
    const aggEdges = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'collapsed')
      .map(e => ({
        id: e.aggregated.id,
        source: e.aggregated.sourceUrn,
        target: e.aggregated.targetUrn,
        data: {
          edgeType: 'AGGREGATED',
          relationship: 'aggregated',
          isAggregated: true,
          edgeCount: e.aggregated.edgeCount,
          edgeTypes: e.aggregated.edgeTypes,
          confidence: e.aggregated.confidence,
        }
      }))

    // 2. Expanded Detailed Edges (User explicitly expanded an edge)
    const expandedDetailedEdges = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges
        // Filter out containment edges from detailed view to avoid "sneaky" structural edges
        .filter((de: any) => !isContainmentEdge(de.edgeType))
        .map((de: any) => ({
          id: de.id,
          source: de.sourceUrn,
          target: de.targetUrn,
          data: {
            edgeType: de.edgeType,
            relationship: de.edgeType,
            confidence: de.confidence,
          }
        })))

    // 3. Trace / Regular Edges (ONLY when Tracing is Active)
    // "Sneaky" edges fix: Don't show raw granular edges in the high-level view
    // unless we are specifically in a granular trace mode.
    let regularEdges: any[] = []
    if (isTracing) {
      regularEdges = edges.filter(edge => {
        return !isContainmentEdge(normalizeEdgeType(edge))
      })
    }

    return [...aggEdges, ...expandedDetailedEdges, ...regularEdges]
  }, [edges, showLineageFlow, isTracing, aggregatedEdges, isContainmentEdge])

  // Lineage Roll-up: Project edges to visible ancestors
  const visibleLineageEdges = useMemo(() => {
    if (!showLineageFlow && !isTracing) return []

    // 1. Build Ancestor Map: Physical URN -> Visible Node ID
    // ONLY needed for granular edges (Trace) or if we have non-aggregated edges mixed in.
    const ancestorMap = new Map<string, string>()

    // We only need to build this map if we have Regular (non-aggregated) edges to project
    // OR if we want to validate aggregated edges against visible nodes (safety)

    // Helper to traverse and map
    const processNode = (node: HierarchyNode, currentVisibleAnchor: string) => {
      // Map current node to the anchor
      if (node.urn) ancestorMap.set(node.urn, currentVisibleAnchor)
      ancestorMap.set(node.id, currentVisibleAnchor)

      let childAnchor = currentVisibleAnchor

      // If I am the visible node, check if I allow my children to be seen
      if (node.id === currentVisibleAnchor) {
        if (expandedNodes.has(node.id)) {
          childAnchor = 'USE_CHILD_ID' // Special flag
        } else {
          childAnchor = node.id
        }
      }

      if (node.children) {
        node.children.forEach(child => {
          const nextAnchor = childAnchor === 'USE_CHILD_ID' ? child.id : childAnchor
          processNode(child, nextAnchor)
        })
      }
    }

    // Always build map for consistency and to handle Trace edges
    nodesByLayer.forEach(roots => roots.forEach(root => {
      processNode(root, root.id)
    }))

    // Ensure all visible nodes map to themselves
    displayFlat.forEach(node => {
      if (!ancestorMap.has(node.id)) ancestorMap.set(node.id, node.id)
      if (node.urn && !ancestorMap.has(node.urn)) ancestorMap.set(node.urn, node.id)
    })

    // 2. Project Edges
    const projected: any[] = []
    const edgeGroups = new Map<string, any[]>()

    // Helper to add edge to group
    const addEdgeToGroup = (sourceId: string, targetId: string, edge: any, type: string) => {
      const groupKey = `${sourceId}->${targetId}`
      if (!edgeGroups.has(groupKey)) edgeGroups.set(groupKey, [])
      edgeGroups.get(groupKey)!.push({
        ...edge,
        source: sourceId,
        target: targetId,
        originalType: type
      })
    }

    // Process Edges
    // A. Aggregated Edges (Optimization: Skip lookup if possible, or fast lookup)
    const aggEdgesRaw = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'collapsed')

    aggEdgesRaw.forEach(e => {
      const agg = e.aggregated
      // For Aggregated Edges, the backend guarantees they match the requested visible URNs.
      // However, we verify they map to valid visible nodes to avoid dangling edges.
      // Usually sourceUrn == visibleNodeId (or URN).

      // Fast check: Is the source/target directly in displayMap (visible)?
      let sId = displayMap.has(agg.sourceUrn) ? agg.sourceUrn : ancestorMap.get(agg.sourceUrn)
      let tId = displayMap.has(agg.targetUrn) ? agg.targetUrn : ancestorMap.get(agg.targetUrn)

      // Fallback for ID vs URN mismatch if map keys differ
      if (!sId) sId = urnToIdMap.get(agg.sourceUrn)
      if (!tId) tId = urnToIdMap.get(agg.targetUrn)

      if (sId && tId && sId !== tId) {
        // Create flow edge directly
        addEdgeToGroup(sId, tId, {
          id: agg.id,
          data: {
            edgeType: 'AGGREGATED',
            relationship: 'aggregated',
            isAggregated: true,
            edgeCount: agg.edgeCount,
            edgeTypes: agg.edgeTypes,
            confidence: agg.confidence,
            sourceEdgeIds: agg.sourceEdgeIds
          }
        }, 'AGGREGATED')
      }
    })

    // B. Regular / Trace Edges
    // These require full ancestor projection
    const regularEdges = edges.filter(edge => !isContainmentEdge(normalizeEdgeType(edge)))

    regularEdges.forEach(edge => {
      const sId = ancestorMap.get(edge.source) || (displayMap.has(edge.source) ? edge.source : null)
      const tId = ancestorMap.get(edge.target) || (displayMap.has(edge.target) ? edge.target : null)

      if (sId && tId && sId !== tId) {
        if (isTracing) {
          if (!traceContextSet.has(sId) || !traceContextSet.has(tId)) return
        }

        addEdgeToGroup(sId, tId, {
          ...edge,
          data: edge.data || {}
        }, normalizeEdgeType(edge))
      }
    })

    // C. Expanded Detailed Edges from Aggregation
    Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges)
      .forEach(edge => {
        // These are real edges, need projection just in case, though they likely connect visible children
        const sId = ancestorMap.get(edge.sourceUrn)
        const tId = ancestorMap.get(edge.targetUrn)
        if (sId && tId && sId !== tId) {
          addEdgeToGroup(sId, tId, {
            id: edge.id,
            data: {
              edgeType: edge.edgeType,
              relationship: edge.edgeType,
              confidence: edge.confidence
            }
          }, edge.edgeType)
        }
      })

    // Finalize Groups (Semantic Edge Bundling & Ghost Edges)
    edgeGroups.forEach((groupEdges, key) => {
      const distinctTypes = new Set<string>()
      let isGhost = false
      let isAggregated = false
      let maxConfidence = 0

      const sourceId = groupEdges[0].source
      const targetId = groupEdges[0].target

      // We consider it a "Ghost" edge only if the projected container is collapsed OR has unloaded paginated items.
      // For now, let's keep all aggregated/bundled edges fully vibrant and just use dash styling
      // to imply that they are abstracted (source !== originalSource).
      if (groupEdges.some((e: any) => e.target !== e.originalTargetId || e.source !== e.originalSourceId)) {
        isGhost = true
      }

      groupEdges.forEach(e => {
        if (e.data?.isAggregated) isAggregated = true
        if (e.data?.edgeTypes) {
          e.data.edgeTypes.forEach((et: string) => distinctTypes.add(et))
        } else if (e.originalType) {
          distinctTypes.add(e.originalType)
        }

        maxConfidence = Math.max(maxConfidence, e.data?.confidence ?? 1)
      })

      const edgeCount = groupEdges.length
      const typesArray = Array.from(distinctTypes)

      projected.push({
        id: `bundle-${key}`,
        source: sourceId,
        target: targetId,
        isBundled: edgeCount > 1,
        isGhost,
        edgeCount,
        types: typesArray,
        confidence: maxConfidence,
        // Let the renderer know if it should use aggregated styles
        isAggregated,
        data: { edgeTypes: typesArray, confidence: maxConfidence, edgeCount }
      })
    })

    return projected
  }, [lineageEdges, edges, aggregatedEdges, nodesByLayer, expandedNodes, displayFlat, displayMap, urnToIdMap, showLineageFlow, isTracing, traceContextSet])

  return { lineageEdges, visibleLineageEdges }
}
