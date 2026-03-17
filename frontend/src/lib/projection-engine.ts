/**
 * Projection Engine - Derives context views from underlying data
 *
 * This engine transforms raw physical metadata into view-specific
 * representations with:
 * - Lineage Aggregation (fine → coarse, driven by ontology hierarchy levels)
 * - Edge Promotion (if fine-grained nodes have lineage, so do their ancestors)
 * - Visibility Filtering (hide/show entity types per view)
 * - Containment Collapse (roll up children into parents)
 *
 * All granularity knowledge is now driven by the ontology DB via
 * EntityTypeSchema.hierarchy.level — no hardcoded type lists or enum buckets.
 */

import type { Node, Edge } from '@xyflow/react'

// Minimal entity type descriptor needed for level-based comparisons.
// Matches the EntityTypeSchema shape from the schema store.
type EntityTypeLevel = { id: string; hierarchy: { level: number } }

/**
 * Build a parent type map from ontology entity type hierarchy.
 * Returns: { childTypeId: parentTypeId } using the first entry of canBeContainedBy.
 *
 * Use this to construct a type-level containment map for ancestor walks
 * when only entity type IDs are known (not full node sets).
 */
export function buildParentTypeMap(
  entityTypes: Array<{ id: string; hierarchy: { canBeContainedBy: string[] } }>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const et of entityTypes) {
    if (et.hierarchy.canBeContainedBy.length > 0) {
      result[et.id] = et.hierarchy.canBeContainedBy[0]
    }
  }
  return result
}

/**
 * Returns true if nodeTypeId is finer-grained than targetTypeId.
 *
 * "Finer" means a higher hierarchy.level in the ontology
 * (e.g. column at level 4 is finer than dataset at level 3).
 * Unknown types default to level 9999 (treated as finest leaf).
 */
export function isFinerThan(
  nodeTypeId: string,
  targetTypeId: string,
  entityTypes: EntityTypeLevel[],
): boolean {
  const nodeLevel = entityTypes.find((e) => e.id === nodeTypeId)?.hierarchy.level ?? 9999
  const targetLevel = entityTypes.find((e) => e.id === targetTypeId)?.hierarchy.level ?? 0
  return nodeLevel > targetLevel
}

export interface ViewProjectionConfig {
  /**
   * Target entity type ID for lineage aggregation (e.g. "dataset", "term").
   * null = no aggregation — show finest-grained lineage as-is.
   * The value must be a valid entity type ID from the active ontology.
   */
  targetGranularityType: string | null

  // Visible entity types (by ID). Empty array = show all types.
  visibleEntityTypes: string[]

  // Visible relationship/edge types (by ID). Empty array = show all types.
  visibleRelationshipTypes: string[]

  // Whether to aggregate lineage edges upward to targetGranularityType
  aggregateLineage: boolean

  // Whether to collapse children into parents (show count badge)
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
  // Original fine-grained edges that were aggregated into this one
  sourceEdges: string[]
  // Confidence based on number of supporting source edges (0–1)
  confidence: number
  // The entity type ID used as the aggregation target (e.g. "dataset")
  granularityType: string | null
}

/**
 * Build containment map from nodes and edges.
 * Returns: childId → parentId
 */
export function buildContainmentMap(
  _nodes: Node[],
  edges: Edge[],
  containmentEdgeTypes: string[] = ['contains'],
): Map<string, string> {
  const containmentMap = new Map<string, string>()

  edges.forEach((edge) => {
    const edgeType = (edge.data?.relationship as string) || (edge.data?.edgeType as string) || ''
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
  byType: Record<string, number> // e.g., { dataset: 5, column: 47 }
}

/**
 * Compute child counts for a node.
 * Returns direct children count, total descendants, and breakdown by entity type.
 */
export function computeNodeCounts(
  nodeId: string,
  nodes: Node[],
  containmentMap: Map<string, string>,
): NodeCountSummary {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
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

  const directChildren = childrenMap.get(nodeId) ?? []
  result.directChildren = directChildren.length

  const countDescendants = (id: string): void => {
    const children = childrenMap.get(id) ?? []
    children.forEach((childId) => {
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
 * Compute counts for all nodes in the graph.
 * Returns a map of nodeId → NodeCountSummary.
 */
export function computeAllNodeCounts(nodes: Node[], edges: Edge[]): Map<string, NodeCountSummary> {
  const containmentMap = buildContainmentMap(nodes, edges)
  const countMap = new Map<string, NodeCountSummary>()
  nodes.forEach((node) => {
    countMap.set(node.id, computeNodeCounts(node.id, nodes, containmentMap))
  })
  return countMap
}

/**
 * Find the nearest ancestor of nodeId that is at or coarser than targetTypeId.
 *
 * Walk the containment chain upward until reaching a node whose entity type
 * is NOT finer than the target (i.e., hierarchy.level <= target level).
 *
 * @param nodeId - Starting node
 * @param targetTypeId - Entity type ID to aggregate to (e.g. "dataset"). null = return nodeId immediately.
 * @param nodes - Full node set
 * @param containmentMap - childId → parentId map
 * @param entityTypes - Ontology entity type definitions for level comparison
 */
export function findAncestorAtGranularity(
  nodeId: string,
  targetTypeId: string | null,
  nodes: Node[],
  containmentMap: Map<string, string>,
  entityTypes: EntityTypeLevel[] = [],
): string | null {
  if (targetTypeId === null) return nodeId

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  let currentId: string | undefined = nodeId
  const visited = new Set<string>()

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const node = nodeMap.get(currentId)
    if (!node) return null

    const nodeType = node.data?.type as string
    if (!isFinerThan(nodeType, targetTypeId, entityTypes)) {
      // This node is at or coarser than the target — it's our ancestor
      return currentId
    }

    currentId = containmentMap.get(currentId)
  }

  return null
}

/**
 * Aggregate lineage edges to a coarser entity type level.
 *
 * For example, if column A (in dataset X) → column B (in dataset Y),
 * this derives: dataset X → dataset Y.
 *
 * @param targetGranularityType - Entity type ID to aggregate to (e.g. "dataset").
 *   null or empty string = return empty (no aggregation; caller should use raw edges).
 * @param entityTypes - Ontology entity type definitions for level comparison.
 * @param containmentEdgeTypes - Edge types that are containment (excluded from lineage).
 */
export function aggregateLineageEdges(
  edges: Edge[],
  nodes: Node[],
  containmentMap: Map<string, string>,
  targetGranularityType: string | null,
  entityTypes: EntityTypeLevel[] = [],
  containmentEdgeTypes: string[] = ['contains', 'has_schema', 'has_dataset', 'has_column'],
): AggregatedEdge[] {
  if (!targetGranularityType) return []

  const aggregatedEdges = new Map<string, AggregatedEdge>()

  const lineageEdges = edges.filter((edge) => {
    const rel = (edge.data?.relationship ?? edge.data?.edgeType ?? '') as string
    return !containmentEdgeTypes.includes(rel)
  })

  lineageEdges.forEach((edge) => {
    const sourceAncestor = findAncestorAtGranularity(
      edge.source,
      targetGranularityType,
      nodes,
      containmentMap,
      entityTypes,
    )
    const targetAncestor = findAncestorAtGranularity(
      edge.target,
      targetGranularityType,
      nodes,
      containmentMap,
      entityTypes,
    )

    if (sourceAncestor && targetAncestor && sourceAncestor !== targetAncestor) {
      const edgeKey = `${sourceAncestor}->${targetAncestor}`

      if (aggregatedEdges.has(edgeKey)) {
        const existing = aggregatedEdges.get(edgeKey)!
        existing.sourceEdges.push(edge.id)
        existing.confidence = Math.min(1, existing.sourceEdges.length / 10)
      } else {
        aggregatedEdges.set(edgeKey, {
          id: `agg-${edgeKey}`,
          sourceId: sourceAncestor,
          targetId: targetAncestor,
          sourceEdges: [edge.id],
          confidence: 0.5,
          granularityType: targetGranularityType,
        })
      }
    }
  })

  return Array.from(aggregatedEdges.values())
}

/**
 * Project a graph view based on configuration.
 *
 * @param entityTypes - Ontology entity type definitions. Required for
 *   granularity-based lineage aggregation. Can be omitted if aggregateLineage is false.
 */
export function projectGraph(
  nodes: Node[],
  edges: Edge[],
  config: ViewProjectionConfig,
  entityTypes: EntityTypeLevel[] = [],
): ProjectedGraph {
  const containmentTypes = config.containmentEdgeTypes ?? ['contains', 'has_schema', 'has_dataset', 'has_column']
  const containmentMap = buildContainmentMap(nodes, edges, containmentTypes)

  // 1. Filter nodes by visible entity types (empty = show all)
  let filteredNodes =
    config.visibleEntityTypes.length > 0
      ? nodes.filter((node) => {
          const nodeType = node.data?.type as string
          return config.visibleEntityTypes.includes(nodeType)
        })
      : [...nodes]

  // 2. Collapse children — count hidden children and generate ghost nodes for pagination
  if (config.collapseChildren) {
    filteredNodes = filteredNodes.flatMap((node) => {
      const children = nodes.filter((n) => containmentMap.get(n.id) === node.id)
      const childCount = children.length
      const updatedNode = {
        ...node,
        data: {
          ...node.data,
          _collapsedChildCount: childCount,
          _totalDescendants: 0,
        },
      }

      const serverTotalCount = (node.data?.childCount as number) ?? childCount
      const loadedChildrenCount = children.length

      if (serverTotalCount > loadedChildrenCount) {
        const childType = (children[0]?.data?.type as string) || 'item'
        const ghostNode: Node = {
          id: `ghost-${node.id}`,
          type: 'ghost',
          position: { x: 0, y: 0 },
          data: {
            label: 'Load More',
            hiddenCount: serverTotalCount - loadedChildrenCount,
            nodeCount: serverTotalCount - loadedChildrenCount,
            parentId: node.id,
            entityType: childType,
            type: 'ghost',
          },
          parentId: node.id,
          extent: 'parent',
        }
        return [updatedNode, ghostNode]
      }

      return [updatedNode]
    })
  }

  // 3. Filter edges by visible relationship types (empty = show all)
  let filteredEdges =
    config.visibleRelationshipTypes.length > 0
      ? edges.filter((edge) => {
          const edgeType = (edge.data?.relationship ?? edge.data?.edgeType ?? 'lineage') as string
          return config.visibleRelationshipTypes.includes(edgeType)
        })
      : [...edges]

  // 4. Keep only edges where both endpoints are visible
  const visibleNodeIds = new Set(filteredNodes.map((n) => n.id))
  filteredEdges = filteredEdges.filter(
    (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  )

  // 5. Aggregate lineage if configured
  const aggregatedEdges = new Map<string, AggregatedEdge>()
  if (config.aggregateLineage && config.targetGranularityType) {
    const aggregated = aggregateLineageEdges(
      edges,
      nodes,
      containmentMap,
      config.targetGranularityType,
      entityTypes,
      containmentTypes,
    )

    aggregated.forEach((agg) => {
      if (visibleNodeIds.has(agg.sourceId) && visibleNodeIds.has(agg.targetId)) {
        aggregatedEdges.set(agg.id, agg)

        const directEdgeExists = filteredEdges.some(
          (e) => e.source === agg.sourceId && e.target === agg.targetId,
        )

        if (!directEdgeExists) {
          filteredEdges.push({
            id: agg.id,
            source: agg.sourceId,
            target: agg.targetId,
            type: 'aggregated',
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
 * Default view projection configs for standard ontology views.
 *
 * These are fallback definitions for built-in view types when no
 * saved view configuration is available. For custom ontologies, the
 * saved view record in the DB provides visibleEntityTypes/visibleRelationshipTypes.
 *
 * targetGranularityType uses standard ontology entity type IDs.
 * Callers using custom ontologies should override this with the appropriate type ID.
 */
export const VIEW_PROJECTION_CONFIGS: Record<string, ViewProjectionConfig> = {
  'data-lineage': {
    targetGranularityType: 'dataset',
    visibleEntityTypes: ['domain', 'app', 'system', 'dataset', 'asset', 'dashboard', 'pipeline'],
    visibleRelationshipTypes: ['produces', 'consumes', 'transforms', 'feeds', 'derives_from', 'lineage'],
    aggregateLineage: true,
    collapseChildren: true,
    maxDepth: -1,
    containerTypes: ['domain', 'app'],
    containmentEdgeTypes: ['contains', 'has_dataset', 'has_schema'],
  },
  'column-lineage': {
    targetGranularityType: null,
    visibleEntityTypes: ['dataset', 'column', 'pipeline'],
    visibleRelationshipTypes: ['produces', 'consumes', 'transforms', 'derives_from', 'lineage', 'contains'],
    aggregateLineage: false,
    collapseChildren: false,
    maxDepth: -1,
    containerTypes: [],
  },
  'physical-fabric': {
    targetGranularityType: null,
    visibleEntityTypes: ['domain', 'system', 'schema', 'dataset', 'column'],
    visibleRelationshipTypes: ['contains', 'has_schema', 'has_dataset', 'has_column'],
    aggregateLineage: false,
    collapseChildren: false,
    maxDepth: -1,
    containerTypes: ['domain', 'system', 'schema', 'dataset'],
  },
  'impact-analysis': {
    targetGranularityType: 'dataset',
    visibleEntityTypes: ['domain', 'app', 'dataset', 'dashboard'],
    visibleRelationshipTypes: ['produces', 'consumes', 'feeds'],
    aggregateLineage: true,
    collapseChildren: true,
    maxDepth: 5,
    containerTypes: ['domain'],
  },
}

/**
 * Get the default projection config for a named view type.
 * Falls back to 'data-lineage' for unknown view IDs.
 */
export function getViewProjectionConfig(viewId: string): ViewProjectionConfig {
  return VIEW_PROJECTION_CONFIGS[viewId] ?? VIEW_PROJECTION_CONFIGS['data-lineage']
}
