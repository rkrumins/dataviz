/**
 * useEntityEditing — whether the active view's entities can be edited, and if
 * not, why not.
 *
 * An edit to an entity is kept only as a change in a draft: Review & Save
 * commits it to the draft, and publishing merges it. A data source without
 * version control has no draft to keep it in (an external graph is read-only
 * here), and a view with no draft open has none yet. A surface offering an
 * edit disables it with the reason rather than take a change it would drop.
 */
import { useFeature } from '@/store/features'
import { useActiveView } from '@/store/schema'
import { useEffectiveBranchId } from '@/store/branchStore'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'

import { useProjectionWatermark, useResolveGraph } from './useVersioning'

export const NO_VERSION_CONTROL = "Version control isn't set up for this data source yet"
export const NO_DRAFT = 'Switch to a draft to make changes'

export interface EntityEditing {
  /** False where editing isn't offered at all: an admin has turned version
   *  control or edit mode off, or the view is read-only for this person. */
  offered: boolean
  /** Why an offered edit can't be made yet, or null when it can. */
  blocked: string | null
}

/** The open draft the active view's edits go into — its ids — or null outside one. */
export function useEditDraft(): { wsId: string; graphId: string; branchId: string } | null {
  const view = useActiveView()
  const wsId = view?.workspaceId ?? ''
  const dataSourceId = view?.dataSourceId ?? null
  const branchId = useEffectiveBranchId(wsId, dataSourceId, view?.id ?? null)
  const graphId = useResolveGraph(wsId || undefined, dataSourceId, view?.id ?? null).data?.graphId
  return wsId && graphId && branchId ? { wsId, graphId, branchId } : null
}

/** Whether the active view's published graph is catching up with main — its search can't run
 *  meanwhile — asked again until it has; `recheck` asks now (a search was just refused). Not
 *  catching up where the view has no versioned graph. */
export function usePublishedGraphCatchingUp(): { catchingUp: boolean; recheck: () => void } {
  const view = useActiveView()
  const graphId = useResolveGraph(view?.workspaceId, view?.dataSourceId ?? null, view?.id ?? null).data?.graphId
  const watermark = useProjectionWatermark(view?.workspaceId, graphId, { untilFresh: true })
  return {
    catchingUp: watermark.data?.fresh === false,
    recheck: () => { if (graphId) void watermark.refetch() },
  }
}

export function useEntityEditing(): EntityEditing {
  const versioningEnabled = useFeature('versioningEnabled')
  const editModeEnabled = useFeature('editModeEnabled')
  const readOnly = useViewExecutionContext()?.readOnly ?? false
  const view = useActiveView()
  const dataSourceId = view?.dataSourceId ?? null
  const inDraft = !!useEffectiveBranchId(view?.workspaceId ?? '', dataSourceId, view?.id ?? null)
  const resolve = useResolveGraph(view?.workspaceId, dataSourceId, view?.id ?? null)

  const offered = versioningEnabled && editModeEnabled && !readOnly
  if (inDraft) return { offered, blocked: null }
  // No versioned graph (the lookup 404s — and says so while it is tried again on a new mount), or
  // one still being set up.
  const unversioned = resolve.isError || !!resolve.failureReason || !!resolve.data?.bootstrap
  return { offered, blocked: unversioned ? NO_VERSION_CONTROL : NO_DRAFT }
}
