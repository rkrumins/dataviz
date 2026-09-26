/**
 * The versioning scope a drawer's History reads from: the active view's graph,
 * its main line, and the open draft (if any). Shared by the entity and the
 * relationship drawer so their membership gating cannot drift apart.
 */
import { useActiveView } from '@/store/schema'
import { useResolveGraph } from '@/features/versioning/hooks/useVersioning'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { useEffectiveBranchId } from '@/store/branchStore'

export function useDrawerHistoryScope() {
  // Resolve the active view's data source to its graph (cached; the same resolve the canvas
  // versioning bar uses). Null when version control isn't enabled, in which case History hides.
  const activeView = useActiveView()
  const resolve = useResolveGraph(activeView?.workspaceId, activeView?.dataSourceId ?? null, activeView?.id ?? null)
  // Version history is a membership-gated surface and has no meaning for
  // a read-only shared viewer (no drafts, no commits they can act on) —
  // withholding the ids keeps every versioning query from firing.
  const readOnlyView = useViewExecutionContext()?.readOnly ?? false
  // The active draft (if any), so History also shows this branch's unmerged commits.
  // Scoped by the active view's id (branch-per-view) so this never shows another view's draft
  // commits on the same data source.
  const branchId = useEffectiveBranchId(activeView?.workspaceId ?? '', activeView?.dataSourceId ?? null, activeView?.id ?? null)
  return {
    wsId: readOnlyView ? undefined : activeView?.workspaceId,
    graphId: readOnlyView ? null : (resolve.data?.graphId ?? null),
    mainBranchId: resolve.data?.mainBranchId ?? null,
    branchId,
  }
}
