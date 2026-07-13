/**
 * ensureDraftOpen — guarantee an editable draft is active before authoring, so
 * edits flow into the versioning system rather than landing on main.
 *
 * Call at authoring INITIATION (the header's Edit entry, opening the create
 * panel, arming a connection), BEFORE any optimistic canvas mutation:
 * switching branches reloads the canvas, so opening a draft after staging
 * would discard the in-progress edit.
 *
 * No-op when already in a draft. Opens-or-resumes atomically via
 * `POST /resolve` (`resolveAndOpenDraft`), passing the ACTIVE VIEW's id so the
 * draft — and every commit made on it — is attributed to the view it was
 * opened from (branch-level attribution: a draft belongs to one view). The
 * server also claim-fills attribution onto a resumed draft that predates view
 * tracking. Returns the branch id, or null when no draft can be opened (the
 * graph context isn't resolved yet, or the caller lacks `:manage`) — callers
 * treat null as "cannot edit"; Published is read-only.
 */
import { useBranchStore } from '@/store/branchStore'
import { useSchemaStore } from '@/store/schema'
import { featureEnabled } from '@/store/features'
import { resolveAndOpenDraft } from '@/services/versioningApiService'
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
  // Admin flag backstop for EVERY authoring entry point: when versioning is
  // off there are no drafts, so all editing is off ("null = cannot edit").
  if (!featureEnabled('versioningEnabled')) return null
  const s = useBranchStore.getState()
  if (s.isDraftMode()) return s.currentBranchId
  const { workspaceId, dataSourceId, graphId } = s
  if (!workspaceId || !dataSourceId || !graphId) return null
  // The read side (Changes & Reviews, per-view PRs) filters by the ACTIVE view's
  // id — resolve it from the same source so write-time attribution matches.
  const activeViewId = useSchemaStore.getState().getActiveView()?.id ?? s.originatingViewId ?? null
  try {
    const r = await resolveAndOpenDraft(workspaceId, {
      dataSourceId,
      originatingViewId: activeViewId ?? undefined,
    })
    if (!r.myDraft?.branchId) return null
    useBranchStore
      .getState()
      .switchToDraft(r.myDraft.branchId, r.myDraft.originatingViewId ?? activeViewId)
    invalidateVersioningCaches()
    return r.myDraft.branchId
  } catch {
    // Missing :manage or a transient failure — no draft, so no editing.
    return null
  }
}
