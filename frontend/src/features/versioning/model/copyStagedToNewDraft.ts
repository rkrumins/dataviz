/**
 * copyStagedToNewDraft — carry unsaved edits off a draft that closed under them (published, being
 * published, or discarded) onto a fresh draft, where they can be saved.
 *
 * The edits travel as a staged-draft snapshot written under the new draft's scope key; switching
 * to that draft then restores them exactly as a refresh would (useStagedDraftPersistence lays the
 * pending nodes, the review op-log and the layer pins onto the hydrated canvas), and a reload
 * right after the copy keeps them too. Returns the new draft's id.
 */
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { openDraft } from '@/services/versioningApiService'
import { buildSnapshot } from '@/features/canvas-drafts/useStagedDraftPersistence'
import { clearSnapshot, readSnapshot, writeSnapshot } from '@/features/canvas-drafts/stagedDraftPersistence'
import { invalidateVersioningCaches } from './ensureDraftOpen'

export async function copyStagedToNewDraft(fromBranchId: string, viewId: string | null): Promise<string> {
  const { workspaceId, dataSourceId, graphId } = useBranchStore.getState()
  if (!workspaceId || !dataSourceId || !graphId) throw new Error('The graph isn’t loaded yet — try again.')
  // The staged store's scope key (CanvasRouter).
  const scopeKey = (branchId: string) => `${workspaceId}::${dataSourceId}::${branchId}`
  const fromKey = scopeKey(fromBranchId)
  // Still on the closed draft, the edits are live; once useActiveBranchGuard has moved the canvas
  // to Published they are only in the closed draft's own snapshot.
  const snapshot = useStagedChangesStore.getState()._scopeKey === fromKey
    ? buildSnapshot(fromKey, fromBranchId)
    : readSnapshot(fromKey)
  if (!snapshot) throw new Error('There are no unsaved changes to copy.')

  const { branchId } = await openDraft(workspaceId, graphId, { originatingViewId: viewId ?? undefined })
  writeSnapshot({ ...snapshot, scopeKey: scopeKey(branchId), branchId })
  clearSnapshot(fromKey)
  useBranchStore.getState().switchToDraft(branchId, viewId)
  invalidateVersioningCaches()
  return branchId
}
