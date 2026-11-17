/**
 * PrDetailDrawer — the review surface for one PR: overview + reviewers/approval, the
 * Files Changed (a change list read a page at a time, at any size), a derived activity timeline, and the
 * Approve / Merge / Close actions. Merge is conflict-aware: a conflict opens the
 * ConflictResolver, whose resolutions feed straight back into a re-merge.
 *
 * A fork's review merges into the fork's parent: only up to date with it (a fork behind it is
 * offered Update from parent, not a draft's Pull latest), by a job when it is large — `merging`
 * until the job ends, which the drawer shows in progress — and, merged, the drawer stays on it:
 * there is no view to go back to. While forks are off it can't be approved or merged.
 *
 * Mounted only while a PR is selected (fresh queries per prId).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  X, GitMerge, GitBranch, User, Clock, CheckCircle2, XCircle, Loader2, FileDiff, ShieldCheck,
  GitPullRequestArrow, Pencil, Check, ArrowDownToLine, ArrowUpRight, AlertTriangle, GitCommitHorizontal,
  Undo2, ShieldAlert, LayoutTemplate, MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { Badge } from '@/components/ui/Badge'
import { timeAgo } from '@/lib/timeAgo'
import {
  ForkNotUpToDateError, HeadMovedError, MergeConflictError, NotUpToDateError, ReviewDecisionError, type PullReason,
  type IncomingChanges, type ResolutionMap,
} from '@/services/versioningApiService'
import {
  useMergeRequest, usePullLatestDraft, useCommitLog,
  useApproveMergeRequest, useCloseMergeRequest, useMergeMergeRequest, useUpdateMergeRequest,
  useBranchViewChanges, useChangeSummary, usePrDiffSummary, VERSIONING_KEYS,
} from '../../versioning/hooks/useVersioning'
import { DraftViewChanges } from '../../versioning/components/DraftViewChanges'
import { fromChangeCounts } from '../../versioning/model/changeAdapters'
import { ChangeCountChips } from '../../versioning/components/ChangesPanel'
import { ChangeList } from '../../versioning/components/ChangeList'
import { ChangeTreePanel } from '../../versioning/components/ChangeTreePanel'
import { getChangeEntry, getMergeRequestDiffChildren, type ChangeListOrigin } from '@/services/versioningApiService'
import { mapWithConcurrency } from '@/lib/concurrency'
import { isDeleteModify, normalizeConflict } from '../conflictResolution'
import { useQueryClient } from '@tanstack/react-query'
import { CommitRow } from '../../versioning/components/CommitRow'
import { RevertDialog } from '../../versioning/components/RollbackDialogs'
import { IncomingChangesSheet } from '../../versioning/components/IncomingChangesSheet'
import { ForksOffNote } from '../../versioning/components/ForkStatusBits'
import { UpdateFromParentButton } from '../../versioning/components/UpdateFromParentButton'
import { ownerName } from '../../versioning/model/branchVocab'
import { isTerminalPr } from '../../versioning/model/prStatus'
import { usePermission, useAuthStore } from '@/store/auth'
import { useFeature } from '@/store/features'
import { useBranchStore } from '@/store/branchStore'
import { usePublishReceiptStore } from '@/store/publishReceiptStore'
import { useUnsavedCountOnBranch } from '@/store/stagedChangesStore'
import { useAppNotifications } from '@/components/ui/notifications'
import { PrStatusBadge, ApprovalPill, PrKindIcon, derivePrTitle, isDraftMr } from './PrMeta'
import { ConflictResolver } from './ConflictResolver'
import { MOTION } from '@/lib/motion'
import { refusalCopy } from '@/features/versioning/model/provenance'
import { ReviewDiscussion } from '../comments/ReviewDiscussion'
import { useReviewCommentCounts } from '../comments/useReviewComments'
import type { DiscussionAccess } from '../comments/ReviewThreads'
import { DECISION_KEYS, useDecideChanges, useReviewDecisionSummary } from '../decisions/useReviewDecisions'

/** " by 3 changes people made" — what holds a draft's review back from main; people's changes
 *  are what make it pull, so they are what it counts when the server says. */
function behindText(pr: { behindBy?: number | null; behindByPeople?: number | null }): string {
  const people = pr.behindByPeople ?? 0
  if (people > 0) return ` by ${people} change${people === 1 ? '' : 's'} people made`
  const n = pr.behindBy ?? 0
  return n > 0 ? ` by ${n} commit${n === 1 ? '' : 's'}` : ''
}

function Section({ icon: Icon, title, right, children }: {
  icon: React.ComponentType<{ className?: string }>; title: string; right?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wider">
          <Icon className="w-3.5 h-3.5" /> {title}
        </h4>
        {right}
      </div>
      {children}
    </section>
  )
}

/** Why the reader may not merge a review, by the server's reason code (`viewerCan.mergeReason`). */
const MERGE_REFUSALS: Record<string, string> = {
  publish_required: 'Merging into main needs the publish permission on this workspace',
  manage_required: 'Merging needs edit access to this data source',
  self_merge: 'This data source has someone other than whoever opened a review merge it',
}

/** Why the reader may not take part in the discussion (`viewerCan.commentReason`). */
const COMMENT_REFUSALS: Record<string, string> = {
  person_required: 'A key can’t take part in a review’s discussion — sign in as a person to comment.',
}

export function PrDetailDrawer({ wsId, prId, onClose, focusThreadId }: {
  wsId: string; prId: string; onClose: () => void
  /** A thread to open on (a notification's link). */
  focusThreadId?: string | null
}) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { notify } = useAppNotifications()
  const canManage = usePermission('workspace:datasource:manage', wsId)
  // Merging, and reverting a merge, advance main: that needs publish as well.
  const canPublish = usePermission('workspace:datasource:publish', wsId)
  const user = useAuthStore((s) => s.user)
  const switchToMain = useBranchStore((s) => s.switchToMain)
  const setReceipt = usePublishReceiptStore((s) => s.setReceipt)

  const prQ = useMergeRequest(wsId, prId)
  const approve = useApproveMergeRequest(wsId)
  const closePr = useCloseMergeRequest(wsId)
  const merge = useMergeMergeRequest(wsId)
  const update = useUpdateMergeRequest(wsId)
  const pullLatest = usePullLatestDraft(wsId, prQ.data?.graphId ?? '')

  const pr = prQ.data
  // What the review changes, read from the change index a page at a time — never the whole diff on
  // open, which for a 100,000-change review is tens of megabytes. A draft's review: its own change
  // list (once merged, main across its merge). A fork's: its summary (counted, and listed from the
  // window it names, once past the tree's cap).
  const draftReview = !!pr && isDraftMr(pr)
  const listOrigin: ChangeListOrigin | null = !pr || !draftReview ? null
    : pr.status === 'merged' && pr.resultingCommitSeq
      ? { fromSeq: pr.resultingCommitSeq - 1, toSeq: pr.resultingCommitSeq }
      : { branchId: pr.sourceBranchId }
  const draftSummaryQ = useChangeSummary(wsId, draftReview ? pr!.graphId : null, listOrigin)
  const forkSummaryQ = usePrDiffSummary(wsId, pr && !draftReview ? prId : null, 1000)
  const changeCounts = draftReview ? draftSummaryQ.data?.counts : forkSummaryQ.data?.counts
  const changeSet = useMemo(() => (changeCounts ? fromChangeCounts(changeCounts) : null), [changeCounts])
  const changesFetching = draftSummaryQ.isFetching || forkSummaryQ.isFetching
  // Approve sends the head the PR was read at, so the changes on screen must be of that head: when a
  // poll brings a new one, read them again (Approve waits for it).
  const queryClient = useQueryClient()
  const diffHead = useRef(pr?.headCommitId)
  useEffect(() => {
    if (pr?.headCommitId === diffHead.current) return
    if (diffHead.current !== undefined) {
      if (pr && listOrigin) void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.changeList(wsId, pr.graphId, listOrigin) })
      void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.prDiffSummary(wsId, prId) })
    }
    diffHead.current = pr?.headCommitId
  }, [pr?.headCommitId]) // eslint-disable-line react-hooks/exhaustive-deps
  // Edits still staged on the canvas for this draft are not part of it: a merge would leave them behind.
  const unsaved = useUnsavedCountOnBranch(pr?.sourceBranchId)

  // Pre-merge: the draft's individual commits (each with its author), expandable to per-commit diffs.
  // Draft MRs only — a fork PR's source branch lives on another graph (legacy), so leave it disabled.
  // Reviewers/managers are authorised to read these by the backend's PR-participant rule.
  const isDraftPr = !!pr && isDraftMr(pr)
  const commitsQ = useCommitLog(wsId, isDraftPr ? pr!.graphId : null, pr?.sourceBranchId ?? null)
  const commits = (commitsQ.data?.commits ?? []) as Array<Record<string, unknown>>
  // Views the draft creates or changes go live when it merges: reviewers see them beside the data.
  const viewChangesQ = useBranchViewChanges(wsId, isDraftPr ? pr!.graphId : null, pr?.sourceBranchId ?? null)
  const viewChanges = viewChangesQ.data
  const viewChangeCount = (viewChanges?.views.length ?? 0) + (viewChanges?.hidden ?? 0)
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
  const toggleCommit = (id: string) => setExpandedCommit((p) => (p === id ? null : id))

  // In-place title/description editing (managers).
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const startEdit = () => {
    setEditTitle(pr?.title ?? '')
    setEditDesc(pr?.description ?? '')
    setEditing(true)
  }
  const saveEdit = () => {
    if (!pr) return
    update.mutate(
      { prId, graphId: pr.graphId, title: editTitle, description: editDesc },
      {
        onSuccess: () => { setEditing(false); notify('success', 'Updated.') },
        onError: (e) => notify('error', (e as Error).message),
      },
    )
  }
  const [conflicts, setConflicts] = useState<Array<Record<string, unknown>> | null>(null)
  // What each conflict resolution starts from — the conflicting entity's own value on the draft.
  // It comes with the conflicts (a merge's 409, a pull's answer); any it left out is read on its
  // own, a few at a time — never the review's whole diff (tens of megabytes at 100,000 changes).
  const [givenSeeds, setGivenSeeds] = useState<Record<string, Record<string, unknown> | undefined>>({})
  const missingSeeds = useMemo(() => {
    if (!conflicts) return []
    const out = new Set<string>()
    for (const c of conflicts.map((x) => normalizeConflict(x))) {
      if (c.entity_id && !isDeleteModify(c) && !givenSeeds[c.entity_id]) out.add(c.entity_id)
    }
    return [...out]
  }, [conflicts, givenSeeds])
  const [readSeeds, setReadSeeds] = useState<{ key: string; seeds: Record<string, Record<string, unknown> | undefined>; failed: boolean }>(
    { key: '', seeds: {}, failed: false })
  const missingKey = missingSeeds.join('\n')
  useEffect(() => {
    if (!pr || !listOrigin || missingSeeds.length === 0) return
    let gone = false
    void mapWithConcurrency(missingSeeds, 6, (id) => getChangeEntry(wsId, pr.graphId, listOrigin, id)).then((results) => {
      if (gone) return
      const out: Record<string, Record<string, unknown> | undefined> = {}
      let failed = false
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') out[missingSeeds[i]] = (r.value.after ?? undefined) as Record<string, unknown> | undefined
        else failed = true
      })
      setReadSeeds({ key: missingKey, seeds: out, failed })
    })
    return () => { gone = true }
  }, [missingKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const seeds = useMemo(
    () => (readSeeds.key === missingKey ? { ...readSeeds.seeds, ...givenSeeds } : givenSeeds),
    [readSeeds, missingKey, givenSeeds],
  )
  const seedError = readSeeds.key === missingKey && readSeeds.failed
    ? 'Couldn’t read every conflicting entity — close this and merge again.' : null
  const [resolverError, setResolverError] = useState<string | null>(null)
  const [needsPull, setNeedsPull] = useState(false)
  // Why it must pull, once a merge was refused for it (the list's `pullRequired` says only whether).
  const [pullReason, setPullReason] = useState<PullReason | null>(null)
  const [resolveMode, setResolveMode] = useState<'merge' | 'pull'>('merge')
  /** What a pull brought in — reviewed, not just asserted. */
  const [incoming, setIncoming] = useState<IncomingChanges | null>(null)
  const [dismissing, setDismissing] = useState(false)
  // "Revert this merge" (merged PRs): the merge's squash commit is revertable
  // like any other main revision — the dialog owns the confirm + conflict UX.
  const versioningEnabled = useFeature('versioningEnabled')
  const [reverting, setReverting] = useState(false)
  // A fork's review merges into its parent, the review's target graph (a draft's, into its own).
  const forkReview = !!pr && !isDraftMr(pr)
  const forksOn = useFeature('forksEnabled')
  const forksOff = forkReview && !forksOn
  // Merged by a job: nothing changes it until the job lands it or hands it back.
  const merging = pr?.status === 'merging'
  /** A fork behind its parent, as its merge said: how far (it merges only up to date). */
  const [forkBehind, setForkBehind] = useState<number | null>(null)

  const terminal = isTerminalPr(pr?.status)
  // Who may approve and merge is the server's word (`viewerCan`): whoever opened a review approves
  // or merges it where its data source's policy lets them. Without it, its author and its draft's
  // owner are not offered Approve.
  const viewerCan = pr?.viewerCan
  const isAuthor = !!user && pr?.actor === user.id
  const isOwner = !!user && pr?.sourceBranchOwner === user.id
  const alreadyApproved = !!user && (pr?.approvedBy ?? []).includes(user.id)
  const hasReviewers = (pr?.reviewers?.length ?? 0) > 0
  // Approve is asked of the requested reviewers. An approval gone stale is not in approvedBy, so
  // its reviewer is offered Approve again.
  const isRequested = !!user && (pr?.reviewers ?? []).includes(user.id)
  const showApprove = canManage && !terminal && !alreadyApproved && isRequested && !forksOff
    && (viewerCan ? viewerCan.approve : !isAuthor && !isOwner)
  const canMerge = viewerCan ? viewerCan.merge : canPublish
  const mergeBlockedWhy = MERGE_REFUSALS[viewerCan?.mergeReason ?? (canPublish ? '' : 'publish_required')]
  // Whoever sees a review discusses it (a person, not a key); a manager may remove what others wrote.
  const discussion: DiscussionAccess = {
    canComment: viewerCan?.comment ?? true,
    commentReason: viewerCan?.commentReason ? (COMMENT_REFUSALS[viewerCan.commentReason] ?? null) : null,
    canModerate: viewerCan?.moderate ?? canManage,
  }
  const openThreads = useReviewCommentCounts(wsId, prId).data?.open ?? 0
  // A draft's review, decided change by change: Merge accepted lands what is accepted and leaves
  // the rest on the draft; with anything rejected, it is the only merge there is.
  const deciding = draftReview && !terminal && !merging
  const decisions = useReviewDecisionSummary(wsId, prId, deciding).data
  const acceptMissing = useDecideChanges(wsId, prId)
  const accepted = decisions?.accepted ?? 0
  const rejected = decisions?.rejected ?? 0
  const mergeInPart = deciding && !!decisions && (rejected > 0 || (accepted > 0 && accepted < decisions.total))
  const busy = approve.isPending || closePr.isPending || merge.isPending || pullLatest.isPending

  // Proactive gate: the server flags a draft MR that lags main head. Mirror it into needsPull so the
  // banner + Pull-latest show up front (the 409 catch in runMerge is the backstop). A clean pull
  // clears it and invalidates this PR, so pr.behind flips false and keeps it cleared.
  // Only people's commits make a pull a must (pullRequired); automation alone is merged past.
  const mustPull = pr?.pullRequired ?? pr?.behind
  useEffect(() => { setNeedsPull(!terminal && !!mustPull) }, [mustPull, terminal])

  const runMerge = async (resolutions?: ResolutionMap, mode: 'all' | 'accepted' = 'all') => {
    if (!pr || unsaved > 0) return
    try {
      const res = await merge.mutateAsync({
        prId, graphId: pr.targetGraphId, message: `Merge: ${derivePrTitle(pr)}`, resolutions, mode,
      })
      if (mode === 'accepted' && accepted < (decisions?.total ?? 0)) {
        // Merged in part: the draft stays open with the rest, and this review reads as merged.
        notify('success', `Merged ${accepted.toLocaleString()} accepted change${accepted === 1 ? '' : 's'} into main. The rest stay on the draft.`)
        void prQ.refetch()
        return
      }
      setConflicts(null)
      setResolverError(null)
      setForkBehind(null)
      // The receipt is the confirmation, and it survives the navigation below — a notification would not.
      // It is the graph's the merge landed in: a fork's parent, for a fork's review.
      setReceipt({
        commitId: res.commitId, outcome: res.outcome, graphId: pr.targetGraphId,
        counts: changeSet?.counts ?? { added: 0, modified: 0, removed: 0 }, via: 'review',
      })
      // A fork's review has no view to go back to, and its fork lives on: the drawer stays, and
      // reads as merged once the review is read again.
      if (forkReview) return
      // Land on the freshly-merged main; read-your-writes serves main even before the projection
      // catches up. The source branch is now `merged`, so useActiveBranchGuard would evict anyone
      // sitting on it anyway — this just gets there first for the person who pressed the button.
      switchToMain()
      onClose()
      // Merging from the workspace Reviews inbox used to be a dead end: the branch store was mutated
      // with no canvas mounted and no way back to the work. Return to the view the draft came from,
      // where the receipt banner is waiting.
      if (pr.originatingViewId && !pathname.startsWith(`/views/${pr.originatingViewId}`)) {
        navigate(`/views/${pr.originatingViewId}`)
      }
    } catch (e) {
      // A fork's merge that ran as a job hands the review back when it is refused: read it again.
      if (forkReview) void prQ.refetch()
      if (e instanceof ForkNotUpToDateError) {
        setForkBehind(e.behind ?? 0)
        return
      }
      if (e instanceof NotUpToDateError) {
        setNeedsPull(true)
        setPullReason(e.reason ?? 'people')
        notify('error', refusalCopy(e.reason))
        return
      }
      if (e instanceof ReviewDecisionError) {
        // Decisions moved under the merge (an edit made one stale, say): read them again.
        void queryClient.invalidateQueries({ queryKey: DECISION_KEYS.all(wsId, prId) })
        notify('error', e.message)
        return
      }
      if (e instanceof MergeConflictError) {
        setGivenSeeds(e.seeds)
        setConflicts(e.conflicts)
        setResolverError(resolutions ? 'Some fields still conflict — adjust and retry.' : null)
        return
      }
      const msg = (e as Error).message
      const friendly = /approval_required/i.test(msg)
        ? 'This PR needs approval from its reviewers before it can be merged.'
        : msg
      if (resolutions) setResolverError(friendly)
      else notify('error', friendly)
    }
  }

  const runPull = (resolutions?: ResolutionMap) => {
    if (!pr) return
    pullLatest.mutate(
      { branchId: pr.sourceBranchId, resolutions },
      {
        onSuccess: (res) => {
          if (!res.clean) {
            setResolveMode('pull')
            setGivenSeeds(Object.fromEntries(Object.entries(res.seeds ?? {}).map(([k, v]) => [k, v ?? undefined])))
            setConflicts(res.conflicts)
            setResolverError(resolutions ? 'Some fields still conflict — adjust and retry.' : null)
            return
          }
          setConflicts(null); setResolverError(null); setResolveMode('merge'); setNeedsPull(false)
          // A reviewer pulling before merge is taking in work that changes what THIS PR will land —
          // so show it. Merging blind was the thing that made "someone beat me to it" opaque.
          if (res.incoming && res.incoming.commitCount > 0) {
            setIncoming(res.incoming)
          } else {
            notify('info', 'Already up to date — you can merge now.')
          }
        },
        onError: (e) => notify('error', (e as Error).message),
      },
    )
  }

  const events = useMemo(() => {
    type Ev = { Icon: React.ComponentType<{ className?: string }>; text: string; time?: string; tint: string }
    if (!pr) return [] as Ev[]
    const evs: Ev[] = [{ Icon: GitPullRequestArrow, text: `Opened by ${ownerName(pr.actor, pr.userNames)}`, time: pr.createdAt, tint: 'bg-accent-lineage' }]
    for (const a of pr.approvedBy ?? []) evs.push({ Icon: CheckCircle2, text: `Approved by ${ownerName(a, pr.userNames)}`, time: pr.updatedAt, tint: 'bg-emerald-500' })
    if (pr.status === 'merged') {
      // A `direct_publish` merge means someone published the source branch straight to Published,
      // which lands exactly what this review proposed and so resolves it — but WITHOUT the reviewers
      // ever seeing it. Say that, rather than presenting a bypassed review as a reviewed merge.
      const bypassed = pr.mergedVia === 'direct_publish'
      const who = ownerName(pr.mergedBy, pr.userNames)
      const sha = pr.resultingCommitId ? ` · ${pr.resultingCommitId.slice(0, 8)}` : ''
      evs.push({
        Icon: bypassed ? ShieldAlert : GitMerge,
        text: bypassed
          ? `Published directly by ${who}, bypassing this review${sha}`
          : pr.mergedVia === 'review_partial'
            ? `What was accepted merged by ${who}${sha}; the rest stayed on the draft`
            : `Merged by ${who}${sha}`,
        time: pr.mergedAt ?? pr.updatedAt,
        tint: bypassed ? 'bg-amber-500' : 'bg-violet-500',
      })
    }
    if (pr.status === 'closed') evs.push({ Icon: XCircle, text: `Closed by ${ownerName(pr.closedBy, pr.userNames)}`, time: pr.closedAt ?? pr.updatedAt, tint: 'bg-ink-muted' })
    return evs
  }, [pr])

  return createPortal(
    <>
      <Backdrop open={true} onClick={onClose} zClassName="z-[60]" className="bg-black/40" />
      {/* Entrance-only, and no <AnimatePresence>: the drawer is mounted only
          while a review is open, so its presence tree unmounted with it and the
          `exit` never ran. A viewport-height panel sitting inside a presence
          tree is the shape that strands a click-blocker in the body when an
          exit is interrupted; without one there is nothing to strand. */}
      <motion.aside
        className="fixed right-0 top-0 h-full w-[520px] max-w-[92vw] z-[61] bg-canvas border-l border-glass-border flex flex-col shadow-lg"
        initial={{ x: 520 }} animate={{ x: 0 }} transition={MOTION.drawerSlide}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4 border-b border-glass-border/60">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] shrink-0">
                {pr ? <PrKindIcon pr={pr} className="w-4 h-4 text-ink-muted" /> : <FileDiff className="w-4 h-4 text-ink-muted" />}
              </span>
              {pr && <PrStatusBadge status={pr.status} />}
              {pr && <ApprovalPill pr={pr} />}
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <h2 className="text-base font-bold text-ink leading-tight truncate">{pr ? derivePrTitle(pr) : 'Loading…'}</h2>
              {pr && canManage && !editing && (
                <button
                  onClick={startEdit}
                  title="Edit title & description"
                  className="p-1 rounded-md text-ink-muted/60 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] shrink-0"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-5 space-y-6">
          {prQ.isLoading && (
            <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading review…
            </div>
          )}

          {pr && (
            <>
              {editing && (
                <div className="rounded-xl border border-accent-lineage/30 bg-accent-lineage/[0.05] p-3 space-y-2.5">
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Title</label>
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      autoFocus
                      placeholder="A short summary…"
                      className="w-full rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Description</label>
                    <textarea
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      rows={4}
                      placeholder="Context for reviewers…"
                      className="w-full rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40 resize-none"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-lg text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                      Cancel
                    </button>
                    <button
                      onClick={saveEdit}
                      disabled={update.isPending}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
                    >
                      {update.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      Save
                    </button>
                  </div>
                </div>
              )}

              {!editing && pr.description && pr.description.trim() && (
                <Section icon={FileDiff} title="Description">
                  <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{pr.description.trim()}</p>
                </Section>
              )}

              <Section icon={GitBranch} title="Overview">
                <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-3 space-y-2 text-sm">
                  <div className="flex items-center gap-2 text-ink flex-wrap">
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-accent-lineage/10 text-accent-lineage font-medium text-[12px]">
                      <GitBranch className="w-3.5 h-3.5" />
                      {pr.sourceBranchName || (isDraftMr(pr) ? 'this draft' : (pr.sourceBranchId?.slice(0, 12) ?? 'fork'))}
                    </span>
                    <span className="text-ink-muted text-[13px]">→</span>
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-ink/[0.06] text-ink font-medium text-[12px]">
                      <GitBranch className="w-3.5 h-3.5" /> {pr.targetBranch}
                    </span>
                  </div>
                  <p className="text-[12px] text-ink-muted flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5" /> {ownerName(pr.actor, pr.userNames)}
                    <span>·</span>
                    <Clock className="w-3.5 h-3.5" /> opened {timeAgo(pr.createdAt)}
                  </p>
                  {pr.sourceBranchOwner && (
                    <p className="text-[12px] text-ink-muted flex items-center gap-1.5">
                      <GitBranch className="w-3.5 h-3.5" /> Draft owner: <span className="text-ink">{ownerName(pr.sourceBranchOwner, pr.userNames)}</span>
                    </p>
                  )}
                  {hasReviewers && (
                    <p className="text-[12px] text-ink-muted flex items-center gap-1.5 flex-wrap">
                      <ShieldCheck className="w-3.5 h-3.5" /> Reviewers:
                      {pr.reviewers!.map((r) => {
                        const who = ownerName(r, pr.userNames)
                        if ((pr.approvedBy ?? []).includes(r)) {
                          return <Badge key={r} tone="success" size="md" title={`${who} approved`}>{who} ✓</Badge>
                        }
                        if ((pr.staleApprovedBy ?? []).includes(r)) {
                          return (
                            <Badge key={r} tone="warning" size="md" title={`${who} approved an earlier version and must approve again`}>
                              {who} · stale
                            </Badge>
                          )
                        }
                        return <Badge key={r} size="md" title={`${who} has not approved yet`}>{who}</Badge>
                      })}
                    </p>
                  )}
                </div>
                {/* Prominent, easy-to-find entry to browse the branch's actual changes on the canvas. */}
                {pr.originatingViewId && (
                  <button
                    onClick={() => { onClose(); navigate(`/views/${pr.originatingViewId}?branch=${pr.sourceBranchId}`) }}
                    className="mt-2.5 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold text-accent-lineage border border-accent-lineage/30 bg-accent-lineage/[0.06] hover:bg-accent-lineage/[0.12] hover:border-accent-lineage/50 transition-colors"
                    title="Open this branch in the canvas to browse and review its changes in context"
                  >
                    <ArrowUpRight className="w-4 h-4" /> Browse this branch’s changes
                  </button>
                )}
              </Section>

              {isDraftPr && (
                <Section icon={GitCommitHorizontal}
                  title={`Changes${commits.length ? ` (${commits.length})` : ''}`}
                  right={commits.length > 0 && <span className="text-[10px] text-ink-muted/70 normal-case font-normal">each is one recorded edit</span>}
                >
                  {commitsQ.isLoading ? (
                    <div className="flex items-center gap-2 text-[12px] text-ink-muted py-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading changes…
                    </div>
                  ) : commits.length === 0 ? (
                    <p className="text-[12px] text-ink-muted py-1">No changes on this draft yet.</p>
                  ) : (
                    <ol className="relative ml-1.5 border-l border-glass-border space-y-3.5 pl-4">
                      {commits.map((c, i) => {
                        const cid = (c.commit_id as string) ?? String(i)
                        return (
                          <CommitRow
                            key={cid}
                            commit={c}
                            wsId={wsId}
                            graphId={pr.graphId}
                            userNames={commitsQ.data?.userNames}
                            expanded={expandedCommit === cid}
                            onToggle={toggleCommit}
                          />
                        )
                      })}
                    </ol>
                  )}
                </Section>
              )}

              {pr.status === 'conflicts' && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 text-[12px] text-amber-700 dark:text-amber-400">
                  The target has moved — this PR has conflicts. Resolve them when you merge.
                </div>
              )}

              {viewChanges && viewChangeCount > 0 && pr.sourceBranchId && (
                <Section icon={LayoutTemplate} title={`Views (${viewChangeCount})`}
                  right={<span className="text-[10px] normal-case font-normal">go live when this merges</span>}>
                  <DraftViewChanges changes={viewChanges} branchId={pr.sourceBranchId} onNavigate={onClose} />
                </Section>
              )}

              <Section icon={FileDiff} title="Files changed" right={changeSet ? <ChangeCountChips changeSet={changeSet} /> : undefined}>
                {[draftSummaryQ.error, forkSummaryQ.error].some((e) => (e as { status?: number } | null)?.status === 410) ? (
                  <p className="text-xs text-ink-muted py-3">
                    This review was closed, and its draft’s changes were removed after the retention period, so what
                    it proposed can no longer be shown.
                  </p>
                ) : draftReview && listOrigin ? (
                  // The draft's own changes, listed a page at a time from its change index — exactly
                  // what merging changes once it is up to date. Merged, what its merge changed: main
                  // across its commit, which outlives the draft's own rows.
                  <>
                    {pr.behind && pr.status !== 'merged' && (
                      <p className="text-[11.5px] text-ink-muted mb-2 leading-relaxed">
                        What this draft changes where it branched off. Once it pulls the latest from{' '}
                        <strong>main</strong>, this is exactly what merging it changes.
                      </p>
                    )}
                    {pr.mergedVia === 'review_partial' && (
                      <p className="text-[11.5px] text-ink-muted mb-2 leading-relaxed">
                        Merged in part: these are the changes its review accepted. The rest stayed on the
                        draft, for another review.
                      </p>
                    )}
                    <ChangeList wsId={wsId} graphId={pr.graphId} origin={listOrigin} summary={draftSummaryQ.data}
                      emptyHint="No changes in this PR."
                      review={{
                        prId, ...discussion,
                        decisions: deciding ? {
                          canDecide: !!viewerCan?.decide, headCommitId: pr.headCommitId, summary: decisions, names: pr.userNames ?? undefined,
                        } : undefined,
                      }} />
                  </>
                ) : (
                  // A fork's review: laid out as a tree within the cap; past it, counted and listed from
                  // the window of the fork's main its changes are in.
                  <ChangeTreePanel
                    summary={forkSummaryQ.data}
                    isLoading={forkSummaryQ.isLoading}
                    error={forkSummaryQ.error}
                    onRetry={() => void forkSummaryQ.refetch()}
                    fetchChildren={(key, offset) => getMergeRequestDiffChildren(wsId, prId, key, { offset, limit: 50 })}
                    origin={{ source: 'pr', prId }}
                    emptyHint="No changes in this PR."
                    summaryFirst
                    list={forkSummaryQ.data?.list ? {
                      wsId, graphId: forkSummaryQ.data.list.graphId,
                      origin: { fromSeq: forkSummaryQ.data.list.fromSeq, toSeq: forkSummaryQ.data.list.toSeq },
                    } : undefined}
                  />
                )}
              </Section>

              <Section icon={MessageSquare} title="Discussion"
                right={openThreads > 0 ? <span className="text-[10.5px] font-semibold text-accent-lineage tabular-nums">{openThreads.toLocaleString()} open</span> : undefined}>
                <ReviewDiscussion wsId={wsId} prId={prId} graphId={pr.graphId} origin={listOrigin}
                  access={discussion} focusThreadId={focusThreadId} />
              </Section>

              <Section icon={Clock} title="Activity">
                <ol className="relative ml-1.5 border-l border-glass-border space-y-3 pl-4">
                  {events.map((ev, i) => (
                    <li key={i} className="relative">
                      <span className={cn('absolute -left-[1.36rem] top-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-canvas-elevated', ev.tint)} />
                      <p className="text-sm text-ink leading-tight flex items-center gap-1.5">
                        <ev.Icon className="w-3.5 h-3.5 text-ink-muted" /> {ev.text}
                      </p>
                      {ev.time && <p className="text-[11px] text-ink-muted mt-0.5">{timeAgo(ev.time)}</p>}
                    </li>
                  ))}
                </ol>
              </Section>
            </>
          )}
        </div>

        {pr && !terminal && needsPull && (
          <div className="mx-5 mb-1 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              {pullReason === 'overlap'
                ? <>Automation changed something this draft changes since it started. Pull the latest changes to see what it changed (resolving any conflicts) before it can be merged.</>
                : <>This draft is behind <strong>main</strong>{behindText(pr)}. Pull the latest changes (resolving any conflicts) before it can be merged.</>}
            </span>
          </div>
        )}

        {pr && merging && (
          <div role="status" className="mx-5 mb-1 flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-600 dark:text-violet-400 text-xs">
            <Loader2 className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin" />
            <span>Merging in the background: a review this large merges as a job. Nothing can change it meanwhile; this shows how it ends once it has.</span>
          </div>
        )}

        {pr && !terminal && forkBehind !== null && (
          <div className="mx-5 mb-1 flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 min-w-0">
              This fork is behind its parent{forkBehind > 0 ? ` by ${forkBehind.toLocaleString()} change${forkBehind === 1 ? '' : 's'}` : ''}.
              Update it from its parent first: it merges only up to date.
            </span>
            {forksOn && canPublish && (
              <UpdateFromParentButton wsId={wsId} forkGraphId={pr.graphId} onUpdated={() => setForkBehind(null)} />
            )}
          </div>
        )}

        {pr && !terminal && forksOff && <ForksOffNote className="mx-5 mb-1 px-1" />}

        {pr && !terminal && unsaved > 0 && (
          <div className="mx-5 mb-1 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>You have {unsaved} unsaved edit{unsaved === 1 ? '' : 's'} on this draft. Save or discard {unsaved === 1 ? 'it' : 'them'} on the canvas before merging; a merge would leave {unsaved === 1 ? 'it' : 'them'} behind.</span>
          </div>
        )}

        {/* Where the review's decisions stand, and what Merge accepted still needs. */}
        {pr && mergeInPart && decisions && (
          <div className="mx-5 mb-1 space-y-1.5">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-muted tabular-nums">
              <span><span className="font-semibold text-emerald-700 dark:text-emerald-300">{accepted.toLocaleString()}</span> accepted</span>
              <span><span className="font-semibold text-rose-700 dark:text-rose-300">{rejected.toLocaleString()}</span> rejected</span>
              <span><span className="font-semibold text-ink">{decisions.undecided.toLocaleString()}</span> to decide</span>
              {decisions.stale > 0 && <span className="text-amber-700 dark:text-amber-300">{decisions.stale.toLocaleString()} changed since</span>}
              <span className="ml-auto">Only what is accepted merges; the rest stays on the draft.</span>
            </p>
            {decisions.missing > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 min-w-0">
                  {decisions.missing.toLocaleString()} change{decisions.missing === 1 ? '' : 's'} the accepted ones need {decisions.missing === 1 ? 'isn’t' : 'aren’t'} accepted
                  {decisions.stale > 0 ? ' (some changed since they were decided)' : ''}.
                </span>
                {viewerCan?.decide && (
                  <button type="button" disabled={acceptMissing.isPending}
                    onClick={() => acceptMissing.mutate({ verdict: 'accepted', entityIds: decisions.missingIds, force: true, expectedHeadCommitId: pr.headCommitId },
                      { onError: (e) => notify('error', (e as Error).message) })}
                    className="inline-flex items-center gap-1 px-2 h-7 rounded-lg font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50">
                    {acceptMissing.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Accept {decisions.missing > decisions.missingIds.length ? `${decisions.missingIds.length} of them` : 'them too'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Action bar — none while a job merges it, which nothing may change meanwhile */}
        {pr && !terminal && canManage && !dismissing && !merging && (
          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center gap-2">
            {showApprove && (
              <button
                onClick={() => approve.mutate({ prId, graphId: pr.graphId, expectedHeadCommitId: pr.headCommitId }, {
                  onSuccess: () => notify('success', 'Approved.'),
                  onError: (e) => {
                    // The draft moved on since this review was loaded: load it again before approving.
                    if (e instanceof HeadMovedError) {
                      void prQ.refetch()
                      if (pr && listOrigin) void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.changeList(wsId, pr.graphId, listOrigin) })
                      void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.prDiffSummary(wsId, prId) })
                    }
                    notify('error', (e as Error).message)
                  },
                })}
                disabled={busy || changesFetching}
                title="Sign off on these changes so they can be merged"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-emerald-600 border border-emerald-500/30 bg-emerald-500/[0.06] hover:bg-emerald-500/10 disabled:opacity-60"
              >
                <CheckCircle2 className="w-4 h-4" /> Approve
              </button>
            )}
            {needsPull ? (
              <button
                onClick={() => runPull()}
                disabled={busy}
                title="This draft is behind main — pull the latest changes before it can merge"
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 shadow-sm disabled:opacity-60"
              >
                {pullLatest.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownToLine className="w-4 h-4" />}
                Pull latest
              </button>
            ) : !forksOff && mergeInPart ? (
              <button
                onClick={() => runMerge(undefined, 'accepted')}
                disabled={busy || unsaved > 0 || !canMerge || accepted === 0 || (decisions?.missing ?? 0) > 0}
                title={!canMerge ? mergeBlockedWhy ?? 'You can’t merge this review'
                  : accepted === 0 ? 'Accept the changes that should merge first'
                    : 'Apply the accepted changes to main; the rest stay on the draft'}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
              >
                {merge.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
                Merge {accepted.toLocaleString()} accepted
              </button>
            ) : !forksOff && (
              <button
                onClick={() => runMerge()}
                disabled={busy || unsaved > 0 || !canMerge}
                title={canMerge ? 'Apply these changes to main' : mergeBlockedWhy ?? 'You can’t merge this review'}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
              >
                {merge.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
                Merge
              </button>
            )}
            <button
              onClick={() => setDismissing(true)}
              disabled={busy}
              title="Reject these changes without merging — nothing is applied to main"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-ink-muted border border-glass-border hover:text-rose-500 hover:border-rose-500/30 disabled:opacity-60"
            >
              <XCircle className="w-4 h-4" /> Dismiss
            </button>
          </div>
        )}

        {/* Dismiss confirmation — plain-language, so it's clear this rejects the changes. */}
        {pr && !terminal && canManage && dismissing && !merging && (
          <div className="px-5 py-4 border-t border-rose-500/25 bg-rose-500/[0.04]">
            <div className="flex items-start gap-2.5 mb-3">
              <XCircle className="w-5 h-5 text-rose-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-[13px] font-semibold text-ink">Dismiss this merge request?</p>
                <p className="text-[12px] text-ink-muted mt-1 leading-relaxed">
                  The proposed changes are <span className="font-medium text-rose-500">rejected</span> and <span className="font-medium text-ink">nothing is applied to <span className="font-mono">main</span></span>. The draft itself is kept, so its author can open a new request or discard it later — but this review closes.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => closePr.mutate({ prId, graphId: pr.graphId }, {
                  onSuccess: () => { notify('success', 'Request dismissed — no changes applied.'); onClose() },
                  onError: (e) => { notify('error', (e as Error).message); setDismissing(false) },
                })}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-500 hover:bg-rose-600 shadow-sm disabled:opacity-60"
              >
                {closePr.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Dismiss request
              </button>
              <button
                onClick={() => setDismissing(false)}
                disabled={busy}
                className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted border border-glass-border hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:opacity-60"
              >
                Keep reviewing
              </button>
            </div>
          </div>
        )}

        {/* Merged terminal state — the one action left is undoing the merge. */}
        {pr && pr.status === 'merged' && canManage && canPublish && versioningEnabled && pr.resultingCommitId && (
          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center justify-between gap-3">
            <p className="text-[12px] text-ink-muted leading-snug">
              Merged the wrong thing? Undo it as a new revision — history is kept.
            </p>
            <button
              onClick={() => setReverting(true)}
              className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-rose-500 border border-rose-500/30 bg-rose-500/[0.06] hover:bg-rose-500/10 transition-colors"
            >
              <Undo2 className="w-4 h-4" /> Revert this merge
            </button>
          </div>
        )}
        {pr && pr.resultingCommitId && (
          <RevertDialog
            open={reverting}
            commit={{
              commit_id: pr.resultingCommitId,
              message: `Merge: ${derivePrTitle(pr)}`,
              kind: 'squash_publish',
              actor: pr.mergedBy ?? pr.actor,
              created_at: pr.mergedAt ?? pr.updatedAt,
              stats: {},
            }}
            wsId={wsId}
            // The merge commit is on the graph the review merged into: a fork's parent.
            graphId={pr.targetGraphId}
            userNames={pr.userNames}
            onClose={() => setReverting(false)}
          />
        )}

        {conflicts && (
          <ConflictResolver
            conflicts={conflicts}
            seeds={seeds}
            seedError={seedError}
            busy={merge.isPending || pullLatest.isPending}
            error={resolverError}
            onCancel={() => { setConflicts(null); setGivenSeeds({}); setResolverError(null); setResolveMode('merge') }}
            onResolve={(resolutions) => (resolveMode === 'pull' ? runPull(resolutions) : runMerge(resolutions))}
          />
        )}

        {incoming && pr && (
          <IncomingChangesSheet
            wsId={wsId}
            graphId={pr.graphId}
            incoming={incoming}
            userNames={pr.userNames}
            onClose={() => setIncoming(null)}
          />
        )}
      </motion.aside>
    </>,
    document.body,
  )
}
