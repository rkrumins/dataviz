/**
 * useLineageExploration - Hook for managing lineage exploration state
 * 
 * Provides:
 * - Mode switching (overview/focused/full)
 * - Granularity control (column/table/schema/domain)
 * - Trace depth management
 * - Expansion state
 * - Computed visible nodes based on configuration
 */

import { useMemo } from 'react'
import { create } from 'zustand'
import type { Node, Edge } from '@xyflow/react'
import type {
  LineageExplorationConfig,
  LineageExplorationMode,
  LineageGranularity,
} from '@/types/schema'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import {
  GranularityLevel,
  ENTITY_GRANULARITY,
  buildContainmentMap,
  aggregateLineageEdges,
  computeAllNodeCounts,
} from '@/lib/projection-engine'

// ============================================
// EXPLORATION STORE
// ============================================

interface LineageExplorationState {
  // Current configuration
  config: LineageExplorationConfig

  // Focus entity
  focusEntityId: string | null

  // Expanded nodes
  expandedIds: Set<string>

  // Highlighted path (for lineage trace)
  highlightedPath: Set<string>

  // Pagination
  pagination: Record<string, number>

  // Actions
  setMode: (mode: LineageExplorationMode) => void
  setGranularity: (granularity: LineageGranularity) => void
  setFocus: (entityId: string | null) => void
  setUpstreamDepth: (depth: number) => void
  setDownstreamDepth: (depth: number) => void
  toggleExpanded: (entityId: string) => void
  expandAll: () => void
  collapseAll: () => void
  setHighlightedPath: (path: Set<string>) => void
  toggleIncludeChildLineage: () => void
  resetToDefault: (preset?: 'overview' | 'technical' | 'impact') => void
  loadMoreNodes: (parentId: string, count?: number) => void
  resetPagination: () => void
}

const DEFAULT_CONFIG: LineageExplorationConfig = {
  mode: 'overview',
  granularity: 'table',
  trace: {
    upstreamDepth: 3,
    downstreamDepth: 3,
    includeChildLineage: true,
    maxNodes: 100,
  },
  aggregation: {
    inheritFromChildren: true,
    showAggregatedEdges: true,
    minConfidence: 0.3,
  },
  expansion: {
    expandedIds: new Set(),
    autoExpandOnFocus: true,
    defaultExpandDepth: 2,
  },
  display: {
    showGhostNodes: true,
    showConfidence: true,
    showCounts: true,
    highlightPath: true,
  },
  containmentEdgeTypes: ['contains', 'has_schema', 'has_dataset', 'has_column'],
}

export const useLineageExplorationStore = create<LineageExplorationState>((set, get) => ({
  config: DEFAULT_CONFIG,
  focusEntityId: null,
  expandedIds: new Set(),
  highlightedPath: new Set(),

  // Pagination
  pagination: {},

  // Actions
  setMode: (mode) =>
    set((state) => ({
      config: { ...state.config, mode },
      // Reset expanded state on mode switch if needed
    })),

  setGranularity: (granularity) => set((state) => ({
    config: { ...state.config, granularity },
  })),

  setFocus: (entityId) => set({
    focusEntityId: entityId,
    config: {
      ...get().config,
      mode: entityId ? 'focused' : 'overview',
    },
  }),

  setUpstreamDepth: (depth) => set((state) => ({
    config: {
      ...state.config,
      trace: { ...state.config.trace, upstreamDepth: Math.max(0, depth) },
    },
  })),

  setDownstreamDepth: (depth) => set((state) => ({
    config: {
      ...state.config,
      trace: { ...state.config.trace, downstreamDepth: Math.max(0, depth) },
    },
  })),

  toggleExpanded: (entityId) => set((state) => {
    const newExpanded = new Set(state.expandedIds)
    if (newExpanded.has(entityId)) {
      newExpanded.delete(entityId)
    } else {
      newExpanded.add(entityId)
    }
    return { expandedIds: newExpanded }
  }),

  expandAll: () => set({
    expandedIds: new Set(['__all__']), // Special flag
  }),

  collapseAll: () => set({
    expandedIds: new Set(),
  }),

  setHighlightedPath: (path) => set({ highlightedPath: path }),

  toggleIncludeChildLineage: () => set((state) => ({
    config: {
      ...state.config,
      trace: {
        ...state.config.trace,
        includeChildLineage: !state.config.trace.includeChildLineage,
      },
    },
  })),

  resetToDefault: (preset = 'overview') => {
    set((state) => {
      let newConfig = { ...state.config }

      if (preset === 'overview') {
        newConfig.mode = 'overview'
        newConfig.granularity = 'domain'
        newConfig.trace.includeChildLineage = false
      } else if (preset === 'technical') {
        newConfig.mode = 'focused'
        newConfig.granularity = 'column'
        newConfig.trace.includeChildLineage = true
        newConfig.trace.upstreamDepth = 3
        newConfig.trace.downstreamDepth = 3
      } else if (preset === 'impact') {
        newConfig.mode = 'focused'
        newConfig.granularity = 'table'
        newConfig.trace.includeChildLineage = true
        newConfig.aggregation.inheritFromChildren = true
      }

      return {
        config: newConfig,
        focusEntityId: null,
        expandedIds: new Set(),
        pagination: {}, // Reset pagination
      }
    })
  },

  loadMoreNodes: (parentId, count = 20) =>
    set((state) => ({
      pagination: {
        ...state.pagination,
        [parentId]: (state.pagination[parentId] || 10) + count
      }
    })),

  resetPagination: () => set({ pagination: {} }),
}))

// ============================================
// TRACE COMPUTATION
// ============================================

interface TraceResult {
  nodes: Node[]
  edges: Edge[]
  upstreamNodes: Set<string>
  downstreamNodes: Set<string>
  pathNodes: Set<string>
  hasDirectLineage: boolean // Whether the focus entity has its own lineage
  inheritedFrom?: string // If lineage was inherited, the parent ID
}

/**
 * Compute trace from a focus entity
 * If the focused entity has no direct lineage, includes lineage from its parent container
 */
export function computeTrace(
  focusId: string,
  allNodes: Node[],
  allEdges: Edge[],
  upstreamDepth: number,
  downstreamDepth: number,
  includeChildLineage: boolean
): TraceResult {
  // const nodeMap = new Map(allNodes.map(n => [n.id, n]))
  // const nodeMap = new Map(allNodes.map(n => [n.id, n]))
  // Use View-Specific containment definition (passed or default?)
  // Ideally this function should accept config, but for now defaulting is safer than breaking signature
  const containmentMap = buildContainmentMap(allNodes, allEdges, ['contains', 'has_schema', 'has_dataset'])

  // Build adjacency lists
  const upstreamEdges = new Map<string, Edge[]>()
  const downstreamEdges = new Map<string, Edge[]>()

  // Find child nodes (for includeChildLineage)
  const childrenMap = new Map<string, string[]>()
  allNodes.forEach((node) => {
    const parentId = containmentMap.get(node.id)
    if (parentId) {
      if (!childrenMap.has(parentId)) {
        childrenMap.set(parentId, [])
      }
      childrenMap.get(parentId)!.push(node.id)
    }
  })

  // Build edge maps (skip containment edges)
  allEdges.forEach((edge) => {
    const rel = edge.data?.relationship ?? edge.data?.edgeType ?? ''
    // Skip containment edges for lineage trace
    if (rel === 'contains' || rel === 'has_schema' || rel === 'has_dataset' || rel === 'has_column') {
      return
    }

    // Downstream: edges where focus is source
    if (!downstreamEdges.has(edge.source)) {
      downstreamEdges.set(edge.source, [])
    }
    downstreamEdges.get(edge.source)!.push(edge)

    // Upstream: edges where focus is target
    if (!upstreamEdges.has(edge.target)) {
      upstreamEdges.set(edge.target, [])
    }
    upstreamEdges.get(edge.target)!.push(edge)
  })

  // Check if the focus entity has any direct lineage edges
  const focusUpstreamEdges = upstreamEdges.get(focusId) ?? []
  const focusDownstreamEdges = downstreamEdges.get(focusId) ?? []
  const hasDirectLineage = focusUpstreamEdges.length > 0 || focusDownstreamEdges.length > 0

  // If no direct lineage, try to inherit from parent
  let effectiveFocusId = focusId
  let inheritedFrom: string | undefined

  if (!hasDirectLineage) {
    // Get parent of focus entity
    const parentId = containmentMap.get(focusId)
    if (parentId) {
      const parentUpstream = upstreamEdges.get(parentId) ?? []
      const parentDownstream = downstreamEdges.get(parentId) ?? []
      if (parentUpstream.length > 0 || parentDownstream.length > 0) {
        // Use parent's lineage
        effectiveFocusId = parentId
        inheritedFrom = parentId
      }
    }
  }

  // BFS to find nodes at each depth
  const upstreamNodes = new Set<string>()
  const downstreamNodes = new Set<string>()
  const pathEdges = new Set<string>()

  // Include focus entity's children if configured
  const startIds = [effectiveFocusId]
  if (includeChildLineage) {
    const children = childrenMap.get(effectiveFocusId) ?? []
    startIds.push(...children)
    // Recursively get all descendants
    const getAllDescendants = (id: string): string[] => {
      const kids = childrenMap.get(id) ?? []
      return kids.concat(kids.flatMap(getAllDescendants))
    }
    startIds.push(...getAllDescendants(effectiveFocusId))
  }

  // Trace upstream
  let currentLevel = new Set(startIds)
  for (let depth = 0; depth < upstreamDepth; depth++) {
    const nextLevel = new Set<string>()

    currentLevel.forEach((nodeId) => {
      const edges = upstreamEdges.get(nodeId) ?? []
      edges.forEach((edge) => {
        if (!upstreamNodes.has(edge.source) && edge.source !== effectiveFocusId) {
          nextLevel.add(edge.source)
          pathEdges.add(edge.id)
        }
      })
    })

    nextLevel.forEach((id) => upstreamNodes.add(id))
    currentLevel = nextLevel
    if (currentLevel.size === 0) break
  }

  // Trace downstream
  currentLevel = new Set(startIds)
  for (let depth = 0; depth < downstreamDepth; depth++) {
    const nextLevel = new Set<string>()

    currentLevel.forEach((nodeId) => {
      const edges = downstreamEdges.get(nodeId) ?? []
      edges.forEach((edge) => {
        if (!downstreamNodes.has(edge.target) && edge.target !== effectiveFocusId) {
          nextLevel.add(edge.target)
          pathEdges.add(edge.id)
        }
      })
    })

    nextLevel.forEach((id) => downstreamNodes.add(id))
    currentLevel = nextLevel
    if (currentLevel.size === 0) break
  }

  // Collect all nodes in path
  const pathNodes = new Set([focusId, effectiveFocusId, ...upstreamNodes, ...downstreamNodes])

  // ALWAYS include parent containers up to domain level
  // This ensures the column's table, schema, and domain are always visible
  let currentId: string | undefined = focusId
  while (currentId) {
    const parentId = containmentMap.get(currentId)
    if (parentId) {
      pathNodes.add(parentId)
      currentId = parentId
    } else {
      currentId = undefined
    }
  }

  // Add focus children if included
  if (includeChildLineage) {
    const getAllDescendants = (id: string): string[] => {
      const kids = childrenMap.get(id) ?? []
      return kids.concat(kids.flatMap(getAllDescendants))
    }
    getAllDescendants(effectiveFocusId).forEach((id) => pathNodes.add(id))
  }

  // Filter nodes and edges
  const traceNodes = allNodes.filter((n) => pathNodes.has(n.id))

  // Include both lineage edges AND containment edges that connect visible nodes
  const traceEdges = allEdges.filter((e) =>
    pathNodes.has(e.source) && pathNodes.has(e.target)
  )

  return {
    nodes: traceNodes,
    edges: traceEdges,
    upstreamNodes,
    downstreamNodes,
    pathNodes,
    hasDirectLineage,
    inheritedFrom,
  }
}

// ============================================
// GRANULARITY PROJECTION
// ============================================

/**
 * Project nodes/edges to target granularity
 */
export function projectToGranularity(
  nodes: Node[],
  edges: Edge[],
  targetGranularity: LineageGranularity,
  inheritFromChildren: boolean,
  pagination: Record<string, number>,
  focusId: string | null = null,
  tracePath: Set<string> = new Set()
): { nodes: Node[]; edges: Edge[]; aggregatedEdges: Map<string, { sourceCount: number; confidence: number }> } {
  const granularityMap: Record<LineageGranularity, GranularityLevel> = {
    column: GranularityLevel.Column,
    table: GranularityLevel.Table,
    schema: GranularityLevel.Schema,
    system: GranularityLevel.System,
    domain: GranularityLevel.Domain,
  }

  const targetLevel = granularityMap[targetGranularity] || GranularityLevel.Column

  // Use View-Specific containment - passed in options? 
  // For now using a broad set to ensure we catch all potential parents
  const containmentMap = buildContainmentMap(nodes, edges, ['contains', 'has_schema', 'has_dataset', 'has_column'])

  // Filter nodes at or above target granularity
  const filteredNodes = nodes.filter((node) => {
    const nodeType = node.data?.type as string
    const nodeGranularity = ENTITY_GRANULARITY[nodeType] ?? GranularityLevel.Column
    return nodeGranularity >= targetLevel
  })

  const visibleNodes: Node[] = []
  const visibleNodeIds = new Set<string>()

  // PAGINATION LOGIC
  // Group children by parent to apply pagination limits
  const nodesByParent = new Map<string, Node[]>()
  const orphans: Node[] = []
  const hiddenCounts = new Map<string, number>()

  // Optimization: Create map for O(1) lookups
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  // Helper to get effective parent ID for pagination grouping
  const getPaginationParent = (node: Node) => {
    return containmentMap.get(node.id) || node.parentId
  }

  filteredNodes.forEach(node => {
    const parentId = getPaginationParent(node)
    // Only paginate if node is a 'child' type and has a visible parent
    // OPTIMIZED: Use Map lookup instead of Array.find (O(1) vs O(N))
    if (parentId && nodeMap.has(parentId)) {
      if (!nodesByParent.has(parentId)) {
        nodesByParent.set(parentId, [])
      }
      nodesByParent.get(parentId)!.push(node)
    } else {
      orphans.push(node)
    }
  })

  // Process grouped nodes
  const DEFAULT_PAGE_SIZE = 5

  nodesByParent.forEach((children, parentId) => {
    // Determine the entity type of children (heuristic)
    // const childType = children[0]?.data?.type as string || 'item'

    // Sort alphabetically by label
    children.sort((a, b) => {
      const labelA = (a.data?.label as string) || a.id
      const labelB = (b.data?.label as string) || b.id
      return labelA.localeCompare(labelB)
    })

    const limit = pagination[parentId] || DEFAULT_PAGE_SIZE

    // Split into visible and hidden, but ALWAYS keep focused/traced nodes visible
    let visibleCount = 0
    let hiddenCount = 0

    // Check if we have partial data (Server Side Pagination)
    // We assume the parent node has the TRUE total count in metadata
    // OPTIMIZED: Use Map lookup
    const parentNode = nodeMap.get(parentId)
    const serverTotalCount = (parentNode?.data?.childCount as number) ?? children.length

    // Generic Logic: Render up to LIMIT from the LOADED children
    children.forEach((child, index) => {
      const isImportant = (focusId && child.id === focusId) || tracePath.has(child.id)

      if (index < limit || isImportant) {
        visibleNodes.push(child)
        visibleCount++
      }
    })

    // Calculate how many are hidden (both locally hidden AND not yet loaded)
    // Hidden = (ServerTotal - Visible)
    hiddenCount = serverTotalCount - visibleCount

    if (hiddenCount > 0) {
      hiddenCounts.set(parentId, hiddenCount)
    }
  })

  // Add orphans (nodes without parents in the map, e.g. Domain nodes)
  orphans.forEach(n => visibleNodes.push(n))

  // Update ID set for edge filtering
  visibleNodes.forEach(n => visibleNodeIds.add(n.id))

  // Aggregate edges from lower granularity
  const aggregatedEdges = new Map<string, { sourceCount: number; confidence: number; sourceEdges: string[] }>()

  if (inheritFromChildren) {
    const aggregated = aggregateLineageEdges(edges, nodes, containmentMap, targetLevel)
    aggregated.forEach((agg) => {
      if (visibleNodeIds.has(agg.sourceId) && visibleNodeIds.has(agg.targetId)) {
        aggregatedEdges.set(`${agg.sourceId}->${agg.targetId}`, {
          sourceCount: agg.sourceEdges.length,
          confidence: agg.confidence,
          sourceEdges: agg.sourceEdges,
        })
      }
    })
  }

  // Create edges for visible nodes (don't filter containment - let UI edge filters handle that)
  const visibleEdges = edges.filter((edge) => {
    return visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
  })

  // Add aggregated edges
  aggregatedEdges.forEach((agg, key) => {
    const [source, target] = key.split('->')
    const existingEdge = visibleEdges.find(e => e.source === source && e.target === target)

    if (!existingEdge) {
      visibleEdges.push({
        id: `agg-${key}`,
        source,
        target,
        type: 'aggregated', // Use the AggregatedEdge component
        data: {
          edgeType: 'aggregated',
          isAggregated: true,
          sourceEdgeCount: agg.sourceCount,
          confidence: agg.confidence,
        },
      })
    }
  })

  // Compute all node counts (direct children, total descendants, breakdown by type)
  const allNodeCounts = computeAllNodeCounts(nodes, edges)

  // Add child counts to visible nodes
  const nodesWithCounts = visibleNodes.map((node) => {
    const counts = allNodeCounts.get(node.id) ?? {
      directChildren: 0,
      totalDescendants: 0,
      byType: {},
    }

    // Check if this node has any aggregated lineage edges as source
    let hasAggregatedLineage = false
    aggregatedEdges.forEach((_agg, key) => {
      if (key.startsWith(node.id + '->')) {
        hasAggregatedLineage = true
      }
    })

    return {
      ...node,
      data: {
        ...node.data,
        _collapsedChildCount: counts.directChildren,
        _totalDescendants: counts.totalDescendants,
        _hasAggregatedLineage: hasAggregatedLineage,
        _hiddenCount: hiddenCounts.get(node.id) || 0,
        _paginationId: node.id,
      },
    }
  })

  return {
    nodes: nodesWithCounts,
    edges: visibleEdges,
    aggregatedEdges: new Map(
      Array.from(aggregatedEdges.entries()).map(([k, v]) => [k, { sourceCount: v.sourceCount, confidence: v.confidence }])
    ),
  }
}

// ============================================
// MAIN HOOK
// ============================================

export interface UseLineageExplorationResult {
  // Configuration
  config: LineageExplorationConfig
  mode: LineageExplorationMode
  granularity: LineageGranularity
  focusEntityId: string | null
  expandedIds: Set<string>

  // Computed data
  visibleNodes: Node[]
  visibleEdges: Edge[]
  aggregatedEdges: Map<string, { sourceCount: number; confidence: number }>

  // Path info
  upstreamCount: number
  downstreamCount: number
  highlightedPath: Set<string>

  // Pagination
  pagination: Record<string, number>

  // Actions
  setMode: (mode: LineageExplorationMode) => void
  setGranularity: (granularity: LineageGranularity) => void
  setFocus: (entityId: string | null) => void
  setUpstreamDepth: (depth: number) => void
  setDownstreamDepth: (depth: number) => void
  toggleExpanded: (entityId: string) => void
  expandAll: () => void
  collapseAll: () => void
  toggleIncludeChildLineage: () => void
  resetToDefault: (preset?: 'overview' | 'technical' | 'impact') => void
  loadMoreNodes: (parentId: string, count?: number) => void
  resetPagination: () => void
}

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useEffect } from 'react'

export function useLineageExploration(): UseLineageExplorationResult {
  const provider = useGraphProvider()
  const {
    config,
    focusEntityId,
    expandedIds,
    highlightedPath,
    pagination,
    setMode,
    setGranularity,
    setFocus,
    setUpstreamDepth,
    setDownstreamDepth,
    toggleExpanded,
    expandAll,
    collapseAll,
    setHighlightedPath,
    toggleIncludeChildLineage,
    resetToDefault,
    loadMoreNodes,
    resetPagination,
  } = useLineageExplorationStore()

  const rawNodes = useCanvasStore((s) => s.nodes)
  const rawEdges = useCanvasStore((s) => s.edges)
  const { setNodes, setEdges } = useCanvasStore()

  // Side Effect: Fetch data when pagination limit increases
  useEffect(() => {
    const syncPagination = async () => {
      const containmentTypes = config.containmentEdgeTypes ?? ['contains', 'has_schema', 'has_dataset', 'has_column']

      for (const [parentId, limit] of Object.entries(pagination)) {
        const parentNode = rawNodes.find(n => n.id === parentId)
        if (!parentNode) continue

        // Count currently loaded children in the store
        const childIds = new Set<string>()
        rawEdges.forEach(e => {
          const type = e.data?.relationship as string || e.data?.edgeType as string || ''
          if (e.source === parentId && containmentTypes.includes(type)) {
            childIds.add(e.target)
          }
        })

        const loadedCount = childIds.size

        // If we need more nodes than we have loaded, fetch them
        if (loadedCount < limit) {
          const parentUrn = (parentNode.data?.urn as string) || parentId
          try {
            // Fetch up to the new limit
            const newChildren = await provider.getChildren(parentUrn, {
              edgeTypes: containmentTypes,
              offset: 0,
              limit: limit
            })

            if (newChildren.length > 0) {
              const existingIds = new Set(rawNodes.map(n => n.id))
              const nodesToAdd: Node[] = []
              const edgesToAdd: Edge[] = []

              newChildren.forEach(child => {
                if (!existingIds.has(child.urn)) {
                  nodesToAdd.push({
                    id: child.urn,
                    type: 'generic',
                    position: { x: 0, y: 0 },
                    data: {
                      ...child.properties,
                      label: child.displayName,
                      type: child.entityType,
                      urn: child.urn,
                    }
                  })

                  edgesToAdd.push({
                    id: `${parentUrn}-${child.urn}`,
                    source: parentId, // Use ID for ReactFlow edge
                    target: child.urn,
                    type: 'lineage',
                    data: { relationship: 'contains', edgeType: 'contains' }
                  })
                }
              })

              if (nodesToAdd.length > 0) {
                console.log(`[Lineage] Lazy loaded ${nodesToAdd.length} nodes for ${parentId}`)
                setNodes([...rawNodes, ...nodesToAdd] as any)
                setEdges([...rawEdges, ...edgesToAdd] as any)
              }
            }
          } catch (err) {
            console.error("Failed to lazy load nodes", err)
          }
        }
      }
    }

    syncPagination()
  }, [pagination, rawNodes, rawEdges, provider, config.containmentEdgeTypes, setNodes, setEdges])

  // Compute visible nodes/edges based on configuration
  const { visibleNodes, visibleEdges, aggregatedEdges, upstreamCount, downstreamCount } = useMemo(() => {
    if (rawNodes.length === 0) {
      return {
        visibleNodes: [],
        visibleEdges: [],
        aggregatedEdges: new Map(),
        upstreamCount: 0,
        downstreamCount: 0,
      }
    }

    let nodes = rawNodes
    let edges = rawEdges
    let upCount = 0
    let downCount = 0

    // 1. If focused mode, compute trace first
    if (config.mode === 'focused' && focusEntityId) {
      const trace = computeTrace(
        focusEntityId,
        rawNodes,
        rawEdges,
        config.trace.upstreamDepth,
        config.trace.downstreamDepth,
        config.trace.includeChildLineage
      )
      nodes = trace.nodes as LineageNode[]
      edges = trace.edges
      upCount = trace.upstreamNodes.size
      downCount = trace.downstreamNodes.size

      // Update highlighted path
      setHighlightedPath(trace.pathNodes)
    }

    // 2. Project to target granularity
    const projected = projectToGranularity(
      nodes,
      edges,
      config.granularity,
      config.aggregation.inheritFromChildren,
      pagination,
      focusEntityId,
      highlightedPath
    )

    return {
      visibleNodes: projected.nodes,
      visibleEdges: projected.edges,
      aggregatedEdges: projected.aggregatedEdges,
      upstreamCount: upCount,
      downstreamCount: downCount,
    }
  }, [
    rawNodes,
    rawEdges,
    config.mode,
    config.granularity,
    config.trace.upstreamDepth,
    config.trace.downstreamDepth,
    config.trace.includeChildLineage,
    config.aggregation.inheritFromChildren,
    pagination,
    focusEntityId,
    setHighlightedPath,
  ])

  return {
    config,
    mode: config.mode,
    granularity: config.granularity,
    focusEntityId,
    expandedIds,
    visibleNodes,
    visibleEdges,
    aggregatedEdges,
    upstreamCount,
    downstreamCount,
    highlightedPath,
    pagination,
    setMode,
    setGranularity,
    setFocus,
    setUpstreamDepth,
    setDownstreamDepth,
    toggleExpanded,
    expandAll,
    collapseAll,
    toggleIncludeChildLineage,
    resetToDefault,
    loadMoreNodes,
    resetPagination,
  }
}

