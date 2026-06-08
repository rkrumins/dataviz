/**
 * CommitDialog — take a draft to main. PR-by-default: the primary action opens a
 * merge request (review path); "Publish directly" is the `:manage`-gated shortcut.
 * Conflict-aware: a 409 (main moved) surfaces a summary + the escape hatch, rather
 * than a generic error toast.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GitPullRequest, Rocket, X, Loader2, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { usePublishBranch, useOpenMergeRequest } from '../hooks/useVersioning'
import { MergeConflictError } from '@/services/versioningApiService'
import { ChangeCountChips } from './ChangesPanel'
import type { ChangeSet } from '../model/changeModel'

interface CommitDialogProps {
  workspaceId: string
  graphId: string
  branchId: string
  changeSet: ChangeSet
  onClose: () => void
}

export function CommitDialog({ workspaceId, graphId, branchId, changeSet, onClose }: CommitDialogProps) {
  const [message, setMessage] = useState('')
  const [description, setDescription] = useState('')
  const [conflicts, setConflicts] = useState<number | null>(null)
  const { showToast } = useToast()
  const navigate = useNavigate()
  const canManage = usePermission('workspace:datasource:manage', workspaceId)
  const switchToMain = useBranchStore((s) => s.switchToMain)

  const publish = usePublishBranch(workspaceId, graphId)
  const openMr = useOpenMergeRequest(workspaceId, graphId)
  const busy = publish.isPending || openMr.isPending
  const hasChanges = changeSet.changes.length > 0

  const handleError = (e: unknown) => {
    if (e instanceof MergeConflictError) {
      setConflicts(e.conflicts.length)
    } else {
      showToast('error', (e as Error).message)
    }
  }

  const handleOpenMr = () => {
    setConflicts(null)
    openMr.mutate(
      { branchId, title: message || undefined, description: description || undefined },
      {
        onSuccess: (res) => {
          showToast('success', 'Merge request opened for review.')
          onClose()
          navigate(`/workspaces/${workspaceId}/reviews?pr=${res.prId}`)
        },
        onError: handleError,
      },
    )
  }

  const handlePublish = () => {
    setConflicts(null)
    publish.mutate(
      { branchId, message: message || 'Publish draft' },
      {
        onSuccess: () => {
          showToast('success', 'Published to main.')
          switchToMain()
          onClose()
        },
        onError: handleError,
      },
    )
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <div className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-fade-in flex flex-col">
        <div className="px-6 pt-6 pb-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-lineage/10 flex items-center justify-center border border-accent-lineage/20">
            <GitPullRequest className="w-5 h-5 text-accent-lineage" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ink tracking-tight">Publish draft</h3>
            <p className="text-[11px] text-ink-muted mt-0.5">Take your changes to main.</p>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded-lg hover:bg-canvas-overlay transition-colors disabled:opacity-50">
            <X className="w-4 h-4 text-ink-muted" />
          </button>
        </div>

        <div className="px-6 pb-4 space-y-3">
          {hasChanges ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-muted">This draft changes</span>
              <ChangeCountChips changeSet={changeSet} />
            </div>
          ) : (
            <p className="text-xs text-ink-muted">No changes detected in this draft yet.</p>
          )}

          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Title</label>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="A short summary of these changes…"
              className="w-full rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">
              Description <span className="text-ink-muted/50 normal-case font-normal">· optional, for reviewers</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add context — what changed and why…"
              rows={3}
              className="w-full rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40 resize-none"
            />
          </div>

          {conflicts != null && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-[11px] text-ink-muted">
                <span className="font-medium text-amber-500">Main has moved — {conflicts} conflict{conflicts === 1 ? '' : 's'}.</span>{' '}
                Open a merge request to resolve them, or abandon this draft and re-open it from the latest main.
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
          {canManage && (
            <button
              onClick={handlePublish}
              disabled={busy || !hasChanges}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-canvas-overlay transition-colors disabled:opacity-50"
              title="Publish straight to main"
            >
              {publish.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
              Publish directly
            </button>
          )}
          <button
            onClick={handleOpenMr}
            disabled={busy || !hasChanges}
            className={cn(
              'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-50',
              'bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700',
              'shadow-lg shadow-indigo-500/20 hover:scale-[1.02] active:scale-[0.98]',
            )}
          >
            {openMr.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitPullRequest className="w-4 h-4" />}
            Open merge request
          </button>
        </div>
      </div>
    </div>
  )
}
