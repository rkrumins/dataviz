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
import { clearPendingSave } from './saveStagedChangesToDraft'

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
  // Copy is offered only after the save was refused, so nothing was committed: the edits arrive as
  // unsaved ones, without the closed draft's save key.
  writeSnapshot({ ...snapshot, scopeKey: scopeKey(branchId), branchId, phase: 'staged', pendingSave: undefined })
  if (!readSnapshot(scopeKey(branchId))) {
    throw new Error('Couldn’t copy your unsaved changes — they are still on the closed draft.')
  }
  clearSnapshot(fromKey)
  clearPendingSave(fromKey)
  // The edits left the closed draft: none stay live or parked there to count against it, or to come
  // back if it is handed back open.
  const staged = useStagedChangesStore.getState()
  if (staged._scopeKey === fromKey) {
    useStagedChangesStore.setState({ changes: [], redoStack: [] })   // no discard hooks: the canvas moves on
  } else if (staged._byScope[fromKey]) {
    const byScope = { ...staged._byScope }
    delete byScope[fromKey]
    useStagedChangesStore.setState({ _byScope: byScope })
  }
  useBranchStore.getState().switchToDraft(branchId, viewId)
  invalidateVersioningCaches()
  return branchId
}
