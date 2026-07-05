/**
 * useDeletionGhosts — keeps the canvas's committed-deletion ghost nodes AND edges in sync with the
 * draft-vs-main diff. Mount once in the Context View canvas. See `deletionGhosts.ts` for the why.
 *
 * Runs only once hydration is `complete`, so the overlay lands ON TOP of the freshly re-hydrated live
 * state (a re-hydrate replaces the node/edge set; adding ghosts before it would just be wiped). Reads
 * the live sets via `getState()` (not a subscription) so it never loops on its own mutations.
 */
import { useEffect, useMemo } from 'react'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useContainmentEdgeTypes } from '@/store/schema'
import { reconcileGhosts, isGhostNode, isGhostEdge } from './deletionGhosts'

export function useDeletionGhosts(enabled: boolean) {
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  const committedHidden = useBranchStore((s) => s.committedDiffHidden)
  const hydrationPhase = useCanvasStore((s) => s.hydrationPhase)
  const containmentTypes = useContainmentEdgeTypes()

  // Ontology-driven: which edge types nest (drives whether a ghost edge is 'containment'). No literals.
  const isContainmentEdgeType = useMemo(() => {
    const up = new Set(containmentTypes.map((t) => t.toUpperCase()))
    return (edgeType: string) => up.has(edgeType.toUpperCase())
  }, [containmentTypes])

  useEffect(() => {
    // Overlay only after hydration settles, so ghosts aren't clobbered by the live-state load.
    if (hydrationPhase !== 'complete') return
    const state = useCanvasStore.getState()
    const { nodesToAdd, nodesToRemove, edgesToAdd, edgesToRemove } = enabled
      ? reconcileGhosts(changeSet, state.nodes, state.edges, committedHidden, isContainmentEdgeType)
      : {
          nodesToAdd: [],
          edgesToAdd: [],
          nodesToRemove: state.nodes.filter(isGhostNode).map((n) => n.id),
          edgesToRemove: state.edges.filter(isGhostEdge).map((e) => e.id),
        }
    // removeNodes cascades edges touching them (incl. ghost edges); then clean up any remaining stale
    // ghost edges; then add nodes before edges so every ghost edge's endpoints already exist.
    if (nodesToRemove.length) state.removeNodes(nodesToRemove)
    if (edgesToRemove.length) state.removeEdges(edgesToRemove)
    if (nodesToAdd.length) state.addNodes(nodesToAdd as never)
    if (edgesToAdd.length) state.addEdges(edgesToAdd as never)
  }, [enabled, changeSet, committedHidden, hydrationPhase, isContainmentEdgeType])
}
