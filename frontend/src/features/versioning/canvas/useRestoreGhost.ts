/**
 * useRestoreGhost — turns a ghost (committed deletion) back into a pending re-creation. Returns a
 * `restore(urn)` that stages a `create_entity` carrying the entity's ORIGINAL urn (so Save creates
 * over the tombstone — resurrect, not a fresh mint) and re-nests it under its LIVE parent, then flips
 * the ghost node live so the staged-create decoration marks it (and it isn't re-ghosted). The links
 * deleted with it come back too, each under its original id, where their other end is there. Save
 * then cleanly undoes the deletion (diff-vs-main returns to no-change for it).
 */
import { useCallback } from 'react'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useContainmentEdgeTypes } from '@/store/schema'
import { buildRestoreLinks, buildRestoreSubtree, isGhostNode } from './deletionGhosts'

export function useRestoreGhost(): (urn: string) => void {
  const stage = useStagedChangesStore((s) => s.stage)
  const changeSet = useBranchStore((s) => s.activeChangeSet)
  const containmentTypes = useContainmentEdgeTypes()

  return useCallback(
    (urn: string) => {
      const state = useCanvasStore.getState()
      const liveUrns = new Set(state.nodes.filter((n) => !isGhostNode(n)).map((n) => n.id))
      const up = new Set(containmentTypes.map((t) => t.toUpperCase()))
      const isContainment = (et: string) => up.has(et.toUpperCase())
      // Restore the whole deleted subtree (the entity + its cascade-deleted descendants), parent-first.
      const restores = buildRestoreSubtree(urn, changeSet, liveUrns, isContainment)
      if (!restores.length) return
      // And the links deleted with them, where the other end is there. In a draft, an end the draft
      // did not delete is live: the link existed when the draft began.
      const removed = new Set(changeSet?.changes.filter((c) => c.kind === 'node' && c.status === 'removed')
        .map((c) => c.urn ?? c.entityId))
      const links = buildRestoreLinks(restores, changeSet?.changes ?? [], (u) => !removed.has(u), isContainment)
      restores.forEach((r) => stage(r))
      links.forEach((l) => stage(l))
      // Flip each ghost live so the staged-create decoration marks it (and it isn't re-ghosted) —
      // the entities, their parent links and the links coming back with them.
      restores.forEach((r) => state.updateNode(r.targetUrn, { isGhost: undefined }))
      const back = new Set([
        ...links.map((l) => l.targetId),
        ...restores.map((r) => r.after.containmentEdgeId).filter((id): id is string => typeof id === 'string'),
      ])
      const ghosts = state.edges.filter((e) => back.has(e.id))
      if (ghosts.length) {
        state.removeEdges(ghosts.map((e) => e.id))
        state.addEdges(ghosts.map((e) => ({ ...e, data: { ...e.data, isGhost: undefined, isPending: 'create' } })) as never)
      }
    },
    [stage, changeSet, containmentTypes],
  )
}
