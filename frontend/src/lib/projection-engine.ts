/**
 * Projection Engine - Derives context views from underlying data
 * 
 * This engine transforms raw physical metadata into view-specific
 * representations with:
 * - Lineage Aggregation (column→table→schema→domain)
 * - Edge Promotion (if columns have lineage, so do parent tables)
 * - Visibility Filtering (hide/show entity types per view)
 * - Containment Collapse (roll up children into parents)
 */

import type { Node, Edge } from '@xyflow/react'

// Granularity levels from finest to coarsest
export enum GranularityLevel {
  Column = 0,
  Table = 1,
  Schema = 2,
  System = 3,
  Domain = 4,
}

// Map entity types to their granularity
export const ENTITY_GRANULARITY: Record<string, GranularityLevel> = {
  'column': GranularityLevel.Column,
  'dataset': GranularityLevel.Table,
  'asset': GranularityLevel.Table,
  'table': GranularityLevel.Table,
  'schema': GranularityLevel.Schema,
  'system': GranularityLevel.System,
  'app': GranularityLevel.System,
  'domain': GranularityLevel.Domain,
}

// Map entity types to their parent type
export const ENTITY_PARENT_TYPE: Record<string, string> = {
  'column': 'dataset',
  'dataset': 'schema',
  'asset': 'app',
  'table': 'schema',
  'schema': 'system',
  'system': 'domain',
  'app': 'domain',
}

export interface ViewProjectionConfig {
  // Target granularity for the view
  targetGranularity: GranularityLevel

  // Visible entity types
  visibleEntityTypes: string[]

  // Visible relationship/edge types
  visibleRelationshipTypes: string[]

  // Whether to aggregate lineage edges upward
  aggregateLineage: boolean

  // Whether to collapse children into parents
  collapseChildren: boolean

  // Max depth to show (-1 for unlimited)
  maxDepth: number

  // Entity types that act as containers (showing children inline)
  containerTypes: string[]
}

export interface ProjectedGraph {
  nodes: Node[]
  edges: Edge[]
  aggregatedEdges: Map<string, AggregatedEdge>
}

export interface AggregatedEdge {
  id: string
  sourceId: string
  targetId: string
  // Original column-level edges that were aggregated
  sourceEdges: string[]
  // Confidence based on number of supporting edges
  confidence: number
  // The granularity level of this aggregated edge
  granularity: GranularityLevel
}

/**
 * Build containment map from nodes and edges
 * Returns: childId → parentId
 */
export function buildContainmentMap(
  _nodes: Node[],
  edges: Edge[]
): Map<string, string> {
  const containmentMap = new Map<string, string>()

  edges.forEach((edge) => {
    if (edge.data?.relationship === 'contains' || edge.data?.edgeType === 'contains') {
      containmentMap.set(edge.target, edge.source)
    }
  })

  return containmentMap
}

/**
 * Find ancestor at a specific granularity level
 */
export function findAncestorAtGranularity(
  nodeId: string,
  targetGranularity: GranularityLevel,
  nodes: Node[],
  containmentMap: Map<string, string>
): string | null {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  let currentId: string | undefined = nodeId
  let visited = new Set<string>()

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const node = nodeMap.get(currentId)
    if (!node) return null

    const nodeType = node.data?.type as string
    const nodeGranularity = ENTITY_GRANULARITY[nodeType] ?? GranularityLevel.Column

    if (nodeGranularity >= targetGranularity) {
      return currentId
    }

    currentId = containmentMap.get(currentId)
  }

  return null
}

/**
 * Aggregate lineage edges to a higher granularity level
 * 
 * If column A (in table X) → column B (in table Y),
 * then we derive: table X → table Y
 */
export function aggregateLineageEdges(
  edges: Edge[],
  nodes: Node[],
  containmentMap: Map<string, string>,
  targetGranularity: GranularityLevel
): AggregatedEdge[] {
  const aggregatedEdges = new Map<string, AggregatedEdge>()

  // Filter to lineage edges (not containment)
  const lineageEdges = edges.filter((edge) => {
    const rel = edge.data?.relationship ?? edge.data?.edgeType ?? ''
    return rel !== 'contains' && rel !== 'has_schema' && rel !== 'has_dataset' && rel !== 'has_column'
  })

  lineageEdges.forEach((edge) => {
    // Find ancestors at target granularity
    const sourceAncestor = findAncestorAtGranularity(
      edge.source, targetGranularity, nodes, containmentMap
    )
    const targetAncestor = findAncestorAtGranularity(
      edge.target, targetGranularity, nodes, containmentMap
    )

    if (sourceAncestor && targetAncestor && sourceAncestor !== targetAncestor) {
      const edgeKey = `${sourceAncestor}->${targetAncestor}`

      if (aggregatedEdges.has(edgeKey)) {
        const existing = aggregatedEdges.get(edgeKey)!
        existing.sourceEdges.push(edge.id)
        existing.confidence = Math.min(1, existing.sourceEdges.length / 10) // More edges = higher confidence
      } else {
        aggregatedEdges.set(edgeKey, {
          id: `agg-${edgeKey}`,
          sourceId: sourceAncestor,
          targetId: targetAncestor,
          sourceEdges: [edge.id],
          confidence: 0.5,
          granularity: targetGranularity,
        })
      }
    }
  })

  return Array.from(aggregatedEdges.values())
}

/**
 * Project a graph view based on configuration
 */
export function projectGraph(
  nodes: Node[],
  edges: Edge[],
  config: ViewProjectionConfig
): ProjectedGraph {
  const containmentMap = buildContainmentMap(nodes, edges)

  // 1. Filter nodes by visible entity types
  let filteredNodes = nodes.filter((node) => {
    const nodeType = node.data?.type as string
    return config.visibleEntityTypes.includes(nodeType)
  })

  // 2. Optionally collapse children into parents
  if (config.collapseChildren) {
    // For each visible node, count hidden children
    filteredNodes = filteredNodes.map((node) => {
      const childCount = nodes.filter((n) =>
        containmentMap.get(n.id) === node.id
      ).length

      return {
        ...node,
        data: {
          ...node.data,
          _collapsedChildCount: childCount,
        }
      }
    })
  }

  // 3. Filter edges by visible relationship types
  let filteredEdges = edges.filter((edge) => {
    const edgeType = (edge.data?.relationship ?? edge.data?.edgeType ?? 'lineage') as string
    return config.visibleRelationshipTypes.includes(edgeType)
  })

  // 4. Keep only edges where both source and target are visible
  const visibleNodeIds = new Set(filteredNodes.map(n => n.id))
  filteredEdges = filteredEdges.filter((edge) =>
    visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
  )

  // 5. Aggregate lineage if configured
  const aggregatedEdges = new Map<string, AggregatedEdge>()
  if (config.aggregateLineage) {
    const aggregated = aggregateLineageEdges(
      edges, nodes, containmentMap, config.targetGranularity
    )

    // Convert aggregated edges to React Flow edges
    aggregated.forEach((agg) => {
      if (visibleNodeIds.has(agg.sourceId) && visibleNodeIds.has(agg.targetId)) {
        aggregatedEdges.set(agg.id, agg)

        // Add as a visible edge if not already present
        const directEdgeExists = filteredEdges.some(
          e => e.source === agg.sourceId && e.target === agg.targetId
        )

        if (!directEdgeExists) {
          filteredEdges.push({
            id: agg.id,
            source: agg.sourceId,
            target: agg.targetId,
            type: 'aggregated', // Use the AggregatedEdge component for visual distinction
            data: {
              edgeType: 'aggregated',
              confidence: agg.confidence,
              sourceEdgeCount: agg.sourceEdges.length,
              isAggregated: true,
            },
          })
        }
      }
    })
  }

  return {
    nodes: filteredNodes,
    edges: filteredEdges,
    aggregatedEdges,
  }
}

/**
 * Default view configurations
 */
export const VIEW_PROJECTION_CONFIGS: Record<string, ViewProjectionConfig> = {
  'data-lineage': {
    targetGranularity: GranularityLevel.Table,
    visibleEntityTypes: ['domain', 'app', 'system', 'dataset', 'asset', 'dashboard', 'pipeline'],
    visibleRelationshipTypes: ['produces', 'consumes', 'transforms', 'feeds', 'derives_from', 'lineage'],
    aggregateLineage: true, // Column lineage → Table lineage
    collapseChildren: true, // Hide columns, show count
    maxDepth: -1,
    containerTypes: ['domain', 'app'],
  },
  'column-lineage': {
    targetGranularity: GranularityLevel.Column,
    visibleEntityTypes: ['dataset', 'column', 'pipeline'],
    visibleRelationshipTypes: ['produces', 'consumes', 'transforms', 'derives_from', 'lineage', 'contains'],
    aggregateLineage: false, // Show actual column lineage
    collapseChildren: false,
    maxDepth: -1,
    containerTypes: [],
  },
  'physical-fabric': {
    targetGranularity: GranularityLevel.Column,
    visibleEntityTypes: ['domain', 'system', 'schema', 'dataset', 'column'],
    visibleRelationshipTypes: ['contains', 'has_schema', 'has_dataset', 'has_column'],
    aggregateLineage: false,
    collapseChildren: false, // Show all in hierarchy
    maxDepth: -1,
    containerTypes: ['domain', 'system', 'schema', 'dataset'],
  },
  'impact-analysis': {
    targetGranularity: GranularityLevel.Table,
    visibleEntityTypes: ['domain', 'app', 'dataset', 'dashboard'],
    visibleRelationshipTypes: ['produces', 'consumes', 'feeds'],
    aggregateLineage: true,
    collapseChildren: true,
    maxDepth: 5,
    containerTypes: ['domain'],
  },
}

/**
 * Get or create projection config for a view
 */
export function getViewProjectionConfig(viewId: string): ViewProjectionConfig {
  return VIEW_PROJECTION_CONFIGS[viewId] ?? VIEW_PROJECTION_CONFIGS['data-lineage']
}

