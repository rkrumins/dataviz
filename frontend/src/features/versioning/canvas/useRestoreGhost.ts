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
import { useAppNotifications } from '@/components/ui/notifications'
import { queryClient } from '@/lib/queryClient'
import { getChangeEntriesBatch } from '@/services/versioningApiService'
import { BUSY_RETRY, VERSIONING_KEYS } from '../hooks/useVersioning'
import { buildChangeSet, type ChangeSet } from '../model/changeModel'
import { buildRestoreLinks, buildRestoreSubtree, indexRemovals, isGhostNode, restoreNeeds } from './deletionGhosts'
import { listOriginOf } from './useDeletionGhosts'

/** The most a Restore brings back on a draft too large for its whole diff, whose change list has no
 *  payloads: everything it needs is fetched first, 500 a request. Past these it says so. */
export const RESTORE_NODES_MAX = 1000
export const RESTORE_LINKS_MAX = 2000
const BATCH = 500

/** The change set with what a Restore of `urn` needs filled in, where a compact list left it out;
 *  the same set where nothing is missing; null when it is too much to restore here. */
async function withRestorePayloads(
  changeSet: ChangeSet, urn: string, isContainment: (et: string) => boolean,
  wsId: string | null, graphId: string | null,
): Promise<ChangeSet | null> {
  if (!changeSet.changes.some((c) => c.kind === 'node' && c.status === 'removed' && !c.before)) return changeSet
  const origin = listOriginOf(changeSet)
  const needs = restoreNeeds(indexRemovals(changeSet.changes, isContainment), changeSet.changes, urn,
    isContainment, RESTORE_NODES_MAX, RESTORE_LINKS_MAX)
  if (!needs || !origin || !wsId || !graphId) return null
  const ids = [...needs.nodeIds, ...needs.linkIds]
  const befores = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    const page = await queryClient.fetchQuery({
      queryKey: [...VERSIONING_KEYS.changeList(wsId, graphId, origin), 'entriesBatch', [...chunk].sort().join(',')],
      queryFn: () => getChangeEntriesBatch(wsId, graphId, origin, chunk),
      staleTime: Infinity,
      ...BUSY_RETRY,
    })
    for (const e of page.entries) if (e.before) befores.set(e.entityId, e.before)
  }
  return buildChangeSet(changeSet.changes.map((c) => (befores.has(c.entityId) ? { ...c, before: befores.get(c.entityId) } : c)))
}

export function useRestoreGhost(): (urn: string) => void {
  const stage = useStagedChangesStore((s) => s.stage)
  const activeChangeSet = useBranchStore((s) => s.activeChangeSet)
  const wsId = useBranchStore((s) => s.workspaceId)
  const graphId = useBranchStore((s) => s.graphId)
  const containmentTypes = useContainmentEdgeTypes()
  const { notify } = useAppNotifications()

  return useCallback(
    async (urn: string) => {
      const up = new Set(containmentTypes.map((t) => t.toUpperCase()))
      const isContainment = (et: string) => up.has(et.toUpperCase())
      // On a draft too large for its whole diff, first fetch what the restore needs.
      let changeSet: ChangeSet | null = activeChangeSet
      if (changeSet) {
        try {
          changeSet = await withRestorePayloads(changeSet, urn, isContainment, wsId, graphId)
        } catch {
          notify('error', 'Couldn’t restore it just now. Try again in a moment.')
          return
        }
        if (!changeSet) {
          notify('warning', `Too much was deleted with it to restore from the canvas: over ${RESTORE_NODES_MAX.toLocaleString()} entities or ${RESTORE_LINKS_MAX.toLocaleString()} relationships.`)
          return
        }
      }
      const state = useCanvasStore.getState()
      const liveUrns = new Set(state.nodes.filter((n) => !isGhostNode(n)).map((n) => n.id))
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
    [stage, activeChangeSet, containmentTypes, wsId, graphId, notify],
  )
}
