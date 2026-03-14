/**
 * useLayerAssignment - Extracted from ReferenceModelCanvas.tsx
 *
 * Encapsulates:
 * - layerRules: build layer assignment rules from sorted layers
 * - nodesByLayer: core layer assignment algorithm with deep inheritance
 * - displayFlat / displayMap: flattened node list and lookup map
 * - urnToIdMap: O(1) URN-to-ID lookup
 */

import { useMemo } from 'react'
import type { ViewLayerConfig } from '@/types/schema'
import {
  type GraphNode,
  resolveLayerAssignment,
  type LayerAssignmentRule,
  type EntityType,
} from '@/providers/GraphDataProvider'
import type { HierarchyNode } from '../components/canvas/context-view/types'

// ============================================
// Types
// ============================================

export interface UseLayerAssignmentOptions {
  nodes: any[]
  edges?: any[]
  sortedLayers: ViewLayerConfig[]
  nodeEdgeFingerprint: string
  containmentEdgeTypes?: Set<string>
  instanceAssignments: Map<string, { layerId: string }>
  effectiveAssignments: Map<string, { layerId: string }>
  nodeMap: Map<string, any>
  childMap: Map<string, string[]>
  parentMap: Map<string, string>
  expandedNodes?: Set<string>
}

export interface UseLayerAssignmentResult {
  layerRules: LayerAssignmentRule[]
  nodesByLayer: Map<string, HierarchyNode[]>
  displayFlat: HierarchyNode[]
  displayMap: Map<string, HierarchyNode>
  urnToIdMap: Map<string, string>
}

// ============================================
// Hook
// ============================================

export function useLayerAssignment({
  nodes,
  sortedLayers,
  nodeEdgeFingerprint,
  instanceAssignments,
  effectiveAssignments,
  nodeMap,
  childMap,
  parentMap,
}: UseLayerAssignmentOptions): UseLayerAssignmentResult {

  // Build layer assignment rules
  const layerRules = useMemo<LayerAssignmentRule[]>(() => {
    const generatedRules: LayerAssignmentRule[] = []

    sortedLayers.forEach(layer => {
      // 1. Explicit rules from config
      if (layer.rules) {
        layer.rules.forEach(rule => {
          generatedRules.push({
            id: rule.id,
            layerId: layer.id,
            entityTypes: (rule.entityTypes ?? []) as EntityType[],
            tags: rule.tags,
            urnPattern: rule.urnPattern,
            propertyMatch: rule.propertyMatch,
            priority: rule.priority
          })
        })
      }

      // 2. Default entity type rules - REMOVED to prevent implicit auto-assignment
      // If users want type-based assignment, they should add an explicit rule.
      /*
      layer.entityTypes.forEach((entityType, idx) => {
        generatedRules.push({
          id: `${layer.id}-${entityType}`,
          layerId: layer.id,
          entityTypes: [entityType as any],
          priority: layer.order * 10 + idx,
        })
      })
      */
    })

    return generatedRules
  }, [sortedLayers])

  // Core Logic: Group nodes by layer with Deep Inheritance support
  const nodesByLayer = useMemo(() => {
    const grouped = new Map<string, HierarchyNode[]>()

    // Initialize layers
    sortedLayers.forEach(l => grouped.set(l.id, []))

    // 1. Build explicit assignments from view layers (lowest priority, used as fallback)
    // These come from saved entityAssignments in the view configuration
    const explicitAssignments = new Map<string, string>() // nodeId -> layerId
    sortedLayers.forEach(l => {
      l.entityAssignments?.forEach(a => {
        explicitAssignments.set(a.entityId, l.id)
      })
    })

    // 2. Build rule-based assignments (fallback if no explicit assignment)
    const ruleAssignments = new Map<string, string>() // nodeId -> layerId
    nodes.forEach(node => {
      // Skip if already has explicit assignment from view
      if (explicitAssignments.has(node.id)) return

      // Rule match
      const graphNode: GraphNode = {
        urn: node.data.urn || node.id,
        entityType: (node.data.type as EntityType) || 'dataset', // Generic fallback
        displayName: node.data.label || node.data.businessLabel || node.id,
        properties: node.data as Record<string, unknown>,
        tags: node.data.classifications || []
      }

      const ruleLayerId = resolveLayerAssignment(graphNode, layerRules)
      if (ruleLayerId) {
        ruleAssignments.set(node.id, ruleLayerId)
      }
    })

    // 2. Determine "Effective Layer" for every node, considering inheritance
    // We traverse top-down. If a node has explicit, it wins. If not, it inherits.
    const effectiveLayer = new Map<string, string>() // nodeId -> layerId

    // We can't just iterate nodes orderless. We need top-down.
    // Use a Set to track processed.
    const processed = new Set<string>()

    const calculateEffectiveLayer = (nodeId: string, inheritedLayerId?: string) => {
      // Allow revisiting if we are providing a layer assignment where there was none?
      // For simple containment tree, we visit once.
      if (processed.has(nodeId)) return
      processed.add(nodeId)

      // Priority order (highest to lowest):
      // 1. effectiveAssignments (from backend computation - source of truth)
      // 2. instanceAssignments (from store - user drag-and-drop)
      // 3. explicitAssignments (from view layers - saved assignments)
      // 4. ruleAssignments (from rules - pattern/tag/type matching)
      // 5. inheritance (from parent)

      let myLayerId: string | undefined

      // 1. Backend-computed effective assignment (highest priority)
      const backendAssignment = effectiveAssignments.get(nodeId)
      if (backendAssignment?.layerId) {
        myLayerId = backendAssignment.layerId
      }

      // 2. Instance assignment from store (user manual assignment)
      if (!myLayerId) {
        const instanceAssignment = instanceAssignments.get(nodeId)
        if (instanceAssignment) {
          myLayerId = instanceAssignment.layerId
        }
      }

      // 3. Explicit assignment from view layers (saved in view config)
      if (!myLayerId) {
        myLayerId = explicitAssignments.get(nodeId)
      }

      // 4. Rule-based assignment
      if (!myLayerId) {
        myLayerId = ruleAssignments.get(nodeId)
      }

      // 5. Inheritance from parent
      if (!myLayerId && inheritedLayerId) {
        myLayerId = inheritedLayerId
      }

      if (myLayerId === '__UNASSIGNED__') {
        myLayerId = undefined
      }

      if (myLayerId) {
        effectiveLayer.set(nodeId, myLayerId)
      }

      const children = childMap.get(nodeId) || []
      children.forEach(childId => calculateEffectiveLayer(childId, myLayerId))
    }

    // Find true roots (nodes with no parents) and start there
    const roots = nodes.filter((n: any) => !parentMap.has(n.id))
    roots.forEach((r: any) => calculateEffectiveLayer(r.id))

    // Also handle orphans (cycles or disconnected) if any missed?
    // The recursive step above should cover all reachable from roots.
    // If there are unparented nodes that are not in `roots` (impossible by definition), they are covered.

    // 3. Construct Hierarchy Trees per Layer
    // A node is a "Visual Root" in Layer L if:
    // - It is effectively in Layer L
    // - AND (Its parent is NOT in Layer L OR it has no parent)

    // Helper to build hierarchy node
    const buildHierarchyNode = (nodeId: string, depth: number): HierarchyNode | null => {
      const node = nodeMap.get(nodeId)
      if (!node) return null

      const childrenIds = childMap.get(nodeId) || []
      // Filter children: Only include those that are effectively in the SAME layer
      const validChildren = childrenIds
        .filter(cid => effectiveLayer.get(cid) === effectiveLayer.get(nodeId))
        .map(cid => buildHierarchyNode(cid, depth + 1))
        .filter((n): n is HierarchyNode => n !== null)
        .sort((a, b) => a.name.localeCompare(b.name))

      return {
        id: node.id,
        typeId: node.data.type,
        name: node.data.label ?? node.data.businessLabel ?? node.id,
        data: node.data as Record<string, unknown>,
        children: validChildren,
        depth,
        urn: node.data.urn || node.id,
        entityTypeOption: (node.data.type as EntityType) || 'dataset',
        tags: node.data.classifications || []
      }
    }

    nodes.forEach((node: any) => {
      const layerId = effectiveLayer.get(node.id)
      if (!layerId) return // Unassigned

      // Check if this is a Visual Root for this layer
      const parentId = parentMap.get(node.id)
      const parentLayerId = parentId ? effectiveLayer.get(parentId) : undefined

      if (layerId !== parentLayerId) {
        // It's a root in this layer context!
        const hNode = buildHierarchyNode(node.id, 0)
        if (hNode) {
          const list = grouped.get(layerId)
          if (list) list.push(hNode)
        }
      }
    })

    // Sort all lists
    grouped.forEach(list => list.sort((a, b) => a.name.localeCompare(b.name)))

    return grouped
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeEdgeFingerprint, sortedLayers, layerRules, instanceAssignments, nodeMap, childMap, parentMap, effectiveAssignments])

  // Flatten logical/physical nodes for search and lookup
  const { displayFlat, displayMap } = useMemo(() => {
    const flat: HierarchyNode[] = []
    const map = new Map<string, HierarchyNode>()

    nodesByLayer.forEach((layerNodes) => {
      const traverse = (node: HierarchyNode) => {
        flat.push(node)
        map.set(node.id, node)
        node.children.forEach(traverse)
      }
      layerNodes.forEach(traverse)
    })

    return { displayFlat: flat, displayMap: map }
  }, [nodesByLayer])

  // O(1) URN->ID lookup (replaces O(N) displayFlat.find() per edge)
  const urnToIdMap = useMemo(() => {
    const map = new Map<string, string>()
    displayFlat.forEach(node => {
      if (node.urn) map.set(node.urn, node.id)
    })
    return map
  }, [displayFlat])

  return { layerRules, nodesByLayer, displayFlat, displayMap, urnToIdMap }
}
