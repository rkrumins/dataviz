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
 * A draft's review can be sent back to its author with why (Send back): it waits until the draft
 * changes, its author told, and the author can take the review's answer in one step — Discard the
 * rejected changes. Merging what is accepted can discard what was rejected too.
 *
 * Mounted only while a PR is selected (fresh queries per prId). What it lets the reader do comes
 * from `useReviewActions`, which the review page shares; Open review goes to that page.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  X, GitMerge, GitBranch, User, Clock, CheckCircle2, XCircle, Loader2, FileDiff, ShieldCheck,
  Pencil, Check, ArrowDownToLine, ArrowUpRight, AlertTriangle, GitCommitHorizontal,
  Undo2, LayoutTemplate, MessageSquare, CornerUpLeft, Trash2, CheckCheck,
} from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { Badge } from '@/components/ui/Badge'
import { HoverTip } from '@/components/ui/HoverTip'
import { timeAgo } from '@/lib/timeAgo'
import { useCommitLog, useBranchViewChanges } from '../../versioning/hooks/useVersioning'
import { DraftViewChanges } from '../../versioning/components/DraftViewChanges'
import { ChangeCountChips } from '../../versioning/components/ChangesPanel'
import { ChangeList } from '../../versioning/components/ChangeList'
import { ChangeTreePanel } from '../../versioning/components/ChangeTreePanel'
import { getMergeRequestDiffChildren } from '@/services/versioningApiService'
import { CommitRow } from '../../versioning/components/CommitRow'
import { RevertDialog } from '../../versioning/components/RollbackDialogs'
import { IncomingChangesSheet } from '../../versioning/components/IncomingChangesSheet'
import { ForksOffNote } from '../../versioning/components/ForkStatusBits'
import { UpdateFromParentButton } from '../../versioning/components/UpdateFromParentButton'
import { ownerName } from '../../versioning/model/branchVocab'
import { useFeature } from '@/store/features'
import { PrStatusBadge, ApprovalPill, PrKindIcon, derivePrTitle, isDraftMr } from './PrMeta'
import { ConflictResolver } from './ConflictResolver'
import { ReviewActivity } from './ReviewActivity'
import { MOTION } from '@/lib/motion'
import { ReviewDiscussion } from '../comments/ReviewDiscussion'
import { useReviewCommentCounts } from '../comments/useReviewComments'
import { useReviewActions } from '../hooks/useReviewActions'
import { behindText, mergeFollowsApproval } from '../page/readiness'

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

export function PrDetailDrawer({ wsId, prId, onClose, focusThreadId }: {
  wsId: string; prId: string; onClose: () => void
  /** A thread to open on (a notification's link). */
  focusThreadId?: string | null
}) {
  const navigate = useNavigate()
  const {
    prQ, pr, user, canManage, canPublish, draftReview, listOrigin, draftSummaryQ, forkSummaryQ, changeSet, changesFetching,
    unsaved, terminal, merging, forksOn, forksOff, viewerCan, isAuthor, isOwner, showApprove, canMerge, mergeBlockedWhy,
    discussion, deciding, decisions, accepted, rejected, mergeInPart, sentBack, canSendBack, busy,
    needsPull, pullReason, forkBehind, clearForkBehind, discardOnMerge, setDiscardOnMerge,
    conflicts, seeds, seedError, resolverError, cancelConflicts, resolveConflicts, incoming, closeIncoming,
    runMerge, runPull, approve, sendBack, withdraw, discardRejected, dismiss, acceptMissing, saveDetails, pending,
    canApproveAll, toDecide, approveAll,
  } = useReviewActions(wsId, prId, onClose)
  /** Sending it back: the form is open, and what it says. */
  const [sendingBack, setSendingBack] = useState(false)
  const [sendBackWhy, setSendBackWhy] = useState('')

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
  const saveEdit = () => saveDetails({ title: editTitle, description: editDesc }, () => setEditing(false))
  const [dismissing, setDismissing] = useState(false)
  // "Revert this merge" (merged PRs): the merge's squash commit is revertable
  // like any other main revision — the dialog owns the confirm + conflict UX.
  const versioningEnabled = useFeature('versioningEnabled')
  const [reverting, setReverting] = useState(false)
  const openThreads = useReviewCommentCounts(wsId, prId).data?.open ?? 0
  // Approve all: in one go, every change still to decide accepted and the review approved — and
  // merged, where nothing but this approval holds it.
  const allMerges = !!pr && canApproveAll && mergeFollowsApproval(pr, { me: user?.id ?? null, canMerge, needsPull, unsaved, openThreads })
  const offerApproveAll = canApproveAll && !forksOff && (toDecide > 0 || allMerges)
  const hasReviewers = (pr?.reviewers?.length ?? 0) > 0

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
          <div className="flex items-center gap-1 shrink-0">
            <HoverTip label="Open this review on a page of its own" detail="Each change beside the list, and keys to move through them" className="inline-flex">
              <Link to={`/workspaces/${wsId}/reviews/${prId}`} onClick={onClose}
                className="inline-flex items-center gap-1 px-2.5 h-8 rounded-xl text-[12px] font-semibold text-accent-lineage hover:bg-accent-lineage/10">
                Open review <ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
              </Link>
            </HoverTip>
            <button onClick={onClose} className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] shrink-0">
              <X className="w-5 h-5" />
            </button>
          </div>
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
                      disabled={pending.update}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
                    >
                      {pending.update ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
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
                <ReviewActivity pr={pr} />
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
              <UpdateFromParentButton wsId={wsId} forkGraphId={pr.graphId} onUpdated={clearForkBehind} />
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
                  <button type="button" disabled={pending.acceptMissing}
                    onClick={acceptMissing}
                    className="inline-flex items-center gap-1 px-2 h-7 rounded-lg font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50">
                    {pending.acceptMissing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Accept {decisions.missing > decisions.missingIds.length ? `${decisions.missingIds.length} of them` : 'them too'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Sent back for changes: by whom, why, and what lets it merge again. */}
        {pr && sentBack && (
          <div role="status" className="mx-5 mb-1 flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl bg-rose-500/[0.06] border border-rose-500/25">
            <CornerUpLeft className="w-4 h-4 mt-0.5 text-rose-500 shrink-0" aria-hidden />
            <div className="flex-1 min-w-0 text-[12px] leading-snug">
              <p className="font-semibold text-ink">
                Sent back for changes by {ownerName(sentBack.by, pr.userNames)}
                <span className="font-normal text-ink-muted"> · {timeAgo(sentBack.at)}</span>
              </p>
              {sentBack.reason && <p className="mt-0.5 text-ink-secondary break-words">“{sentBack.reason}”</p>}
              <p className="mt-0.5 text-ink-muted">
                {rejected > 0 ? `${rejected.toLocaleString()} change${rejected === 1 ? ' was' : 's were'} rejected. ` : ''}
                It merges once the draft changes{sentBack.by === user?.id ? ', or once you withdraw this' : ''}.
              </p>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1">
              {(isAuthor || isOwner) && rejected > 0 && (
                <button type="button" disabled={busy}
                  onClick={discardRejected}
                  className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 disabled:opacity-50">
                  {pending.discard ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden />}
                  Discard the rejected
                </button>
              )}
              {sentBack.by === user?.id && (
                <button type="button" disabled={busy}
                  onClick={withdraw}
                  className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] disabled:opacity-50">
                  {pending.withdraw && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Withdraw
                </button>
              )}
            </div>
          </div>
        )}

        {/* Merging what is accepted: the rejected ones can leave the draft in the same step. */}
        {pr && mergeInPart && rejected > 0 && canMerge && !sentBack && !needsPull && (
          <label className="mx-5 mb-1 flex items-center gap-2 text-[12px] text-ink-secondary cursor-pointer select-none">
            <input type="checkbox" checked={discardOnMerge} onChange={(e) => setDiscardOnMerge(e.target.checked)}
              className="rounded border-glass-border text-accent-lineage focus:ring-accent-lineage/40" />
            Also discard the {rejected.toLocaleString()} rejected change{rejected === 1 ? '' : 's'} from the draft
            <span className="text-ink-muted">— only what nobody decided stays on it</span>
          </label>
        )}

        {/* Action bar — none while a job merges it, which nothing may change meanwhile */}
        {pr && !terminal && canManage && !dismissing && !merging && (
          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center gap-2">
            {offerApproveAll ? (
              <button
                onClick={() => void approveAll(allMerges)}
                disabled={busy || changesFetching}
                title={allMerges ? 'Accept every change still to decide, approve, and merge into main, in one go'
                  : 'Accept every change still to decide and approve, in one go'}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-700 hover:to-indigo-700 shadow-sm disabled:opacity-60"
              >
                {pending.approveAll || pending.merge ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCheck className="w-4 h-4" />}
                {toDecide > 0 ? 'Approve all' : 'Approve'}{allMerges ? ' & merge' : ''}
              </button>
            ) : showApprove && (
              <button
                onClick={approve}
                disabled={busy || changesFetching}
                title="Sign off on these changes so they can be merged"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-emerald-600 border border-emerald-500/30 bg-emerald-500/[0.06] hover:bg-emerald-500/10 disabled:opacity-60"
              >
                <CheckCircle2 className="w-4 h-4" /> Approve
              </button>
            )}
            {canSendBack && !sendingBack && (
              <button type="button" onClick={() => setSendingBack(true)} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-rose-600 dark:text-rose-300 border border-rose-500/30 bg-rose-500/[0.05] hover:bg-rose-500/10 disabled:opacity-60">
                <CornerUpLeft className="w-4 h-4" aria-hidden /> Send back
              </button>
            )}
            {offerApproveAll && allMerges ? null : needsPull ? (
              <button
                onClick={() => runPull()}
                disabled={busy}
                title="This draft is behind main — pull the latest changes before it can merge"
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 shadow-sm disabled:opacity-60"
              >
                {pending.pull ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownToLine className="w-4 h-4" />}
                Pull latest
              </button>
            ) : !forksOff && mergeInPart ? (
              <button
                onClick={() => runMerge(undefined, 'accepted')}
                disabled={busy || unsaved > 0 || !canMerge || accepted === 0 || (decisions?.missing ?? 0) > 0 || !!sentBack}
                title={!canMerge ? mergeBlockedWhy ?? 'You can’t merge this review'
                  : sentBack ? 'Sent back for changes: it merges once the draft changes'
                  : accepted === 0 ? 'Accept the changes that should merge first'
                    : 'Apply the accepted changes to main; the rest stay on the draft'}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
              >
                {pending.merge ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
                Merge {accepted.toLocaleString()} accepted
              </button>
            ) : !forksOff && (
              <button
                onClick={() => runMerge()}
                disabled={busy || unsaved > 0 || !canMerge || !!sentBack}
                title={!canMerge ? mergeBlockedWhy ?? 'You can’t merge this review'
                  : sentBack ? 'Sent back for changes: it merges once the draft changes' : 'Apply these changes to main'}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
              >
                {pending.merge ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
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

        {/* Send back: why, in the author's words to read — they are told, with a link here. */}
        {pr && sendingBack && canSendBack && (
          <div className="px-5 py-4 border-t border-rose-500/25 bg-rose-500/[0.04]">
            <div className="flex items-start gap-2.5 mb-2.5">
              <CornerUpLeft className="w-5 h-5 text-rose-500 mt-0.5 shrink-0" aria-hidden />
              <div>
                <p className="text-[13px] font-semibold text-ink">Send this back for changes?</p>
                <p className="text-[12px] text-ink-muted mt-1 leading-relaxed">
                  {ownerName(pr.actor, pr.userNames)} is told, with what you say here. It can’t merge until the draft changes
                  {rejected > 0 ? <> — they see the <span className="font-medium text-rose-500">{rejected.toLocaleString()} rejected</span> change{rejected === 1 ? '' : 's'}, each with your reason, and can discard them in one step</> : ''}.
                </p>
              </div>
            </div>
            <label className="block">
              <span className="sr-only">What should change</span>
              <textarea value={sendBackWhy} onChange={(e) => setSendBackWhy(e.target.value)} rows={3} maxLength={2000} autoFocus
                placeholder="What should change, and why?"
                className="w-full rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-rose-500/30" />
            </label>
            <div className="flex items-center gap-2 mt-2.5">
              <button type="button" disabled={busy}
                onClick={() => sendBack(sendBackWhy, () => { setSendingBack(false); setSendBackWhy('') })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-500 hover:bg-rose-600 shadow-sm disabled:opacity-60">
                {pending.sendBack ? <Loader2 className="w-4 h-4 animate-spin" /> : <CornerUpLeft className="w-4 h-4" aria-hidden />} Send back
              </button>
              <button type="button" onClick={() => setSendingBack(false)} disabled={busy}
                className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted border border-glass-border hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:opacity-60">
                Keep reviewing
              </button>
            </div>
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
                onClick={() => dismiss(() => setDismissing(false))}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-500 hover:bg-rose-600 shadow-sm disabled:opacity-60"
              >
                {pending.dismiss ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Dismiss request
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
            busy={pending.merge || pending.pull}
            error={resolverError}
            onCancel={cancelConflicts}
            onResolve={resolveConflicts}
          />
        )}

        {incoming && pr && (
          <IncomingChangesSheet
            wsId={wsId}
            graphId={pr.graphId}
            incoming={incoming}
            userNames={pr.userNames}
            onClose={closeIncoming}
          />
        )}
      </motion.aside>
    </>,
    document.body,
  )
}
