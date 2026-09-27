/**
 * An entity's place in the containment hierarchy, from the live canvas graph.
 *
 * Split in two by cost. `useContainmentParent` — its parent, how it relates to it, how many
 * children are loaded — is a few lookups in the shared store indexes and re-renders only when
 * those answers change. `useMoveTargets` — every loaded entity that could contain it — walks the
 * graph, so it runs only while the "move to" picker is open, never to show the drawer.
 */
import { useMemo } from 'react'
import { useCanvasStore, type LineageEdge, type LineageNode } from '@/store/canvas'
import {
  useContainmentEdgeTypes,
  useEntityTypeHierarchyMap,
  useEntityTypes,
  useRelationshipTypes,
  useRootEntityTypes,
  normalizeEdgeType,
} from '@/store/schema'
import { allowedChildTypeIds, deriveContainmentEdges, setHasId } from '@/services/ontologyPreflightService'
import { childrenOf, containmentIndexOf, nodeIndexOf } from '@/lib/storeIndex'

export function useContainmentParent(nodeId: string) {
  const containmentTypes = useContainmentEdgeTypes()
  const relationshipTypes = useRelationshipTypes()
  const node = useCanvasStore((s) => nodeIndexOf(s.nodes).get(nodeId))
  const parentEdge = useCanvasStore((s) => containmentIndexOf(s.edges, containmentTypes).parentEdgeOf.get(nodeId))
  const parentNode = useCanvasStore((s) => (parentEdge ? nodeIndexOf(s.nodes).get(parentEdge.source) : undefined))
  const childCountLoaded = useCanvasStore((s) => childrenOf(containmentIndexOf(s.edges, containmentTypes), nodeId).length)

  const childType = (node?.data.type as string) ?? ''
  const parentType = (parentNode?.data.type as string) ?? ''
  const currentEdgeType = parentEdge ? normalizeEdgeType(parentEdge) : ''
  const parentName = (parentNode?.data.label as string) || parentEdge?.source

  // Relationship types the ontology allows for the CURRENT parent → child pair.
  const relTypeOptions = useMemo(
    () => (parentNode
      ? deriveContainmentEdges(parentType, childType, relationshipTypes, containmentTypes).filter((o) => o.allowed)
      : []),
    [parentNode, parentType, childType, relationshipTypes, containmentTypes],
  )
  return { node, parentNode, parentName, currentEdgeType, relTypeOptions, childCountLoaded }
}

export interface MoveTarget {
  id: string
  label: string
  type: string
}

const NO_NODES: readonly LineageNode[] = []
const NO_EDGES: readonly LineageEdge[] = []

/** Loaded entities `nodeId` could move under — not itself, its subtree or its current parent.
 *  Computed only while `enabled` (the picker is open). */
export function useMoveTargets(nodeId: string, enabled: boolean): MoveTarget[] {
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const containmentTypes = useContainmentEdgeTypes()
  const nodes = useCanvasStore((s) => (enabled ? s.nodes : NO_NODES))
  const edges = useCanvasStore((s) => (enabled ? s.edges : NO_EDGES))

  return useMemo(() => {
    if (!enabled) return []
    const index = containmentIndexOf(edges, containmentTypes)
    const node = nodeIndexOf(nodes).get(nodeId)
    if (!node) return []
    const childType = node.data.type as string
    const parentId = index.parentEdgeOf.get(nodeId)?.source
    const subtree = new Set<string>([nodeId])
    const stack = [nodeId]
    while (stack.length) {
      for (const c of childrenOf(index, stack.pop()!)) {
        if (!subtree.has(c)) { subtree.add(c); stack.push(c) }
      }
    }
    // One allowed-children answer per candidate TYPE, not per node.
    const canContain = new Map<string, boolean>()
    const out: MoveTarget[] = []
    for (const n of nodes) {
      if (subtree.has(n.id) || n.id === parentId || n.id.startsWith('logical:')) continue
      const type = n.data.type as string
      let ok = canContain.get(type)
      if (ok === undefined) {
        ok = setHasId(allowedChildTypeIds(type, entityTypes, rootEntityTypes, hierarchyMap), childType)
        canContain.set(type, ok)
      }
      if (ok) out.push({ id: n.id, label: (n.data.label as string) || n.id, type })
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  }, [enabled, nodes, edges, nodeId, containmentTypes, entityTypes, rootEntityTypes, hierarchyMap])
}
