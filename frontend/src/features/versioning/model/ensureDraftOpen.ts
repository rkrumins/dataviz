/**
 * ensureDraftOpen — guarantee an editable draft is active before authoring, so
 * edits flow into the versioning system rather than landing on main.
 *
 * Call at authoring INITIATION (the header's Edit entry, opening the create
 * panel, arming a connection), BEFORE any optimistic canvas mutation:
 * switching branches reloads the canvas, so opening a draft after staging
 * would discard the in-progress edit.
 *
 * No-op when already in a draft. Resumes the caller's existing draft when the
 * backend reports one (`resolveGraph().myDraft`) instead of opening a
 * duplicate. Returns the branch id, or null when no draft can be opened (the
 * graph context isn't resolved yet, or the caller lacks `:manage`) — callers
 * treat null as "cannot edit"; Published is read-only.
 */
import { useBranchStore } from '@/store/branchStore'
import { openDraft, resolveGraph } from '@/services/versioningApiService'
import { VERSIONING_KEYS } from '../hooks/useVersioning'

/** The branches/resolve caches must reflect a draft the moment it exists — the
 *  ?branch deep-link guard validates the URL param against the CACHED branches
 *  list, and a stale list makes it reject (and toast about) a draft this very
 *  function just opened or resumed. `@/main` is imported dynamically because a
 *  static import mounts the app at module load (breaks jsdom tests — same
 *  pattern as fetchWithTimeout). Fire-and-forget; never blocks the caller. */
function invalidateVersioningCaches(): void {
  void import('@/main')
    .then((m) => m.getQueryClient()?.invalidateQueries({ queryKey: VERSIONING_KEYS.all }))
    .catch(() => {})
}

export async function ensureDraftOpen(): Promise<string | null> {
  const s = useBranchStore.getState()
  if (s.isDraftMode()) return s.currentBranchId
  const { workspaceId, dataSourceId, graphId, originatingViewId } = s
  if (!workspaceId || !dataSourceId || !graphId) return null
  try {
    // Resume before creating — the caller may already have an open draft
    // (e.g. from a previous session); opening blindly would mint duplicates.
    const r = await resolveGraph(workspaceId, dataSourceId)
    if (r.myDraft?.branchId) {
      useBranchStore.getState().switchToDraft(r.myDraft.branchId, originatingViewId)
      invalidateVersioningCaches()
      return r.myDraft.branchId
    }
    const { branchId } = await openDraft(workspaceId, graphId, {
      originatingViewId: originatingViewId ?? undefined,
    })
    useBranchStore.getState().switchToDraft(branchId, originatingViewId)
    invalidateVersioningCaches()
    return branchId
  } catch {
    // Missing :manage or a transient failure — no draft, so no editing.
    return null
  }
}
