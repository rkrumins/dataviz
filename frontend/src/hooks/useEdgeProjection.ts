/**
 * useEdgeProjection - Extracted from ReferenceModelCanvas.tsx
 *
 * Encapsulates:
 * - lineageEdges: aggregated + expanded detailed + trace/regular edges
 * - visibleLineageEdges: edge projection/roll-up to visible ancestors
 *
 * Phase 5.1: ancestorMap is built incrementally — on expand/collapse only
 * the changed subtree is patched, avoiding a full O(N) traversal on every
 * user interaction. Full rebuild only happens when nodesByLayer changes
 * (layer re-assignment, initial load).
 */

import { useMemo, useRef } from 'react'
import { normalizeEdgeType } from '@/store/schema'
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
// Tree helpers for incremental ancestorMap updates
// ============================================

function searchSubtree(nodes: HierarchyNode[], id: string): HierarchyNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = searchSubtree(node.children, id)
    if (found) return found
  }
  return undefined
}

function findNodeById(nodesByLayer: Map<string, HierarchyNode[]>, id: string): HierarchyNode | undefined {
  for (const roots of nodesByLayer.values()) {
    const found = searchSubtree(roots, id)
    if (found) return found
  }
  return undefined
}

/** Map a node and all its descendants to `anchor` in the given map. */
function collapseSubtreeInMap(node: HierarchyNode, anchor: string, map: Map<string, string>) {
  if (node.urn) map.set(node.urn, anchor)
  map.set(node.id, anchor)
  node.children.forEach(c => collapseSubtreeInMap(c, anchor, map))
}

/**
 * When `node` is expanded, each direct child becomes visible and maps to
 * itself. If a child is already expanded, recurse so its children also
 * map correctly. If a child is collapsed, all its descendants roll up to it.
 */
function expandNodeInMap(node: HierarchyNode, expandedNodes: Set<string>, map: Map<string, string>) {
  node.children.forEach(child => {
    if (child.urn) map.set(child.urn, child.id)
    map.set(child.id, child.id)
    if (expandedNodes.has(child.id)) {
      expandNodeInMap(child, expandedNodes, map)
    } else {
      // Ensure all of this collapsed child's descendants roll up to it
      child.children.forEach(gc => collapseSubtreeInMap(gc, child.id, map))
    }
  })
}

/** Full O(N) build. Called on initial load and whenever nodesByLayer changes. */
function buildFullAncestorMap(
  nodesByLayer: Map<string, HierarchyNode[]>,
  expandedNodes: Set<string>,
  displayFlat: HierarchyNode[],
): Map<string, string> {
  const map = new Map<string, string>()

  const processNode = (node: HierarchyNode, currentVisibleAnchor: string) => {
    if (node.urn) map.set(node.urn, currentVisibleAnchor)
    map.set(node.id, currentVisibleAnchor)

    let childAnchor = currentVisibleAnchor
    if (node.id === currentVisibleAnchor) {
      childAnchor = expandedNodes.has(node.id) ? 'USE_CHILD_ID' : node.id
    }

    node.children?.forEach(child => {
      processNode(child, childAnchor === 'USE_CHILD_ID' ? child.id : childAnchor)
    })
  }

  nodesByLayer.forEach(roots => roots.forEach(root => processNode(root, root.id)))

  // Safety pass: visible nodes always map to themselves
  displayFlat.forEach(node => {
    if (!map.has(node.id)) map.set(node.id, node.id)
    if (node.urn && !map.has(node.urn)) map.set(node.urn, node.id)
  })

  return map
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

  // ── Incremental ancestorMap state ──────────────────────────────────────
  const ancestorMapRef = useRef<Map<string, string>>(new Map())
  const prevNodesByLayerRef = useRef<Map<string, HierarchyNode[]> | null>(null)
  const prevExpandedNodesRef = useRef<Set<string>>(new Set())

  // ── lineageEdges ───────────────────────────────────────────────────────
  const lineageEdges = useMemo(() => {
    if (!showLineageFlow && !isTracing) return []

    // 1. Aggregated Edges
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

    // 2. Expanded Detailed Edges
    const expandedDetailedEdges = Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges
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

    // 3. Trace / Regular Edges (only when tracing)
    let regularEdges: any[] = []
    if (isTracing) {
      regularEdges = edges.filter(edge => !isContainmentEdge(normalizeEdgeType(edge)))
    }

    return [...aggEdges, ...expandedDetailedEdges, ...regularEdges]
  }, [edges, showLineageFlow, isTracing, aggregatedEdges, isContainmentEdge])

  // ── ancestorMap (Phase 5.1 — incremental) ─────────────────────────────
  //
  // Full rebuild: when nodesByLayer reference changes (layer re-assignment,
  // initial data load). This is infrequent.
  //
  // Incremental patch: when only expandedNodes changes (user expands /
  // collapses a tree node). We diff the previous/current Set and only
  // traverse the affected subtrees — O(subtree) instead of O(N).
  const ancestorMap = useMemo(() => {
    const needsFullRebuild = prevNodesByLayerRef.current !== nodesByLayer

    if (needsFullRebuild) {
      const map = buildFullAncestorMap(nodesByLayer, expandedNodes, displayFlat)
      prevNodesByLayerRef.current = nodesByLayer
      prevExpandedNodesRef.current = expandedNodes
      ancestorMapRef.current = map
      return map
    }

    // Same nodesByLayer — check if expandedNodes changed
    const prev = prevExpandedNodesRef.current
    if (prev === expandedNodes) {
      return ancestorMapRef.current
    }

    // Diff
    const expanded: string[] = []
    const collapsed: string[] = []
    expandedNodes.forEach(id => { if (!prev.has(id)) expanded.push(id) })
    prev.forEach(id => { if (!expandedNodes.has(id)) collapsed.push(id) })

    if (expanded.length === 0 && collapsed.length === 0) {
      prevExpandedNodesRef.current = expandedNodes
      return ancestorMapRef.current
    }

    // Shallow copy then patch only changed subtrees
    const map = new Map(ancestorMapRef.current)

    // Collapses first: all descendants → collapsed node
    collapsed.forEach(id => {
      const node = findNodeById(nodesByLayer, id)
      if (node) {
        node.children.forEach(child => collapseSubtreeInMap(child, id, map))
      }
    })

    // Expansions: children become individually visible
    expanded.forEach(id => {
      const node = findNodeById(nodesByLayer, id)
      if (node) {
        expandNodeInMap(node, expandedNodes, map)
      }
    })

    prevExpandedNodesRef.current = expandedNodes
    ancestorMapRef.current = map
    return map
  }, [nodesByLayer, expandedNodes, displayFlat])

  // ── Edge projection ────────────────────────────────────────────────────
  //
  // Now depends on the stable `ancestorMap` instead of rebuilding it here.
  // This memo only re-runs when edges or the ancestorMap actually change.
  const visibleLineageEdges = useMemo(() => {
    if (!showLineageFlow && !isTracing) return []

    const edgeGroups = new Map<string, any[]>()

    const addEdgeToGroup = (sourceId: string, targetId: string, edge: any, type: string) => {
      const groupKey = `${sourceId}->${targetId}`
      if (!edgeGroups.has(groupKey)) edgeGroups.set(groupKey, [])
      edgeGroups.get(groupKey)!.push({ ...edge, source: sourceId, target: targetId, originalType: type })
    }

    // A. Aggregated Edges
    Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'collapsed')
      .forEach(e => {
        const agg = e.aggregated
        let sId = displayMap.has(agg.sourceUrn) ? agg.sourceUrn : ancestorMap.get(agg.sourceUrn)
        let tId = displayMap.has(agg.targetUrn) ? agg.targetUrn : ancestorMap.get(agg.targetUrn)
        if (!sId) sId = urnToIdMap.get(agg.sourceUrn)
        if (!tId) tId = urnToIdMap.get(agg.targetUrn)
        if (sId && tId && sId !== tId) {
          addEdgeToGroup(sId, tId, {
            id: agg.id,
            data: {
              edgeType: 'AGGREGATED',
              relationship: 'aggregated',
              isAggregated: true,
              edgeCount: agg.edgeCount,
              edgeTypes: agg.edgeTypes,
              confidence: agg.confidence,
              sourceEdgeIds: agg.sourceEdgeIds,
            }
          }, 'AGGREGATED')
        }
      })

    // B. Regular / Trace Edges
    edges
      .filter(edge => !isContainmentEdge(normalizeEdgeType(edge)))
      .forEach(edge => {
        const sId = ancestorMap.get(edge.source) || (displayMap.has(edge.source) ? edge.source : null)
        const tId = ancestorMap.get(edge.target) || (displayMap.has(edge.target) ? edge.target : null)
        if (sId && tId && sId !== tId) {
          if (isTracing && (!traceContextSet.has(sId) || !traceContextSet.has(tId))) return
          addEdgeToGroup(sId, tId, { ...edge, data: edge.data || {} }, normalizeEdgeType(edge))
        }
      })

    // C. Expanded Detailed Edges
    Array.from(aggregatedEdges.values())
      .filter(e => e.state === 'expanded')
      .flatMap(e => e.detailedEdges)
      .forEach(edge => {
        const sId = ancestorMap.get(edge.sourceUrn)
        const tId = ancestorMap.get(edge.targetUrn)
        if (sId && tId && sId !== tId) {
          addEdgeToGroup(sId, tId, {
            id: edge.id,
            data: { edgeType: edge.edgeType, relationship: edge.edgeType, confidence: edge.confidence }
          }, edge.edgeType)
        }
      })

    // Finalize: bundle groups into projected edges
    const projected: any[] = []
    edgeGroups.forEach((groupEdges, key) => {
      const distinctTypes = new Set<string>()
      let isGhost = false
      let isAggregated = false
      let maxConfidence = 0

      const sourceId = groupEdges[0].source
      const targetId = groupEdges[0].target

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
        isAggregated,
        data: { edgeTypes: typesArray, confidence: maxConfidence, edgeCount }
      })
    })

    return projected
  }, [ancestorMap, lineageEdges, edges, aggregatedEdges, displayMap, urnToIdMap, showLineageFlow, isTracing, traceContextSet, isContainmentEdge])

  return { lineageEdges, visibleLineageEdges }
}
