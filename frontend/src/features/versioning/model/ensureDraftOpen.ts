/**
 * ensureDraftOpen — guarantee an editable draft is active before authoring, so
 * edits flow into the versioning system rather than landing on main.
 *
 * Call at authoring INITIATION (opening the create panel, arming a connection),
 * BEFORE any optimistic canvas mutation: switching branches reloads the canvas,
 * so opening a draft after staging would discard the in-progress edit.
 *
 * No-op when already in a draft. Best-effort: returns the branch id, or null if
 * the graph context isn't resolved yet or the caller lacks `:manage` (in which
 * case authoring still works against main via the legacy save path).
 */
import { useBranchStore } from '@/store/branchStore'
import { openDraft } from '@/services/versioningApiService'

export async function ensureDraftOpen(): Promise<string | null> {
  const s = useBranchStore.getState()
  if (s.isDraftMode()) return s.currentBranchId
  const { workspaceId, dataSourceId, graphId, originatingViewId } = s
  if (!workspaceId || !dataSourceId || !graphId) return null
  try {
    const { branchId } = await openDraft(workspaceId, graphId, {
      originatingViewId: originatingViewId ?? undefined,
    })
    useBranchStore.getState().switchToDraft(branchId, originatingViewId)
    return branchId
  } catch {
    // Missing :manage or a transient failure — fall back to main-mode authoring.
    return null
  }
}
