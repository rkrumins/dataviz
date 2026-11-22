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
import { edgeIndexOf, nodeIndexOf } from '@/lib/storeIndex'
import { targetFromEdge } from '@/lib/drawerEdgeTarget'
import { HoverTip } from '@/components/ui/HoverTip'
import { CopyButton } from '@/components/ui/CopyButton'
import { useCanvasStore } from '@/store/canvas'
import { useAppNotifications } from '@/components/ui/notifications'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { usePublishReceiptStore } from '@/store/publishReceiptStore'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { fillRefusedRequest } from '@/components/canvas/property-manager/op/fillRequired'
import { useStagedChangesStore, useUnsavedCountOnBranch } from '@/store/stagedChangesStore'
import {
  usePublishBranch, useOpenMergeRequest, useLivePrForBranch, useBranchViewChanges, useDataSourceDraftsPolicy,
} from '../hooks/useVersioning'
import { invalidateViewVersions } from '@/hooks/useViewVersions'
import { VIEW_QUERY_KEY } from '@/hooks/useViewMetadata'
import { queryClient } from '@/lib/queryClient'
import {
  describeUniqueViolation, FieldViolationError, MergeConflictError, NotUpToDateError, PullRequestExistsError,
  UniqueViolationError, type FieldViolation, type FieldViolationCount,
} from '@/services/versioningApiService'
import { ChangeCountChips } from './ChangesPanel'
import { DraftViewChanges } from './DraftViewChanges'
import { ReviewerPicker } from './ReviewerPicker'
import type { ChangeSet } from '../model/changeModel'
import { refusalCopy } from '../model/provenance'

/** Shared values a refused publish lists before it says how many more there are. */
const UNIQUE_SHOWN = 10

/** What a field refusal's count says, by rule. */
const FIELD_RULE_PHRASE: Record<FieldViolation['rule'], string> = {
  field_required: 'missing',
  field_not_allowed: 'not allowed',
  field_type: 'of the wrong type',
}

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
  /** The server's word on publishing straight to the live version (`BranchAccess.canPublish`): the
   *  publish permission, or the Playground graph's maker. Absent, the publish permission decides. */
  canPublish?: boolean
  /** The draft's data source: its policy may have drafts published only through a review. */
  dataSourceId?: string | null
  /** The title to start with (what was just saved). */
  initialTitle?: string
  /** The draft's counts are being read again (right after a save): nothing is offered yet. */
  changesLoading?: boolean
}

export function usePublishFlow({
  workspaceId, graphId, branchId, changeSet, onClose, onLeave, onPublished, canPublishDraft = true, dataSourceId,
  initialTitle = '', changesLoading = false, canPublish: serverSays,
}: PublishFlowOptions) {
  // Seeded once: a title the person has started editing is theirs.
  const [message, setMessage] = useState(initialTitle)
  const [description, setDescription] = useState('')
  /** Who must approve before the review can merge: people, and groups (any member answers for one). */
  const [reviewers, setReviewers] = useState<string[]>([])
  const [reviewerGroups, setReviewerGroups] = useState<string[]>([])
  const [conflicts, setConflicts] = useState<number | null>(null)
  // Why the publish was refused for being behind Published (null: it wasn't).
  const [notUpToDate, setNotUpToDate] = useState<NotUpToDateError | null>(null)
  /** A publish refused because values that must be unique are shared: which, said here. */
  const [unique, setUnique] = useState<UniqueViolationError | null>(null)
  /** A publish refused because values break their entity types' fields: each one, said here. */
  const [fieldRefusal, setFieldRefusal] = useState<FieldViolationError | null>(null)
  /** A review we discovered only when the server rejected our open (the race backstop). */
  const [raced, setRaced] = useState<{ prId: string; title?: string | null } | null>(null)
  /** "Publish now" while a review is open bypasses it — make that an explicit second step. */
  const [confirmBypass, setConfirmBypass] = useState(false)
  const { notify } = useAppNotifications()
  const navigate = useNavigate()
  const canManage = usePermission('workspace:datasource:manage', workspaceId)
  // Publishing straight to the live version needs publish — or, in the Playground, the graph's
  // maker (the server says which); without it, a draft goes through review.
  const holdsPublish = usePermission('workspace:datasource:publish', workspaceId)
  const canPublish = serverSays ?? holdsPublish
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
    navigate(`/workspaces/${workspaceId}/reviews/${prId}`)
    onLeave?.()
  }

  const handleError = (e: unknown) => {
    if (e instanceof MergeConflictError) {
      setConflicts(e.conflicts.length)
    } else if (e instanceof NotUpToDateError) {
      setNotUpToDate(e)
    } else if (e instanceof UniqueViolationError) {
      setUnique(e)
    } else if (e instanceof FieldViolationError) {
      setFieldRefusal(e)
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
    setFieldRefusal(null)
    openMr.mutate(
      {
        branchId, title: message || undefined, description: description || undefined,
        reviewers: reviewers.length ? reviewers : undefined,
        reviewerGroups: reviewerGroups.length ? reviewerGroups : undefined,
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
    setFieldRefusal(null)
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
    message, setMessage, description, setDescription, reviewers, setReviewers, reviewerGroups, setReviewerGroups,
    conflicts, notUpToDate, unique, fieldRefusal, confirmBypass, canManage, canPublish, reviewOnly,
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
    reviewers, setReviewers, reviewerGroups, setReviewerGroups, conflicts, notUpToDate, unique, fieldRefusal, confirmBypass, viewChanges, viewChangesQ,
    viewChangeCount, changeCount, hasChanges, unsaved, existingPr, inReview, goToReview, workspaceId, dataSourceId,
  } = flow
  // A required field left empty is filled on the entities refused by one bulk change — offered on
  // the draft open on the canvas, which the bulk dialog writes to.
  const fillHere = useBranchStore((s) => s.currentBranchId === branchId)
  const fills = (c: FieldViolationCount) => fillHere && c.rule === 'field_required' && !!c.ids?.length
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
            <ReviewerPicker wsId={workspaceId} dataSourceId={dataSourceId} value={reviewers} onChange={setReviewers}
              groups={reviewerGroups} onGroupsChange={setReviewerGroups} />
          </div>
        </>
      )}

      {unsaved > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-[11px] text-ink-muted leading-relaxed">
            <span className="font-medium text-amber-700 dark:text-amber-300">{unsaved} unsaved edit{unsaved === 1 ? '' : 's'} on the canvas.</span>{' '}
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
            <span className="font-medium text-amber-700 dark:text-amber-300">This skips the open review.</span>{' '}
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
            <span className="font-medium text-amber-700 dark:text-amber-300">The Published version changed — {conflicts} conflict{conflicts === 1 ? '' : 's'}.</span>{' '}
            Submit for review to resolve them, or archive this draft and start again from the latest.
          </div>
        </div>
      )}

      {unique && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0 text-[11px] text-ink-muted">
            <span className="font-medium text-amber-700 dark:text-amber-300">
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

      {fieldRefusal && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 text-[11px] text-ink-muted">
            <span className="font-medium text-amber-700 dark:text-amber-300">
              Nothing was published — {fieldRefusal.total === 1
                ? '1 value breaks'
                : `${fieldRefusal.total.toLocaleString()} values break`} the fields their types define.
            </span>{' '}
            Change them in the draft, then publish.
            {(fieldRefusal.total > Math.min(fieldRefusal.violations.length, UNIQUE_SHOWN) || fieldRefusal.byField.some(fills))
              && fieldRefusal.byField.length > 0 && (
              <ul aria-label="Values to change by field" className="mt-1.5 space-y-1 text-ink">
                {fieldRefusal.byField.map((c) => (
                  <li key={`${c.entityKind ?? 'node'}:${c.entityType}:${c.field}:${c.rule}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2">
                    <span className="min-w-0">
                      <span className="font-medium">{c.entityType}{c.entityKind === 'edge' ? ' relationships' : ''} · {c.fieldName || c.field}</span>
                      <span className="text-ink-muted">: {c.count.toLocaleString()} {FIELD_RULE_PHRASE[c.rule]}</span>
                    </span>
                    {fills(c) && <FillRefused count={c} onOpen={() => { onClose(); onLeave?.() }} />}
                  </li>
                ))}
              </ul>
            )}
            {/* Some six rows, then it scrolls: the fills above stay in sight. */}
            <ul aria-label="Values to change" className="mt-1.5 max-h-56 overflow-y-auto custom-scrollbar pr-1 space-y-1 text-ink">
              {fieldRefusal.violations.slice(0, UNIQUE_SHOWN).map((v, i) => (
                <FieldViolationRow key={`${v.entity_id}:${v.field}:${i}`} v={v} onOpen={() => { onClose(); onLeave?.() }} />
              ))}
            </ul>
            {fieldRefusal.total > Math.min(fieldRefusal.violations.length, UNIQUE_SHOWN) && (
              <p className="mt-1">…and {(fieldRefusal.total - Math.min(fieldRefusal.violations.length, UNIQUE_SHOWN)).toLocaleString()} more.</p>
            )}
          </div>
        </div>
      )}

      {notUpToDate && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-[11px] text-ink-muted">
            <span className="font-medium text-amber-700 dark:text-amber-300">
              {notUpToDate.reason === 'overlap' ? 'Automation changed something you changed.' : 'Updates are available for this draft.'}
            </span>{' '}
            {refusalCopy(notUpToDate.reason)} Use “Get latest updates” on the toolbar.
          </div>
        </div>
      )}
    </div>
  )
}

/** "Fill N missing…": the bulk dialog, "Fill if empty" on the entities (or relationships) the
 *  publish refused for a required field left empty — by id, so ones new in the draft too. One change
 *  takes at most the first 20,000; the next publish names the rest. */
function FillRefused({ count, onOpen }: { count: FieldViolationCount; onOpen: () => void }) {
  const ids = count.ids ?? []
  const complete = !!count.idsComplete
  const fill = () => {
    onOpen()
    usePropertyJobsStore.getState().requestOp(fillRefusedRequest({
      entityType: count.entityType, field: count.field, fieldName: count.fieldName, ids, complete,
      edges: count.entityKind === 'edge',
    }))
  }
  // A column of their own at the row's end; the rest said under the fill, across the row.
  return (
    <>
      <button type="button" onClick={fill}
        className="-mt-0.5 px-1.5 h-5 rounded text-[10.5px] font-semibold text-accent-lineage hover:bg-accent-lineage/10">
        {complete ? `Fill ${count.count.toLocaleString()} missing…` : `Fill the first ${ids.length.toLocaleString()}…`}
      </button>
      {!complete && <span className="col-span-2 px-1.5 text-right text-[10.5px] text-ink-muted"> then publish again for the rest</span>}
    </>
  )
}

/** One value a publish refused by its field: the entity by name — a relationship by its ends — what
 *  is wrong, and the way to it: opened in the drawer when it is on the canvas, else its id to find
 *  it by. */
function FieldViolationRow({ v, onOpen }: { v: FieldViolation; onOpen: () => void }) {
  const edge = v.kind === 'edge'
  const id = edge ? v.entity_id : v.urn || `gv:${v.entity_id}`
  const onCanvas = useCanvasStore((s) => (edge ? edgeIndexOf(s.edges) : nodeIndexOf(s.nodes)).has(id))
  const ends = useCanvasStore((s) => {
    if (!edge) return null
    const nodes = nodeIndexOf(s.nodes)
    const named = (end?: string) => (end ? (nodes.get(end)?.data?.label as string | undefined) || end : '?')
    return `${named(v.source)} → ${named(v.target)}`
  })
  const name = ends ?? (v.name || v.urn || v.entity_id)
  const open = () => {
    onOpen()
    const canvas = useCanvasStore.getState()
    if (!edge) canvas.openNodeDrawer(id)
    else {
      const line = edgeIndexOf(canvas.edges).get(id)
      if (line) canvas.openEdgeDrawer(targetFromEdge(line))
    }
  }
  return (
    <li className="flex items-start gap-2 min-w-0">
      <div className="min-w-0 flex-1 break-words">
        <span className="font-medium">{name}</span>
        <span className="text-ink-muted"> · {v.type} · </span>
        {v.reason}
      </div>
      {onCanvas ? (
        <button
          type="button"
          onClick={open}
          aria-label={`Open ${name}`}
          className="shrink-0 px-1.5 h-5 rounded text-[10.5px] font-semibold text-accent-lineage hover:bg-accent-lineage/10"
        >
          Open
        </button>
      ) : (
        <CopyButton value={id} label={`Copy the id of ${name}`} className="shrink-0" />
      )}
    </li>
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
