/**
 * Publishing a draft, shared by the Publish dialog (CommitDialog) and the Review & Save stepper's
 * last step: `usePublishFlow` holds the title, description and reviewers, who may do what (publish
 * straight away, or only through a review someone else merges), the review that may already cover
 * the draft, and what a refused publish says; `PublishBody` and `PublishActions` draw it.
 *
 * PR-by-default: the primary action opens a merge request (review path); "Publish now" is the
 * `:manage`-gated shortcut. Conflict-aware: a 409 (main moved) surfaces a summary + the escape
 * hatch, rather than a generic error notification.
 *
 * ALREADY-IN-REVIEW. A branch may have only one live review, because a PR's diff is computed live
 * from its source branch — so edits made after it was raised are ALREADY in it. Raising a second
 * would duplicate the first, and merging either would strand the other on a merged branch. When this
 * branch already has a review, it says so and routes to it instead of offering to make another.
 * (`PullRequestExistsError` is the race backstop: two clicks landing together.)
 */
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { GitPullRequest, Rocket, Loader2, AlertTriangle, ArrowRight, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { usePublishReceiptStore } from '@/store/publishReceiptStore'
import { useStagedChangesStore, useUnsavedCountOnBranch } from '@/store/stagedChangesStore'
import {
  usePublishBranch, useOpenMergeRequest, useLivePrForBranch, useBranchViewChanges, useDataSourceDraftsPolicy,
} from '../hooks/useVersioning'
import { invalidateViewVersions } from '@/hooks/useViewVersions'
import { VIEW_QUERY_KEY } from '@/hooks/useViewMetadata'
import { queryClient } from '@/lib/queryClient'
import {
  describeUniqueViolation, MergeConflictError, NotUpToDateError, PullRequestExistsError, UniqueViolationError,
} from '@/services/versioningApiService'
import { ChangeCountChips } from './ChangesPanel'
import { DraftViewChanges } from './DraftViewChanges'
import { ReviewerPicker } from './ReviewerPicker'
import type { ChangeSet } from '../model/changeModel'
import { refusalCopy } from '../model/provenance'

/** Shared values a refused publish lists before it says how many more there are. */
const UNIQUE_SHOWN = 10

export interface PublishFlowOptions {
  workspaceId: string
  graphId: string
  branchId: string
  /** The whole draft's changes (its counts go on the receipt). */
  changeSet: ChangeSet
  onClose: () => void
  /** For a host that is itself a dialog (an import's success step): called once this has taken the
   *  person elsewhere (to the review, or to a view on the draft), so the host closes too. */
  onLeave?: () => void
  /** Called once the draft is published. */
  onPublished?: () => void
  /** False for an editor of a shared draft: only its owner or a maintainer publishes it directly. */
  canPublishDraft?: boolean
  /** The draft's data source: its policy may have drafts published only through a review. */
  dataSourceId?: string | null
  /** The title to start with (what was just saved). */
  initialTitle?: string
  /** The draft's counts are being read again (right after a save): nothing is offered yet. */
  changesLoading?: boolean
}

export function usePublishFlow({
  workspaceId, graphId, branchId, changeSet, onClose, onLeave, onPublished, canPublishDraft = true, dataSourceId,
  initialTitle = '', changesLoading = false,
}: PublishFlowOptions) {
  // Seeded once: a title the person has started editing is theirs.
  const [message, setMessage] = useState(initialTitle)
  const [description, setDescription] = useState('')
  /** Who must approve before the review can merge. */
  const [reviewers, setReviewers] = useState<string[]>([])
  const [conflicts, setConflicts] = useState<number | null>(null)
  // Why the publish was refused for being behind Published (null: it wasn't).
  const [notUpToDate, setNotUpToDate] = useState<NotUpToDateError | null>(null)
  /** A publish refused because values that must be unique are shared: which, said here. */
  const [unique, setUnique] = useState<UniqueViolationError | null>(null)
  /** A review we discovered only when the server rejected our open (the race backstop). */
  const [raced, setRaced] = useState<{ prId: string; title?: string | null } | null>(null)
  /** "Publish now" while a review is open bypasses it — make that an explicit second step. */
  const [confirmBypass, setConfirmBypass] = useState(false)
  const { notify } = useAppNotifications()
  const navigate = useNavigate()
  const canManage = usePermission('workspace:datasource:manage', workspaceId)
  // Publishing straight to the live version needs publish; without it, a draft goes through review.
  const canPublish = usePermission('workspace:datasource:publish', workspaceId)
  // Where nobody merges their own changes, a draft is published only through a review someone
  // else merges: a direct publish would be its publisher's own merge.
  const reviewOnly = useDataSourceDraftsPolicy(workspaceId, dataSourceId).data?.effective.selfMerge === false
  const switchToMain = useBranchStore((s) => s.switchToMain)
  const setReceipt = usePublishReceiptStore((s) => s.setReceipt)

  const publish = usePublishBranch(workspaceId, graphId)
  const openMr = useOpenMergeRequest(workspaceId, graphId)
  const { livePr, pending: prPending } = useLivePrForBranch(workspaceId, graphId, branchId)
  const busy = publish.isPending || openMr.isPending
  // A draft can change views too (imports staged in it, layer edits): they go live with it, so a
  // draft of views alone is still worth publishing.
  const viewChangesQ = useBranchViewChanges(workspaceId, graphId, branchId)
  const viewChanges = viewChangesQ.data
  const viewChangeCount = (viewChanges?.views.length ?? 0) + (viewChanges?.hidden ?? 0)
  // Counted, not listed: the dialog is handed a draft's counts, whatever its size.
  const changeCount = changeSet.counts.added + changeSet.counts.modified + changeSet.counts.removed
  // Right after a save, the draft's counts are being read again: nothing is offered until they are.
  const hasChanges = !changesLoading && (changeCount > 0 || viewChangeCount > 0)
  // Edits still staged on the canvas are not on the draft: publishing would leave them behind. A
  // review is not blocked — it tracks the branch, so edits saved later land in it.
  const unsaved = useUnsavedCountOnBranch(branchId)

  // The review that already covers this branch — from the list, or from a lost race.
  const existingPr = livePr ? { prId: livePr.prId, title: livePr.title } : raced
  const inReview = !!existingPr

  const goToReview = (prId: string) => {
    onClose()
    navigate(`/workspaces/${workspaceId}/reviews?pr=${prId}`)
    onLeave?.()
  }

  const handleError = (e: unknown) => {
    if (e instanceof MergeConflictError) {
      setConflicts(e.conflicts.length)
    } else if (e instanceof NotUpToDateError) {
      setNotUpToDate(e)
    } else if (e instanceof UniqueViolationError) {
      setUnique(e)
    } else if (e instanceof PullRequestExistsError) {
      // We lost a race (or the list was stale). Don't dead-end — show the review that won.
      setRaced({ prId: e.prId, title: e.prTitle })
    } else {
      notify('error', (e as Error).message)
    }
  }

  const handleOpenMr = () => {
    setConflicts(null)
    setNotUpToDate(null)
    setUnique(null)
    openMr.mutate(
      {
        branchId, title: message || undefined, description: description || undefined,
        reviewers: reviewers.length ? reviewers : undefined,
      },
      {
        onSuccess: (res) => {
          notify('success', 'Sent for review.')
          goToReview(res.prId)
        },
        onError: handleError,
      },
    )
  }

  const handlePublish = () => {
    if (unsaved > 0) return
    // Publishing lands exactly what the open review proposed, so the server resolves that review as
    // merged. It's legitimate (it's the :manage escape hatch) but it skips the reviewers — so ask.
    if (inReview && !confirmBypass) {
      setConfirmBypass(true)
      return
    }
    setConflicts(null)
    setNotUpToDate(null)
    setUnique(null)
    publish.mutate(
      { branchId, message: message || 'Publish draft' },
      {
        onSuccess: (res) => {
          // Views the draft changed are live now: whatever showed them before is stale.
          for (const v of viewChanges?.views ?? []) {
            void queryClient.invalidateQueries({ queryKey: [...VIEW_QUERY_KEY, v.viewId] })
            invalidateViewVersions(queryClient, v.viewId)
          }
          if (viewChangeCount) void queryClient.invalidateQueries({ queryKey: ['views'] })
          // The receipt (not a notification) is the confirmation — the bar renders it until dismissed.
          setReceipt({ commitId: res.commitId, outcome: res.outcome, graphId, counts: changeSet.counts, via: 'publish' })
          switchToMain()
          onClose()
          onPublished?.()
        },
        onError: handleError,
      },
    )
  }

  return {
    workspaceId, branchId, dataSourceId, changeSet, onClose, onLeave, canPublishDraft, changesLoading,
    message, setMessage, description, setDescription, reviewers, setReviewers,
    conflicts, notUpToDate, unique, confirmBypass, canManage, canPublish, reviewOnly,
    publish, openMr, prPending, busy, viewChanges, viewChangesQ, viewChangeCount, changeCount, hasChanges, unsaved,
    existingPr, inReview, goToReview, handleOpenMr, handlePublish,
  }
}

export type PublishFlow = ReturnType<typeof usePublishFlow>

/** What publishing would change, the title, description and reviewers, and why it can't (yet). */
export function PublishBody({ flow, offerSave = true }: {
  flow: PublishFlow
  /** Offer to save edits still staged on the canvas (off where the host is that save). */
  offerSave?: boolean
}) {
  const {
    branchId, changeSet, onClose, onLeave, changesLoading, message, setMessage, description, setDescription,
    reviewers, setReviewers, conflicts, notUpToDate, unique, confirmBypass, viewChanges, viewChangesQ,
    viewChangeCount, changeCount, hasChanges, unsaved, existingPr, inReview, goToReview, workspaceId, dataSourceId,
  } = flow
  return (
    <div className="px-6 pb-4 space-y-3">
      {changeCount > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-muted">This draft changes</span>
          <ChangeCountChips changeSet={changeSet} />
        </div>
      )}
      {viewChanges && viewChangeCount > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-ink-muted">
            {changeCount > 0 ? 'And views, which go live with it:' : 'This draft changes views, which go live with it:'}
          </p>
          <DraftViewChanges changes={viewChanges} branchId={branchId} onNavigate={() => { onClose(); onLeave?.() }}
            className="max-h-40 overflow-y-auto" />
        </div>
      )}
      {!hasChanges && (
        <p className="text-xs text-ink-muted">
          {viewChangesQ.isLoading || changesLoading ? 'Looking for changes in this draft…' : 'No changes detected in this draft yet.'}
        </p>
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
                Everything you’ve saved on this draft — including the {changeCount.toLocaleString()} change
                {changeCount === 1 ? '' : 's'} above — is already part of this review.
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
          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">
              Reviewers <span className="text-ink-muted/50 normal-case font-normal">· optional, they must approve before it merges</span>
            </label>
            <ReviewerPicker wsId={workspaceId} dataSourceId={dataSourceId} value={reviewers} onChange={setReviewers} />
          </div>
        </>
      )}

      {unsaved > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-[11px] text-ink-muted leading-relaxed">
            <span className="font-medium text-amber-500">{unsaved} unsaved edit{unsaved === 1 ? '' : 's'} on the canvas.</span>{' '}
            They aren’t part of this draft yet, so publishing now would leave them behind. Save them
            in Review &amp; Save first, or discard them.
            {offerSave && (
              <button
                type="button"
                onClick={() => { useStagedChangesStore.getState().openReviewPanel('publish'); onClose() }}
                className="mt-2 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-amber-700 dark:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
              >
                Review &amp; Save them, then publish <ArrowRight className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
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

      {unique && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0 text-[11px] text-ink-muted">
            <span className="font-medium text-amber-500">
              Nothing was published — {unique.total === 1
                ? '1 value that must be unique is'
                : `${unique.total} values that must be unique are`} used more than once.
            </span>{' '}
            Give each entity its own value, then publish.
            <ul className="mt-1.5 space-y-0.5 text-ink break-words">
              {unique.violations.slice(0, UNIQUE_SHOWN).map((v, i) => <li key={i}>{describeUniqueViolation(v)}</li>)}
            </ul>
            {unique.total > Math.min(unique.violations.length, UNIQUE_SHOWN) && (
              <p className="mt-1">…and {unique.total - Math.min(unique.violations.length, UNIQUE_SHOWN)} more.</p>
            )}
          </div>
        </div>
      )}

      {notUpToDate && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-[11px] text-ink-muted">
            <span className="font-medium text-amber-500">
              {notUpToDate.reason === 'overlap' ? 'Automation changed something you changed.' : 'Updates are available for this draft.'}
            </span>{' '}
            {refusalCopy(notUpToDate.reason)} Use “Get latest updates” on the toolbar.
          </div>
        </div>
      )}
    </div>
  )
}

/** Publish now (where allowed) and Submit for review — or, already in review, the way to it. */
export function PublishActions({ flow, emphasis = 'review', leading }: {
  flow: PublishFlow
  /** Which action is the one the person came for (the stepper's choice). */
  emphasis?: 'publish' | 'review'
  /** Shown first, on the left (the stepper's "Not now"). */
  leading?: ReactNode
}) {
  const {
    canManage, canPublish, canPublishDraft, reviewOnly, inReview, confirmBypass, busy, hasChanges, unsaved,
    publish, openMr, prPending, existingPr, goToReview, handlePublish, handleOpenMr,
  } = flow
  return (
    <>
      {leading}
      {canManage && (
        <HoverTip
          className="inline-flex"
          label={!canPublish
            ? 'Publishing straight to the live version needs the publish permission on this workspace'
            : !canPublishDraft
            ? 'Only the draft’s owner or a maintainer can publish a shared draft'
            : reviewOnly
            ? 'This data source publishes drafts through a review that someone else merges'
            : inReview
              ? 'Publish straight to the live version, bypassing the open review'
              : 'Publish straight to the live version, skipping review'}
          detail={canPublish && canPublishDraft && !reviewOnly ? 'Everyone sees the result immediately' : 'Submit it for review instead'}
        >
        <button
          onClick={handlePublish}
          disabled={busy || !hasChanges || unsaved > 0 || !canPublish || !canPublishDraft || reviewOnly}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50',
            confirmBypass
              ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
              : emphasis === 'publish'
              ? 'text-white bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 shadow-lg shadow-emerald-500/20'
              : 'text-ink hover:bg-canvas-overlay',
          )}
        >
          {publish.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
          {confirmBypass ? 'Publish anyway' : 'Publish now'}
        </button>
        </HoverTip>
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
            'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50',
            emphasis === 'publish'
              ? 'text-ink hover:bg-canvas-overlay'
              : cn('text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700',
                'shadow-lg shadow-indigo-500/20 hover:scale-[1.02] active:scale-[0.98]'),
          )}
        >
          {openMr.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitPullRequest className="w-4 h-4" />}
          Submit for review
        </button>
      )}
    </>
  )
}
