/**
 * useProjectedGraph - Hook that projects underlying data based on active view
 * 
 * This hook takes the raw nodes/edges from the canvas store and applies
 * view-specific projections including:
 * - Lineage aggregation (column→table)
 * - Entity type filtering
 * - Child node collapse with roll-up counts
 */

import { useMemo } from 'react'
import type { Node, Edge } from '@xyflow/react'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import {
  projectGraph,
  getViewProjectionConfig,
  GranularityLevel,
  type ViewProjectionConfig,
  type ProjectedGraph,
} from '@/lib/projection-engine'

export interface UseProjectedGraphResult {
  // Projected nodes and edges for rendering
  nodes: Node[]
  edges: Edge[]
  
  // Aggregation metadata
  aggregatedEdges: Map<string, {
    id: string
    sourceId: string
    targetId: string
    sourceEdges: string[]
    confidence: number
  }>
  
  // Helpers
  isAggregated: boolean
  projectionConfig: ViewProjectionConfig
  
  // Get the original column-level edges for an aggregated edge
  getSourceEdges: (aggregatedEdgeId: string) => string[]
}

/**
 * Main hook for getting projected graph data
 */
export function useProjectedGraph(): UseProjectedGraphResult {
  const rawNodes = useCanvasStore((s) => s.nodes)
  const rawEdges = useCanvasStore((s) => s.edges)
  const activeViewId = useSchemaStore((s) => s.activeViewId)
  const getActiveView = useSchemaStore((s) => s.getActiveView)
  
  const activeView = getActiveView()
  
  // Build projection config from view settings
  const projectionConfig = useMemo<ViewProjectionConfig>(() => {
    // Try to get config from view's layout.projection
    const viewProjection = activeView?.layout?.projection
    
    if (viewProjection) {
      return {
        targetGranularity: viewProjection.targetGranularity ?? GranularityLevel.Table,
        visibleEntityTypes: activeView?.content?.visibleEntityTypes ?? [],
        visibleRelationshipTypes: activeView?.content?.visibleRelationshipTypes ?? [],
        aggregateLineage: viewProjection.aggregateLineage ?? false,
        collapseChildren: viewProjection.collapseChildren ?? false,
        maxDepth: activeView?.content?.maxDepth ?? -1,
        containerTypes: viewProjection.containerTypes ?? [],
      }
    }
    
    // Fallback to predefined configs
    return getViewProjectionConfig(activeViewId)
  }, [activeView, activeViewId])
  
  // Apply projection
  const projected = useMemo<ProjectedGraph>(() => {
    if (!rawNodes.length) {
      return {
        nodes: [],
        edges: [],
        aggregatedEdges: new Map(),
      }
    }
    
    return projectGraph(rawNodes, rawEdges, projectionConfig)
  }, [rawNodes, rawEdges, projectionConfig])
  
  // Helper to get source edges for an aggregated edge
  const getSourceEdges = useMemo(() => {
    return (aggregatedEdgeId: string): string[] => {
      const agg = projected.aggregatedEdges.get(aggregatedEdgeId)
      return agg?.sourceEdges ?? []
    }
  }, [projected.aggregatedEdges])
  
  return {
    nodes: projected.nodes,
    edges: projected.edges,
    aggregatedEdges: projected.aggregatedEdges,
    isAggregated: projectionConfig.aggregateLineage,
    projectionConfig,
    getSourceEdges,
  }
}

/**
 * Hook to get just the visible entity types for the current view
 */
export function useVisibleEntityTypes(): string[] {
  const activeViewId = useSchemaStore((s) => s.activeViewId)
  const getActiveView = useSchemaStore((s) => s.getActiveView)
  const activeView = getActiveView()
  
  return useMemo(() => {
    return activeView?.content?.visibleEntityTypes ?? []
  }, [activeView])
}

/**
 * Hook to check if an entity type is visible in current view
 */
export function useIsEntityTypeVisible(typeId: string): boolean {
  const visibleTypes = useVisibleEntityTypes()
  return visibleTypes.includes(typeId)
}

/**
 * Hook to get lineage statistics for the current projection
 */
export function useLineageStats() {
  const { nodes, edges, aggregatedEdges, isAggregated } = useProjectedGraph()
  
  return useMemo(() => {
    const nodesByType = new Map<string, number>()
    nodes.forEach((node) => {
      const type = (node.data as Record<string, unknown>)?.type as string ?? 'unknown'
      nodesByType.set(type, (nodesByType.get(type) ?? 0) + 1)
    })
    
    const edgesByType = new Map<string, number>()
    edges.forEach((edge) => {
      const type = (edge.data as Record<string, unknown>)?.edgeType as string ?? 'lineage'
      edgesByType.set(type, (edgesByType.get(type) ?? 0) + 1)
    })
    
    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      aggregatedEdgeCount: aggregatedEdges.size,
      isAggregated,
      nodesByType: Object.fromEntries(nodesByType),
      edgesByType: Object.fromEntries(edgesByType),
    }
  }, [nodes, edges, aggregatedEdges, isAggregated])
}

