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
import { stagedScopeKey, useStagedChangesStore } from '@/store/stagedChangesStore'
import { useContainmentEdgeTypes } from '@/store/schema'
import { useAppNotifications } from '@/components/ui/notifications'
import { queryClient } from '@/lib/queryClient'
import { getChangeEntriesBatch, getDeletionCascade, type DeletionCascade } from '@/services/versioningApiService'
import { BUSY_RETRY, VERSIONING_KEYS } from '../hooks/useVersioning'
import { buildChangeSet, type ChangeOrigin, type ChangeSet, type GraphChange } from '../model/changeModel'
import { ensureDraftOpen } from '../model/ensureDraftOpen'
import type { TombstoneTarget } from '../components/TombstoneDetails'
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

/** Why a published deletion can't come back into the draft, as the draft's own check says. */
function refusal(c: DeletionCascade, name: string): string {
  switch (c.reason) {
    case 'draft_predates': return `Pull the latest from Published into your draft first: it still has ‘${name}’.`
    case 'recreated': return `Your draft has ‘${name}’, or something deleted with it, again: there is nothing to restore.`
    case 'parent_gone': return `Restore ‘${c.detail?.parentName || 'what held it'}’ first: your draft no longer has it.`
    case 'too_large': return `Too much went with ‘${name}’ to restore it here. Undo the change that deleted it in History instead.`
    default: return `‘${name}’ isn’t deleted there, so there is nothing to restore.`
  }
}

/**
 * useRestoreDeletion — brings a published deletion back into the person's draft: the entity, what
 * went with it and its links, each under its own id, staged parent-first and then reviewed. The
 * draft says first whether it can take it (`…/deletion/cascade?into=`): a draft that still has it,
 * has it again, or no longer has what held it is told why, and nothing is staged.
 */
export function useRestoreDeletion(): (target: TombstoneTarget, name: string) => Promise<boolean> {
  const containmentTypes = useContainmentEdgeTypes()
  const { notify } = useAppNotifications()

  return useCallback(async (target: TombstoneTarget, name: string) => {
    // A past revision is read-only: restoring goes back to the graph as it is now, in the draft.
    if (useBranchStore.getState().revision) useBranchStore.getState().closeRevision()
    const draftId = await ensureDraftOpen()
    if (!draftId) return false
    let cascade: DeletionCascade
    try {
      cascade = await queryClient.fetchQuery({
        queryKey: [...VERSIONING_KEYS.changeList(target.wsId, target.graphId, target.origin), 'cascade', target.entityId, 'into', draftId],
        queryFn: () => getDeletionCascade(target.wsId, target.graphId, target.entityId, target.origin, draftId),
        staleTime: 0,
        ...BUSY_RETRY,
      })
    } catch {
      notify('error', 'Couldn’t restore it just now. Try again in a moment.')
      return false
    }
    if (!cascade.restorable) {
      notify('warning', refusal(cascade, name))
      return false
    }

    const up = new Set(containmentTypes.map((t) => t.toUpperCase()))
    const isContainment = (et: string) => up.has(et.toUpperCase())
    const origin: ChangeOrigin = 'branchId' in target.origin
      ? { source: 'branch', branchId: target.origin.branchId }
      : { source: 'compare', fromSeq: target.origin.fromSeq, toSeq: target.origin.toSeq }
    const skipped = new Set(cascade.skippedLinks ?? [])
    const changes: GraphChange[] = cascade.removed.filter((e) => !skipped.has(e.entityId)).map((e) => ({
      entityId: e.entityId, urn: e.urn ?? undefined, kind: e.kind, status: 'removed', origin,
      label: (e.before?.displayName as string | undefined) ?? e.entityId,
      before: e.before ?? undefined, sourceUrn: e.sourceUrn ?? undefined, targetUrn: e.targetUrn ?? undefined,
    }))
    const live = new Set(cascade.live ?? [])
    const rootUrn = cascade.removed.find((e) => e.entityId === cascade.root)?.urn ?? cascade.root
    const restores = buildRestoreSubtree(rootUrn, buildChangeSet(changes), live, isContainment)
    if (!restores.length) {
      notify('error', 'Couldn’t restore it just now. Try again in a moment.')
      return false
    }
    const links = buildRestoreLinks(restores, changes, (u) => live.has(u), isContainment)

    // Into the draft's own staged slice: the canvas switches to it on its next render, after this.
    const { workspaceId, dataSourceId } = useBranchStore.getState()
    const staged = useStagedChangesStore.getState()
    staged.setScope(stagedScopeKey(workspaceId, dataSourceId, draftId))
    restores.forEach((r) => staged.stage(r))
    links.forEach((l) => staged.stage(l))
    staged.openReviewPanel()
    const more = restores.length - 1
    const withIt = [
      more > 0 && `${more.toLocaleString()} ${more === 1 ? 'entity' : 'entities'}`,
      links.length > 0 && `${links.length.toLocaleString()} ${links.length === 1 ? 'relationship' : 'relationships'}`,
    ].filter(Boolean).join(' and ')
    notify('success', `Restored ‘${name}’${withIt ? ` with the ${withIt} deleted with it` : ''} into your draft. Review and save to keep it.`)
    return true
  }, [containmentTypes, notify])
}
