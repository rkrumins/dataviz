/**
 * CanvasVersioningBar — the single top strip that carries all versioning chrome for
 * every canvas. Mounted once in CanvasRouter (above the canvas), so it never fights
 * the canvases' own floating toolbars. Renders nothing when the data source has no
 * versioned graph, so non-versioned views are untouched.
 *
 * On main: just the BranchSwitcher. On a draft: an amber strip with the switcher,
 * the committed change counts (+ unsaved-edit hint), and Review / Publish / Discard.
 */
import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, GitPullRequest, Trash2, Loader2, GitBranch, Sparkles, PanelRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { usePermission } from '@/store/auth'
import { useActiveView } from '@/store/schema'
import { useBranchStore, useEffectiveBranchId } from '@/store/branchStore'
import { useStagedChangeCount } from '@/store/stagedChangesStore'
import { useAbandonDraft, useBootstrapGraph, useBranches, useDiffVsMain, useResolveGraph } from '../hooks/useVersioning'
import { fromDiffVsMain } from '../model/changeAdapters'
import { EMPTY_CHANGE_SET } from '../model/changeModel'
import { BranchSwitcher } from './BranchSwitcher'
import { PullBeforeMergeBanner } from './PullBeforeMergeBanner'
import { RefreshingBadge } from './RefreshingBadge'
import { ChangeCountChips } from './ChangesPanel'
import { CommitDialog } from './CommitDialog'
import { ViewPrIndicator } from './ViewPrIndicator'
import { ViewVersioningPanel, type ViewPanelTab } from './ViewVersioningPanel'

interface CanvasVersioningBarProps {
  workspaceId: string
  dataSourceId: string | null
}

export function CanvasVersioningBar({ workspaceId, dataSourceId }: CanvasVersioningBarProps) {
  const { showToast } = useToast()
  const canManage = usePermission('workspace:datasource:manage', workspaceId)
  const resolve = useResolveGraph(workspaceId, dataSourceId)
  const graphId = resolve.data?.graphId ?? null
  const bootstrap = useBootstrapGraph(workspaceId)

  const branchId = useEffectiveBranchId(workspaceId, dataSourceId)
  const isDraft = !!branchId
  const committedDiffHidden = useBranchStore((s) => s.committedDiffHidden)
  const setCommittedDiffHidden = useBranchStore((s) => s.setCommittedDiffHidden)
  const setActiveChangeSet = useBranchStore((s) => s.setActiveChangeSet)
  const switchToMain = useBranchStore((s) => s.switchToMain)

  const [showPublish, setShowPublish] = useState(false)
  const [panelTab, setPanelTab] = useState<ViewPanelTab | null>(null)
  const activeView = useActiveView()
  const viewId = activeView?.id ?? null
  const viewName = activeView?.name ?? null
  const uncommitted = useStagedChangeCount()

  const diffQ = useDiffVsMain(workspaceId, graphId, isDraft ? branchId : null)
  const changeSet = useMemo(
    () => (diffQ.data && branchId ? fromDiffVsMain(diffQ.data, branchId) : EMPTY_CHANGE_SET),
    [diffQ.data, branchId],
  )
  useEffect(() => {
    if (isDraft) setActiveChangeSet(changeSet)
  }, [isDraft, changeSet, setActiveChangeSet])

  const abandon = useAbandonDraft(workspaceId, graphId ?? '')

  // Is the active draft behind main? Drives the toolbar "Pull latest" — derived locally (like the switcher).
  const branchesQ = useBranches(workspaceId, graphId)
  const mainHead = resolve.data?.mainHeadCommitSeq ?? 0
  const activeBranch = (branchesQ.data ?? []).find((b) => b.branchId === branchId)
  const behindMain = isDraft && !!activeBranch && (activeBranch.baseCommitSeq ?? 0) < mainHead

  const handleEnable = () => {
    if (!dataSourceId) return
    bootstrap.mutate(dataSourceId, {
      onSuccess: () => showToast('success', 'Version control enabled — you can now create drafts and review changes.'),
      onError: (e) => showToast('error', (e as Error).message),
    })
  }

  // No data source, or still resolving → render nothing (avoid flicker).
  if (!dataSourceId || (resolve.isLoading && !graphId)) return null

  // No versioned graph yet — or one that exists but was never seeded (genesis only,
  // mainHeadCommitSeq <= 1; e.g. a bootstrap that failed partway). Offer to enable/seed
  // it (managers only). This premium empty state is what makes the feature discoverable
  // AND self-heals a half-enabled graph.
  const needsSeed = !graphId || (resolve.data?.mainHeadCommitSeq ?? 0) <= 1
  if (needsSeed) {
    if (!canManage) return null
    return (
      <div className="flex items-center gap-3 px-4 py-2 border-b border-glass-border bg-gradient-to-r from-accent-lineage/[0.07] via-canvas-elevated/40 to-transparent shrink-0">
        <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-accent-lineage/10 border border-accent-lineage/20 shrink-0">
          <GitBranch className="w-4 h-4 text-accent-lineage" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink leading-tight">Version control is off for this data source</p>
          <p className="text-[11px] text-ink-muted leading-tight">
            Turn it on to edit safely in drafts, review changes, and publish with full history.
          </p>
        </div>
        <div className="flex-1" />
        <button
          onClick={handleEnable}
          disabled={bootstrap.isPending}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
        >
          {bootstrap.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {bootstrap.isPending ? 'Setting up…' : 'Enable version control'}
        </button>
      </div>
    )
  }

  const handleDiscard = () => {
    if (!branchId) return
    if (!window.confirm('Discard this draft? All its changes will be abandoned.')) return
    abandon.mutate(branchId, {
      onSuccess: () => {
        switchToMain()
        showToast('success', 'Draft discarded.')
      },
      onError: (e) => showToast('error', (e as Error).message),
    })
  }

  return (
    <>
      <div
        className={cn(
          // flex-wrap + min-w-0: on a narrow canvas the controls wrap to a second line
          // instead of overflowing — the indicator/Reviews/Publish actions stay reachable.
          'flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 border-b text-sm shrink-0 min-w-0',
          isDraft ? 'bg-amber-500/10 border-amber-500/20' : 'bg-canvas-elevated/40 border-glass-border',
        )}
      >
        <BranchSwitcher workspaceId={workspaceId} dataSourceId={dataSourceId} />
        <RefreshingBadge workspaceId={workspaceId} graphId={graphId} />

        {isDraft && branchId && (
          <div className="flex items-center gap-2 text-ink-muted">
            {diffQ.isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <>
                {changeSet.changes.length > 0 ? (
                  <span className="flex items-center gap-1.5" title="Committed to this branch — not merged to main yet">
                    <ChangeCountChips changeSet={changeSet} />
                    <span className="text-[11px] text-ink-muted/80">in branch</span>
                  </span>
                ) : uncommitted === 0 ? (
                  <span className="text-xs">No changes yet</span>
                ) : null}
                {uncommitted > 0 && (
                  <span className="text-xs font-medium text-amber-500 inline-flex items-center gap-1"
                        title="Edited on the canvas but not saved to the branch yet">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> {uncommitted} unsaved
                  </span>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Review layer — shown on both main and draft strips. */}
        <ViewPrIndicator wsId={workspaceId} viewId={viewId} onOpen={() => setPanelTab('prs')} />
        <button
          onClick={() => setPanelTab(isDraft ? 'changes' : 'history')}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-ink-muted hover:bg-canvas-overlay transition-colors"
          title="Changes, pull requests & history for this view"
        >
          <PanelRight className="w-3.5 h-3.5" />
          Reviews
        </button>

        {isDraft && branchId && (
          <>
            <ChangeHighlightControl
              committedHidden={committedDiffHidden}
              onToggle={() => setCommittedDiffHidden(!committedDiffHidden)}
              hasCommitted={changeSet.changes.length > 0}
            />

            <button
              onClick={() => setShowPublish(true)}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm transition-all"
            >
              <GitPullRequest className="w-3.5 h-3.5" />
              Publish
            </button>

            <button
              onClick={handleDiscard}
              disabled={abandon.isPending}
              className="p-1.5 rounded-lg text-ink-muted hover:text-rose-500 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
              title="Discard draft"
            >
              {abandon.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          </>
        )}
      </div>

      {isDraft && branchId && graphId && behindMain && (
        <PullBeforeMergeBanner
          wsId={workspaceId}
          graphId={graphId}
          branchId={branchId}
          baseCommitSeq={activeBranch?.baseCommitSeq ?? 0}
          mainHead={mainHead}
        />
      )}

      {showPublish && branchId && (
        <CommitDialog
          workspaceId={workspaceId}
          graphId={graphId}
          branchId={branchId}
          changeSet={changeSet}
          onClose={() => setShowPublish(false)}
        />
      )}

      {panelTab && graphId && (
        <ViewVersioningPanel
          wsId={workspaceId}
          graphId={graphId}
          viewId={viewId}
          dataSourceId={dataSourceId}
          branchId={isDraft ? branchId : null}
          viewName={viewName}
          initialTab={panelTab}
          onClose={() => setPanelTab(null)}
        />
      )}
    </>
  )
}

/** Committed-vs-main highlight toggle + a hover legend. The canvas always shows STAGED (unsaved)
 *  edits as a dashed halo; this toggle shows/hides the SOLID committed-vs-main rings so older
 *  committed work can be muted. Both keep the green/orange/rose colour language. */
function ChangeHighlightControl({
  committedHidden,
  onToggle,
  hasCommitted,
}: {
  committedHidden: boolean
  onToggle: () => void
  hasCommitted: boolean
}) {
  return (
    <div className="relative group">
      <button
        onClick={onToggle}
        disabled={!hasCommitted}
        title={committedHidden ? 'Show committed changes on the canvas' : 'Hide committed changes on the canvas'}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-40',
          !committedHidden && hasCommitted ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay',
        )}
      >
        {committedHidden && hasCommitted ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        Committed
      </button>
      <div className="absolute right-0 top-full mt-1.5 w-64 p-3 rounded-xl bg-canvas border border-glass-border shadow-xl text-[11px] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 pointer-events-none">
        <p className="font-semibold text-ink mb-2">How changes are marked on the canvas</p>
        <div className="space-y-1.5 text-ink-muted">
          <div className="flex items-center gap-2">
            <span className="w-4 h-4 rounded ring-2 ring-emerald-500/70 inline-block shrink-0" />
            solid ring = committed to this branch
          </div>
          <div className="flex items-center gap-2">
            <span className="w-4 h-4 rounded outline-dashed outline-2 outline-offset-1 outline-emerald-400/80 inline-block shrink-0" />
            dashed halo = unsaved (staged)
          </div>
          <div className="pt-1.5 mt-1 border-t border-glass-border/60 flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />new</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" />edited</span>
            <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" />deleted</span>
          </div>
        </div>
      </div>
    </div>
  )
}
