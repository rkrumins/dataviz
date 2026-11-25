/**
 * useRestoreGhost — brings back what the open draft deleted and saved (a ghost on the canvas: an
 * entity or a relationship). Returns a `restore(id)` taking the canvas's name for it — an entity's
 * urn, a relationship's id — that puts it back through the draft's own restore of its changes, as
 * discarding the deletion from Review's saved changes does: one new revision of the draft, and what
 * the deletion took with it comes back too (an entity's links and relationships, with their
 * properties; a deleted subtree whole), each as it was, under its own id. The canvas then reads the
 * draft again, so what came back is drawn live and its ghosts go.
 */
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAppNotifications } from '@/components/ui/notifications'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'
import { releaseProviderCaches } from '@/providers/providerPool'
import { useBranchStore } from '@/store/branchStore'
import { useRestoreDraftChanges, VERSIONING_KEYS } from '../hooks/useVersioning'

export function useRestoreGhost(): (id: string) => Promise<void> {
  const wsId = useBranchStore((s) => s.workspaceId)
  const graphId = useBranchStore((s) => s.graphId)
  const branchId = useBranchStore((s) => s.currentBranchId)
  const { mutateAsync: restore } = useRestoreDraftChanges(wsId ?? '', graphId ?? '', branchId ?? '')
  const queryClient = useQueryClient()
  const { notify } = useAppNotifications()

  return useCallback(async (id: string) => {
    const branch = useBranchStore.getState()
    if (!wsId || !graphId || !branchId || !branch.isDraftMode()) return
    // The draft's changes name an entity by its entity id — an import's is not its urn.
    const change = branch.activeChangeSet?.byEntityId.get(id)
    try {
      const out = await restore({ entityIds: [change?.entityId ?? id] })
      if (!out.restored) return
      void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
      invalidateAggregatedEdges()
      releaseProviderCaches()
      useBranchStore.getState().bumpDraftEpoch()
      const label = change?.label ?? 'it'
      const more = out.restored - 1
      notify('success', more > 0
        ? `Restored ${label}, with ${more.toLocaleString()} more change${more === 1 ? '' : 's'} that went with it.`
        : `Restored ${label}.`)
    } catch (e) {
      notify('error', (e as Error).message)
    }
  }, [wsId, graphId, branchId, restore, queryClient, notify])
}
