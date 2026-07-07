/**
 * useRestoreGhost — turns a ghost (committed deletion) back into a pending re-creation. Returns a
 * `restore(urn)` that stages a `create_entity` carrying the entity's ORIGINAL urn (so Save creates
 * over the tombstone — resurrect, not a fresh mint) and re-nests it under its LIVE parent, then flips
 * the ghost node live so the staged-create decoration marks it (and it isn't re-ghosted). Save then
 * cleanly undoes the deletion (diff-vs-main returns to no-change for it).
 */
import { useCallback } from 'react'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useContainmentEdgeTypes } from '@/store/schema'
import { buildRestoreSubtree, isGhostNode } from './deletionGhosts'

export function useRestoreGhost(): (urn: string) => void {
  const stage = useStagedChangesStore((s) => s.stage)
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  const containmentTypes = useContainmentEdgeTypes()

  return useCallback(
    (urn: string) => {
      const state = useCanvasStore.getState()
      const liveUrns = new Set(state.nodes.filter((n) => !isGhostNode(n)).map((n) => n.id))
      const up = new Set(containmentTypes.map((t) => t.toUpperCase()))
      // Restore the whole deleted subtree (the entity + its cascade-deleted descendants), parent-first.
      const restores = buildRestoreSubtree(urn, changeSet, liveUrns, (et) => up.has(et.toUpperCase()))
      if (!restores.length) return
      restores.forEach((r) => stage(r))
      // Flip each ghost live so the staged-create decoration marks it (and it isn't re-ghosted).
      restores.forEach((r) => state.updateNode(r.targetUrn, { isGhost: undefined }))
    },
    [stage, changeSet, containmentTypes],
  )
}
