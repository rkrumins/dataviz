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

  // Edge types that constitute a containment relationship
  containmentEdgeTypes?: string[]
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
  edges: Edge[],
  containmentEdgeTypes: string[] = ['contains'] // Default for backward compatibility
): Map<string, string> {
  const containmentMap = new Map<string, string>()

  edges.forEach((edge) => {
    // Dynamic check for containment
    const edgeType = edge.data?.relationship as string || edge.data?.edgeType as string || ''
    if (containmentEdgeTypes.includes(edgeType)) {
      containmentMap.set(edge.target, edge.source)
    }
  })

  return containmentMap
}

/**
 * Summary of child counts for a node
 */
export interface NodeCountSummary {
  directChildren: number
  totalDescendants: number
  byType: Record<string, number> // e.g., { table: 5, column: 47 }
}

/**
 * Compute child counts for a node
 * Returns direct children count, total descendants, and breakdown by entity type
 */
export function computeNodeCounts(
  nodeId: string,
  nodes: Node[],
  containmentMap: Map<string, string>
): NodeCountSummary {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const result: NodeCountSummary = {
    directChildren: 0,
    totalDescendants: 0,
    byType: {},
  }

  // Build children map (parent → children[])
  const childrenMap = new Map<string, string[]>()
  containmentMap.forEach((parentId, childId) => {
    if (!childrenMap.has(parentId)) {
      childrenMap.set(parentId, [])
    }
    childrenMap.get(parentId)!.push(childId)
  })

  // Count direct children
  const directChildren = childrenMap.get(nodeId) ?? []
  result.directChildren = directChildren.length

  // Recursively count all descendants
  const countDescendants = (id: string): void => {
    const children = childrenMap.get(id) ?? []
    children.forEach(childId => {
      result.totalDescendants++
      const childNode = nodeMap.get(childId)
      if (childNode) {
        const childType = (childNode.data?.type as string) ?? 'unknown'
        result.byType[childType] = (result.byType[childType] ?? 0) + 1
      }
      countDescendants(childId)
    })
  }

  countDescendants(nodeId)

  return result
}

/**
 * Compute counts for all nodes in the graph
 * Returns a map of nodeId → NodeCountSummary
 */
export function computeAllNodeCounts(
  nodes: Node[],
  edges: Edge[]
): Map<string, NodeCountSummary> {
  const containmentMap = buildContainmentMap(nodes, edges)
  const countMap = new Map<string, NodeCountSummary>()

  nodes.forEach(node => {
    countMap.set(node.id, computeNodeCounts(node.id, nodes, containmentMap))
  })

  return countMap
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
  // Use View-Specific containment definition
  const containmentTypes = config.containmentEdgeTypes ?? ['contains', 'has_schema', 'has_dataset', 'has_column']
  const containmentMap = buildContainmentMap(nodes, edges, containmentTypes)

  // 1. Filter nodes by visible entity types
  let filteredNodes = nodes.filter((node) => {
    const nodeType = node.data?.type as string
    return config.visibleEntityTypes.includes(nodeType)
  })

  // 2. Collapse children for ALL levels (Generic)
  if (config.collapseChildren) {
    // For each visible node, count hidden children based on view hierarchy
    filteredNodes = filteredNodes.flatMap((node) => {
      // Find children in the FULL node list (rawNodes) using our dynamic map
      // NOTE: nodes passed to projectGraph are usually the Full Raw set? 
      // If 'nodes' is full raw set, we check which ones have 'node.id' as parent.

      const children = nodes.filter((n) =>
        containmentMap.get(n.id) === node.id
      )

      const childCount = children.length

      // Update the node with count info
      const updatedNode = {
        ...node,
        data: {
          ...node.data,
          _collapsedChildCount: childCount,
          _totalDescendants: 0, // Need full calc for this, skipping for perf now
        }
      }

      // GENERIC PAGINATION CHECK
      // If this node is "expanded" (meaning its children are supposed to be visible),
      // we check if all children are actually in the 'nodes' array.
      // Wait, 'nodes' IS the store nodes. If we are paginating, 'nodes' only contains loaded ones.
      // 'childCount' (from metadata) > 'children.length' (loaded) -> Show Load More.

      // We rely on node metadata for the TRUE total count from server
      const serverTotalCount = (node.data?.childCount as number) ?? childCount

      // How many are currently loaded/visible in this projection?
      // We only filtered by entity type above.
      // But 'children' array here is from 'nodes' (the store).
      // So if store has 5 columns, children.length is 5.
      // If server has 100, serverTotalCount is 100.

      const loadedChildrenCount = children.length

      if (serverTotalCount > loadedChildrenCount) {
        // Identify the type of missing children (heuristic)
        // Usually homogenous, take type of first child or generic 'item'
        const childType = children[0]?.data?.type as string || 'item'

        // Create Ghost Node
        const ghostNode: Node = {
          id: `ghost-${node.id}`,
          type: 'ghost',
          position: { x: 0, y: 0 }, // Layout will fix
          data: {
            label: `Load More`,
            hiddenCount: serverTotalCount - loadedChildrenCount, // Remaining to load
            nodeCount: serverTotalCount - loadedChildrenCount,
            parentId: node.id,
            entityType: childType,
            type: 'ghost' // For rendering
          },
          parentId: node.id, // Important for ELK if we supported compound nodes
          extent: 'parent',
        }

        // Return [node, ghostNode] IF the node is expanded? 
        // Actually, if collapseChildren is TRUE, we are hiding children anyway. 
        // This block is named "Collapse Children". Usually this means "Don't show children".
        // BUT standard behavior in this app seems to be: 
        // IF collapsed -> Show Badge. 
        // IF expanded -> Show Children.
        // 'collapseChildren' config might mean "Enable collapsible behavior".

        // Let's assume proper expansion handling happens in the HOOK or LAYOUT.
        // Wait, projectGraph does filtering. 
        // If a node is in 'expandedIds', we typically want its children to survive filter?

        // Re-reading logic:
        // Typical pattern: Container Node is visible. Its children are visible ONLY if container is expanded.
        // Current code just returns the node with updated data.
        // UseLineageExploration handles the expansion logic by adding children to 'visibleNodes'.

        // Actually, I should insert the Ghost Node into the result list
        // IF the node is expanded and we have partial data.
        // But projectGraph doesn't know about expansion state directly?
        // Ah, 'projectGraph' is receiving 'nodes' which are ALL loaded nodes.

        // If I insert a Ghost Node here, it becomes a visible node.
        // It should only be inserted if the parent is "open" visually?
        // Or does the user see "Load More" inside the collapsed node? No, usually as a sibling to children.

        // We'll insert it. The layout/renderer will decide where to put it. 
        // If children are visible, Ghost should be visible.
        // How do we know if children are visible?
        // In `projectToGranularity` we filtered by Granularity.
        // Here `projectGraph` seems to be the main projection.

        // Strategy: ALWAYS return the Ghost Node if there are missing children.
        // The filtering step downstream (or upstream in hook) will decide if we show it.
        // Actually, if we return it here, it will be rendered.
        // We only want to render it if the Parent is "expanded".
        // But we don't have expanded state here.

        // Alternative: The Ghost Node is a CHILD of the parent.
        // If the parent is collapsed, the Ghost Node is hidden (rolled up).
        // If the parent is expanded, the Ghost Node is shown.
        // This implies we need a "parent-child" relationship in React Flow? 
        // Or just containment edges?

        // Let's just return it. If the parent is collapsed, `useLineageExploration` (which calls this?)
        // wait, `useProjectedGraph` calls this.
        // It doesn't know about expansion.

        // Let's stick to the plan: Generic Pagination Logic.
        // If we detect partial data, we generate a Ghost Node.
        // We adding it to the list.
        return [updatedNode, ghostNode]
      }

      return [updatedNode]
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
    containmentEdgeTypes: ['contains', 'has_dataset', 'has_schema'], // Default for lineage view
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

