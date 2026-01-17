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

import { useState, useCallback, useMemo } from 'react'
import { create } from 'zustand'
import type { Node, Edge } from '@xyflow/react'
import type { 
  LineageExplorationConfig, 
  LineageExplorationMode, 
  LineageGranularity,
  DEFAULT_EXPLORATION_CONFIGS,
} from '@/types/schema'
import { useCanvasStore } from '@/store/canvas'
import {
  GranularityLevel,
  ENTITY_GRANULARITY,
  buildContainmentMap,
  findAncestorAtGranularity,
  aggregateLineageEdges,
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
}

export const useLineageExplorationStore = create<LineageExplorationState>((set, get) => ({
  config: DEFAULT_CONFIG,
  focusEntityId: null,
  expandedIds: new Set(),
  highlightedPath: new Set(),
  
  setMode: (mode) => set((state) => ({
    config: { ...state.config, mode },
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
    const presets: Record<string, Partial<LineageExplorationConfig>> = {
      overview: {
        mode: 'overview',
        granularity: 'table',
        trace: { upstreamDepth: 2, downstreamDepth: 2, includeChildLineage: true, maxNodes: 100 },
        aggregation: { inheritFromChildren: true, showAggregatedEdges: true, minConfidence: 0.3 },
      },
      technical: {
        mode: 'focused',
        granularity: 'column',
        trace: { upstreamDepth: 5, downstreamDepth: 5, includeChildLineage: false, maxNodes: 200 },
        aggregation: { inheritFromChildren: false, showAggregatedEdges: false, minConfidence: 0 },
      },
      impact: {
        mode: 'focused',
        granularity: 'table',
        trace: { upstreamDepth: 10, downstreamDepth: 10, includeChildLineage: true, maxNodes: 150 },
        aggregation: { inheritFromChildren: true, showAggregatedEdges: true, minConfidence: 0.5 },
      },
    }
    
    const presetConfig = presets[preset]
    set({
      config: {
        ...DEFAULT_CONFIG,
        ...presetConfig,
        trace: { ...DEFAULT_CONFIG.trace, ...(presetConfig?.trace ?? {}) },
        aggregation: { ...DEFAULT_CONFIG.aggregation, ...(presetConfig?.aggregation ?? {}) },
      },
      expandedIds: new Set(),
      highlightedPath: new Set(),
    })
  },
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
}

/**
 * Compute trace from a focus entity
 */
export function computeTrace(
  focusId: string,
  allNodes: Node[],
  allEdges: Edge[],
  upstreamDepth: number,
  downstreamDepth: number,
  includeChildLineage: boolean
): TraceResult {
  const nodeMap = new Map(allNodes.map(n => [n.id, n]))
  const containmentMap = buildContainmentMap(allNodes, allEdges)
  
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
  
  // Build edge maps
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
  
  // BFS to find nodes at each depth
  const upstreamNodes = new Set<string>()
  const downstreamNodes = new Set<string>()
  const pathEdges = new Set<string>()
  
  // Include focus entity's children if configured
  const startIds = [focusId]
  if (includeChildLineage) {
    const children = childrenMap.get(focusId) ?? []
    startIds.push(...children)
    // Recursively get all descendants
    const getAllDescendants = (id: string): string[] => {
      const kids = childrenMap.get(id) ?? []
      return kids.concat(kids.flatMap(getAllDescendants))
    }
    startIds.push(...getAllDescendants(focusId))
  }
  
  // Trace upstream
  let currentLevel = new Set(startIds)
  for (let depth = 0; depth < upstreamDepth; depth++) {
    const nextLevel = new Set<string>()
    
    currentLevel.forEach((nodeId) => {
      const edges = upstreamEdges.get(nodeId) ?? []
      edges.forEach((edge) => {
        if (!upstreamNodes.has(edge.source) && edge.source !== focusId) {
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
        if (!downstreamNodes.has(edge.target) && edge.target !== focusId) {
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
  const pathNodes = new Set([focusId, ...upstreamNodes, ...downstreamNodes])
  
  // Add focus children if included
  if (includeChildLineage) {
    const getAllDescendants = (id: string): string[] => {
      const kids = childrenMap.get(id) ?? []
      return kids.concat(kids.flatMap(getAllDescendants))
    }
    getAllDescendants(focusId).forEach((id) => pathNodes.add(id))
  }
  
  // Filter nodes and edges
  const traceNodes = allNodes.filter((n) => pathNodes.has(n.id))
  const traceEdges = allEdges.filter((e) => 
    pathNodes.has(e.source) && pathNodes.has(e.target)
  )
  
  return {
    nodes: traceNodes,
    edges: traceEdges,
    upstreamNodes,
    downstreamNodes,
    pathNodes,
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
  inheritFromChildren: boolean
): { nodes: Node[]; edges: Edge[]; aggregatedEdges: Map<string, { sourceCount: number; confidence: number }> } {
  const granularityMap: Record<LineageGranularity, GranularityLevel> = {
    column: GranularityLevel.Column,
    table: GranularityLevel.Table,
    schema: GranularityLevel.Schema,
    system: GranularityLevel.System,
    domain: GranularityLevel.Domain,
  }
  
  const targetLevel = granularityMap[targetGranularity]
  const containmentMap = buildContainmentMap(nodes, edges)
  
  // Filter nodes at or above target granularity
  const visibleNodes = nodes.filter((node) => {
    const nodeType = node.data?.type as string
    const nodeGranularity = ENTITY_GRANULARITY[nodeType] ?? GranularityLevel.Column
    return nodeGranularity >= targetLevel
  })
  
  const visibleNodeIds = new Set(visibleNodes.map(n => n.id))
  
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
  
  // Create edges for visible nodes
  const visibleEdges = edges.filter((edge) => {
    const rel = edge.data?.relationship ?? edge.data?.edgeType ?? ''
    if (rel === 'contains' || rel === 'has_schema' || rel === 'has_dataset' || rel === 'has_column') {
      return false // Skip containment edges
    }
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
  
  // Add child counts to visible nodes
  const nodesWithCounts = visibleNodes.map((node) => {
    // Count children at lower granularity
    let childCount = 0
    nodes.forEach((potentialChild) => {
      if (containmentMap.get(potentialChild.id) === node.id) {
        childCount++
      }
    })
    
    return {
      ...node,
      data: {
        ...node.data,
        _collapsedChildCount: childCount,
        _hasAggregatedLineage: aggregatedEdges.has(node.id),
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
  
  // Computed data
  visibleNodes: Node[]
  visibleEdges: Edge[]
  aggregatedEdges: Map<string, { sourceCount: number; confidence: number }>
  
  // Path info
  upstreamCount: number
  downstreamCount: number
  highlightedPath: Set<string>
  
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
}

export function useLineageExploration(): UseLineageExplorationResult {
  const {
    config,
    focusEntityId,
    expandedIds,
    highlightedPath,
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
  } = useLineageExplorationStore()
  
  const rawNodes = useCanvasStore((s) => s.nodes)
  const rawEdges = useCanvasStore((s) => s.edges)
  
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
      nodes = trace.nodes
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
      config.aggregation.inheritFromChildren
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
    focusEntityId,
    setHighlightedPath,
  ])
  
  return {
    config,
    mode: config.mode,
    granularity: config.granularity,
    focusEntityId,
    visibleNodes,
    visibleEdges,
    aggregatedEdges,
    upstreamCount,
    downstreamCount,
    highlightedPath,
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
  }
}

