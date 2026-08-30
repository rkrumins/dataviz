/**
 * CommitDialog — take a draft to main. PR-by-default: the primary action opens a
 * merge request (review path); "Publish directly" is the `:manage`-gated shortcut.
 * Conflict-aware: a 409 (main moved) surfaces a summary + the escape hatch, rather
 * than a generic error notification.
 *
 * ALREADY-IN-REVIEW. A branch may have only one live review, because a PR's diff is computed live
 * from its source branch — so edits made after it was raised are ALREADY in it. Raising a second
 * would duplicate the first, and merging either would strand the other on a merged branch. When this
 * branch already has a review, the dialog says so and routes to it instead of offering to make
 * another. (`PullRequestExistsError` is the race backstop: two clicks landing together.)
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GitPullRequest, Rocket, X, Loader2, AlertTriangle, ArrowRight, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppNotifications } from '@/components/ui/notifications'
import { Backdrop } from '@/components/ui/Backdrop'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { usePublishReceiptStore } from '@/store/publishReceiptStore'
import { usePublishBranch, useOpenMergeRequest, useLivePrForBranch } from '../hooks/useVersioning'
import { MergeConflictError, NotUpToDateError, PullRequestExistsError } from '@/services/versioningApiService'
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
  const [notUpToDate, setNotUpToDate] = useState(false)
  /** A review we discovered only when the server rejected our open (the race backstop). */
  const [raced, setRaced] = useState<{ prId: string; title?: string | null } | null>(null)
  /** "Publish now" while a review is open bypasses it — make that an explicit second step. */
  const [confirmBypass, setConfirmBypass] = useState(false)
  const { notify } = useAppNotifications()
  const navigate = useNavigate()
  const canManage = usePermission('workspace:datasource:manage', workspaceId)
  const switchToMain = useBranchStore((s) => s.switchToMain)
  const setReceipt = usePublishReceiptStore((s) => s.setReceipt)

  const publish = usePublishBranch(workspaceId, graphId)
  const openMr = useOpenMergeRequest(workspaceId, graphId)
  const { livePr, pending: prPending } = useLivePrForBranch(workspaceId, graphId, branchId)
  const busy = publish.isPending || openMr.isPending
  const hasChanges = changeSet.changes.length > 0

  // The review that already covers this branch — from the list, or from a lost race.
  const existingPr = livePr ? { prId: livePr.prId, title: livePr.title } : raced
  const inReview = !!existingPr

  const goToReview = (prId: string) => {
    onClose()
    navigate(`/workspaces/${workspaceId}/reviews?pr=${prId}`)
  }

  const handleError = (e: unknown) => {
    if (e instanceof MergeConflictError) {
      setConflicts(e.conflicts.length)
    } else if (e instanceof NotUpToDateError) {
      setNotUpToDate(true)
    } else if (e instanceof PullRequestExistsError) {
      // We lost a race (or the list was stale). Don't dead-end — show the review that won.
      setRaced({ prId: e.prId, title: e.prTitle })
    } else {
      notify('error', (e as Error).message)
    }
  }

  const handleOpenMr = () => {
    setConflicts(null)
    setNotUpToDate(false)
    openMr.mutate(
      { branchId, title: message || undefined, description: description || undefined },
      {
        onSuccess: (res) => {
          notify('success', 'Sent for review.')
          onClose()
          navigate(`/workspaces/${workspaceId}/reviews?pr=${res.prId}`)
        },
        onError: handleError,
      },
    )
  }

  const handlePublish = () => {
    // Publishing lands exactly what the open review proposed, so the server resolves that review as
    // merged. It's legitimate (it's the :manage escape hatch) but it skips the reviewers — so ask.
    if (inReview && !confirmBypass) {
      setConfirmBypass(true)
      return
    }
    setConflicts(null)
    setNotUpToDate(false)
    publish.mutate(
      { branchId, message: message || 'Publish draft' },
      {
        onSuccess: (res) => {
          // The receipt (not a notification) is the confirmation — the bar renders it until dismissed.
          setReceipt({ commitId: res.commitId, graphId, counts: changeSet.counts, via: 'publish' })
          switchToMain()
          onClose()
        },
        onError: handleError,
      },
    )
  }

  return (
    <>
    <Backdrop open={true} onClick={busy ? undefined : onClose} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
    <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
      <div className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-fade-in flex flex-col pointer-events-auto">
        <div className="px-6 pt-6 pb-4 flex items-center gap-3">
          <div className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center border',
            inReview
              ? 'bg-indigo-500/10 border-indigo-500/20'
              : 'bg-accent-lineage/10 border-accent-lineage/20',
          )}>
            <GitPullRequest className={cn('w-5 h-5', inReview ? 'text-indigo-500' : 'text-accent-lineage')} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ink tracking-tight">
              {inReview ? 'Already in review' : 'Publish your draft'}
            </h3>
            <p className="text-[11px] text-ink-muted mt-0.5">
              {inReview
                ? 'This draft has an open review — your changes are part of it.'
                : 'Send your changes to the Published version.'}
            </p>
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

          {inReview ? (
            /* The review that already covers this branch. A review tracks the BRANCH, so anything
             * saved since it was raised is in it already — say that plainly, because the natural
             * assumption is the opposite (that a new review is needed to carry new work). */
            <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] p-3.5 space-y-2.5">
              <div className="flex items-start gap-2.5">
                <GitPullRequest className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink truncate">
                    {existingPr!.title?.trim() || 'Open review'}
                  </p>
                  <p className="text-[11px] text-ink-muted mt-1 leading-relaxed">
                    Everything you’ve saved on this draft — including the {changeSet.changes.length} change
                    {changeSet.changes.length === 1 ? '' : 's'} above — is already part of this review.
                    There’s nothing else to submit.
                  </p>
                </div>
              </div>
              <button
                onClick={() => goToReview(existingPr!.prId)}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold
                           text-indigo-600 dark:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors"
              >
                Open the review <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <>
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
            </>
          )}

          {confirmBypass && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-[11px] text-ink-muted leading-relaxed">
                <span className="font-medium text-amber-500">This skips the open review.</span>{' '}
                Publishing sends these changes straight to the Published version. The review will be
                closed as merged, without its reviewers seeing it. Press{' '}
                <span className="font-medium text-ink">Publish anyway</span> to continue.
              </div>
            </div>
          )}

          {conflicts != null && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-[11px] text-ink-muted">
                <span className="font-medium text-amber-500">The Published version changed — {conflicts} conflict{conflicts === 1 ? '' : 's'}.</span>{' '}
                Submit for review to resolve them, or archive this draft and start again from the latest.
              </div>
            </div>
          )}

          {notUpToDate && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-[11px] text-ink-muted">
                <span className="font-medium text-amber-500">Updates are available for this draft.</span>{' '}
                Use “Get latest updates” on the toolbar to bring in the newest changes, then publish.
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
          {canManage && (
            <button
              onClick={handlePublish}
              disabled={busy || !hasChanges}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50',
                confirmBypass
                  ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
                  : 'text-ink hover:bg-canvas-overlay',
              )}
              title={inReview
                ? 'Publish straight to the live version, bypassing the open review'
                : 'Publish straight to the live version, skipping review'}
            >
              {publish.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
              {confirmBypass ? 'Publish anyway' : 'Publish now'}
            </button>
          )}
          {inReview ? (
            <button
              onClick={() => goToReview(existingPr!.prId)}
              className={cn(
                'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white transition-all',
                'bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700',
                'shadow-lg shadow-indigo-500/20 hover:scale-[1.02] active:scale-[0.98]',
              )}
            >
              <GitPullRequest className="w-4 h-4" />
              View review
            </button>
          ) : (
            <button
              onClick={handleOpenMr}
              disabled={busy || !hasChanges || prPending}
              className={cn(
                'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white transition-all disabled:opacity-50',
                'bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700',
                'shadow-lg shadow-indigo-500/20 hover:scale-[1.02] active:scale-[0.98]',
              )}
            >
              {openMr.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitPullRequest className="w-4 h-4" />}
              Submit for review
            </button>
          )}
        </div>
      </div>
    </div>
    </>
  )
}
