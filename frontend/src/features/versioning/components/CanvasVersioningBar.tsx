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
import { Eye, EyeOff, GitPullRequest, Trash2, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { useBranchStore, useEffectiveBranchId } from '@/store/branchStore'
import { useStagedChangeCount } from '@/store/stagedChangesStore'
import { useAbandonDraft, useDiffVsMain, useResolveGraph } from '../hooks/useVersioning'
import { fromDiffVsMain } from '../model/changeAdapters'
import { EMPTY_CHANGE_SET } from '../model/changeModel'
import { BranchSwitcher } from './BranchSwitcher'
import { ChangeCountChips } from './ChangesPanel'
import { CommitDialog } from './CommitDialog'

interface CanvasVersioningBarProps {
  workspaceId: string
  dataSourceId: string | null
}

export function CanvasVersioningBar({ workspaceId, dataSourceId }: CanvasVersioningBarProps) {
  const { showToast } = useToast()
  const resolve = useResolveGraph(workspaceId, dataSourceId)
  const graphId = resolve.data?.graphId ?? null

  const branchId = useEffectiveBranchId(workspaceId, dataSourceId)
  const isDraft = !!branchId
  const showDiff = useBranchStore((s) => s.showDiff)
  const setShowDiff = useBranchStore((s) => s.setShowDiff)
  const setActiveChangeSet = useBranchStore((s) => s.setActiveChangeSet)
  const switchToMain = useBranchStore((s) => s.switchToMain)

  const [showPublish, setShowPublish] = useState(false)
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

  // No versioned graph for this data source → no chrome at all.
  if (!dataSourceId || !graphId) return null

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
          'flex items-center gap-3 px-3 py-1.5 border-b text-sm shrink-0',
          isDraft ? 'bg-amber-500/10 border-amber-500/20' : 'bg-canvas-elevated/40 border-glass-border',
        )}
      >
        <BranchSwitcher workspaceId={workspaceId} dataSourceId={dataSourceId} />

        {isDraft && branchId && (
          <>
            <div className="flex items-center gap-2 text-ink-muted">
              {diffQ.isLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : changeSet.changes.length > 0 ? (
                <ChangeCountChips changeSet={changeSet} />
              ) : (
                <span className="text-xs">No committed changes yet</span>
              )}
              {uncommitted > 0 && (
                <span className="text-xs text-amber-500" title="Edits not yet committed to the draft">
                  · {uncommitted} unsaved
                </span>
              )}
            </div>

            <div className="flex-1" />

            <button
              onClick={() => setShowDiff(!showDiff, { source: 'branch', branchId })}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                showDiff ? 'bg-accent-lineage/15 text-accent-lineage' : 'text-ink-muted hover:bg-canvas-overlay',
              )}
            >
              {showDiff ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showDiff ? 'Hide changes' : 'Review changes'}
            </button>

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

      {showPublish && branchId && (
        <CommitDialog
          workspaceId={workspaceId}
          graphId={graphId}
          branchId={branchId}
          changeSet={changeSet}
          onClose={() => setShowPublish(false)}
        />
      )}
    </>
  )
}
