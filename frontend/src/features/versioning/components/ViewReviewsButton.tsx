/**
 * ViewReviewsButton — "Reviews" for one view, rendered in the PAGE HEADER.
 *
 * It used to be the right-hand half of CanvasVersioningBar, which in the idle
 * Published state carried nothing else but the branch switcher: an entire band
 * of chrome, above a toolbar that repeated the view's name, for two controls.
 * The switcher went down into the toolbar and this came up here, beside Details
 * and Activity — the other two "tell me about this view" actions — and the band
 * collapsed.
 *
 * The panel itself still belongs to CanvasVersioningBar (it owns graphId and the
 * branch scope), so this asks for it through the one-shot versioningPanelStore
 * bridge the Context View header's "Changes" button already used. Which tab it
 * opens matches what the bar's own button did: the change set while a draft is
 * open, the history otherwise.
 *
 * Renders NOTHING unless the panel would actually have something to show — the
 * feature off, no versioned graph, or a graph that exists but was never seeded
 * (a half-finished bootstrap, where the bar shows "Enable version control"
 * instead) all mean a dead button. The caller withholds it for a read-only
 * session, exactly as CanvasRouter withholds the bar.
 */
import { PanelRight } from 'lucide-react'
import { useEffectiveBranchId } from '@/store/branchStore'
import { useFeature } from '@/store/features'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { useResolveGraph } from '../hooks/useVersioning'

export function ViewReviewsButton({
  workspaceId,
  dataSourceId,
  viewId,
  className,
}: {
  workspaceId: string
  dataSourceId: string | null
  viewId: string
  className?: string
}) {
  const versioningEnabled = useFeature('versioningEnabled')
  // Same query key the bar and the canvas already use, so this shares their
  // lookup rather than adding one (5-minute staleTime, one entry per scope).
  const resolve = useResolveGraph(workspaceId, versioningEnabled ? dataSourceId : null, viewId)
  const openPanel = useVersioningPanelStore((s) => s.openPanel)
  const isDraft = !!useEffectiveBranchId(workspaceId, dataSourceId, viewId)

  const graphId = resolve.data?.graphId ?? null
  // Mirrors the bar's `needsSeed`: a blank (hand-built) model is genesis-only by
  // design, everything else needs a real first commit before there is history.
  const seeded =
    resolve.data?.kind === 'blank' || (resolve.data?.mainHeadCommitSeq ?? 0) > 1

  if (!versioningEnabled || !graphId || !seeded) return null

  return (
    <button
      type="button"
      onClick={() => openPanel(isDraft ? 'changes' : 'history')}
      className={className}
      aria-label="Reviews"
      title="Changes, pull requests & history for this view"
    >
      <PanelRight className="w-3.5 h-3.5" aria-hidden />
      <span className="hidden lg:inline">Reviews</span>
    </button>
  )
}
