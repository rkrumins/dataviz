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

import { useResolveGraph } from './useVersioning'

export const NO_VERSION_CONTROL = "Version control isn't set up for this data source yet"
export const NO_DRAFT = 'Switch to a draft to make changes'

export interface EntityEditing {
  /** False where editing isn't offered at all: an admin has turned version
   *  control or edit mode off, or the view is read-only for this person. */
  offered: boolean
  /** Why an offered edit can't be made yet, or null when it can. */
  blocked: string | null
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
  // No versioned graph (the lookup 404s), or one still being set up.
  const unversioned = resolve.isError || !!resolve.data?.bootstrap
  return { offered, blocked: unversioned ? NO_VERSION_CONTROL : NO_DRAFT }
}
