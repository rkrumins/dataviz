/**
 * useTraceAncestorHydration — defensive client-side ancestor hydration for
 * trace results that arrive without containment edges.
 *
 * The /trace/v2 backend is expected to return the containment edges that
 * link returned trace nodes into the canvas hierarchy. If it doesn't (stale
 * backend, ontology gaps), trace nodes appear as orphans: layer assignment
 * drops them and the rendered canvas is empty.
 *
 * This hook synthesises the missing chain by calling provider.getAncestors()
 * for each orphan URN and emitting parent→child containment edges between
 * consecutive ancestors. The chosen edge type is supplied by the caller so
 * this hook stays free of view-schema dependencies.
 */

import { useCallback } from 'react'
import type { GraphDataProvider, GraphNode } from '@/providers/GraphDataProvider'

export interface HydratedAncestorEdge {
  id: string
  sourceUrn: string
  targetUrn: string
  edgeType: string
}

export interface HydrateAncestorsResult {
  nodes: GraphNode[]
  edges: HydratedAncestorEdge[]
}

export interface UseTraceAncestorHydrationResult {
  hydrate: (orphanUrns: string[], containmentEdgeType: string) => Promise<HydrateAncestorsResult>
}

export function useTraceAncestorHydration(
  provider: GraphDataProvider | null,
): UseTraceAncestorHydrationResult {
  const hydrate = useCallback(
    async (
      orphanUrns: string[],
      containmentEdgeType: string,
    ): Promise<HydrateAncestorsResult> => {
      if (!provider || orphanUrns.length === 0) {
        return { nodes: [], edges: [] }
      }

      const ancestorLists = await Promise.all(
        orphanUrns.map((urn) => provider.getAncestors(urn).catch(() => [] as GraphNode[])),
      )

      const nodeByUrn = new Map<string, GraphNode>()
      const edgeById = new Map<string, HydratedAncestorEdge>()

      orphanUrns.forEach((orphanUrn, idx) => {
        const ancestors = ancestorLists[idx]
        if (!ancestors || ancestors.length === 0) return

        ancestors.forEach((node) => {
          if (!nodeByUrn.has(node.urn)) nodeByUrn.set(node.urn, node)
        })

        // ancestors[0] is the immediate parent; subsequent entries climb to root.
        let childUrn = orphanUrn
        for (const ancestor of ancestors) {
          const id = `synth-anc-${ancestor.urn}-${childUrn}`
          if (!edgeById.has(id)) {
            edgeById.set(id, {
              id,
              sourceUrn: ancestor.urn,
              targetUrn: childUrn,
              edgeType: containmentEdgeType,
            })
          }
          childUrn = ancestor.urn
        }
      })

      return {
        nodes: Array.from(nodeByUrn.values()),
        edges: Array.from(edgeById.values()),
      }
    },
    [provider],
  )

  return { hydrate }
}
