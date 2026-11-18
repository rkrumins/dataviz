/**
 * PrDetailDrawer — a quick peek at one review: where it stands, what it is for, what it still needs
 * (What's next) and, once it may, Merge — with Open review for everything else on the review page
 * (its changes one by one, the discussion, what happened, who reviews it, Dismiss and Revert).
 * Merge is conflict-aware: a conflict opens the ConflictResolver, whose resolutions feed straight
 * back into a re-merge.
 *
 * A fork's review merges into the fork's parent: only up to date with it (a fork behind it is
 * offered Update from parent, not a draft's Pull latest), by a job when it is large — `merging`
 * until the job ends, which What's next says — and, merged, the drawer stays on it: there is no
 * view to go back to. While forks are off it can't be approved or merged.
 *
 * A reviewer gives their verdict on the page: Finish your review opens it there, ready to; Approve
 * all [& merge] is here too. Merging what is accepted can discard what was rejected as well.
 *
 * Mounted only while a PR is selected (fresh queries per prId). What it lets the reader do comes
 * from `useReviewActions` and `readiness`, which the review page shares.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  X, GitBranch, User, Clock, Loader2, FileDiff, Pencil, Check, ArrowUpRight, LayoutTemplate,
} from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { timeAgo } from '@/lib/timeAgo'
import { useBranchViewChanges } from '../../versioning/hooks/useVersioning'
import { DraftViewChanges } from '../../versioning/components/DraftViewChanges'
import { IncomingChangesSheet } from '../../versioning/components/IncomingChangesSheet'
import { UpdateFromParentButton } from '../../versioning/components/UpdateFromParentButton'
import { ownerName } from '../../versioning/model/branchVocab'
import { PrStatusBadge, ApprovalPill, PrKindIcon, derivePrTitle, isDraftMr } from './PrMeta'
import { ConflictResolver } from './ConflictResolver'
import { MOTION } from '@/lib/motion'
import { useReviewCommentCounts } from '../comments/useReviewComments'
import { useReviewActions } from '../hooks/useReviewActions'
import { useViewedChanges } from '../viewed/useViewedChanges'
import { readiness, type ActionKind } from '../page/readiness'
import { WhatsNextPanel } from '../page/ReviewSide'
import { ReviewPrimaryAction } from '../page/ReviewPrimaryAction'

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
  /** A thread a link named (a notification's): Open review opens on it. */
  focusThreadId?: string | null
}) {
  const navigate = useNavigate()
  const actions = useReviewActions(wsId, prId, onClose)
  const {
    prQ, pr, user, canManage, canPublish, draftReview, draftSummaryQ, forkSummaryQ, changeSet, unsaved, terminal,
    forksOn, forksOff, viewerCan, canMerge, mergeBlockedWhy, deciding, decisions, rejected, mergeInPart, sentBack,
    needsPull, pullReason, forkBehind, clearForkBehind, discardOnMerge, setDiscardOnMerge,
    conflicts, seeds, seedError, resolverError, cancelConflicts, resolveConflicts, incoming, closeIncoming,
    runMerge, runPull, discardRejected, acceptMissing, saveDetails, pending, canApproveAll, approveAll,
  } = actions
  const page = `/workspaces/${wsId}/reviews/${prId}`
  const pageOnThread = focusThreadId ? `${page}?thread=${encodeURIComponent(focusThreadId)}` : page
  const openPage = (search = '') => { onClose(); navigate(`${page}${search}`) }

  // Views the draft creates or changes go live when it merges: reviewers see them beside the data.
  const isDraftPr = !!pr && isDraftMr(pr)
  const viewChangesQ = useBranchViewChanges(wsId, isDraftPr ? pr!.graphId : null, pr?.sourceBranchId ?? null)
  const viewChanges = viewChangesQ.data
  const viewChangeCount = (viewChanges?.views.length ?? 0) + (viewChanges?.hidden ?? 0)

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

  // What's next, as the review page says it.
  const openThreads = useReviewCommentCounts(wsId, prId).data?.open ?? 0
  const viewed = useViewedChanges(prId).count()
  const counts = changeSet?.counts
  const total = counts ? counts.added + counts.modified + counts.removed : 0
  const listable = draftReview ? (draftSummaryQ.data?.listed ?? 1) > 0 : !!forkSummaryQ.data?.list
  const ready = pr ? readiness(pr, {
    me: user?.id ?? null, canManage, canFinish: actions.canFinish, canMerge, mergeBlockedWhy, forksOff, forkBehind,
    canUpdateFromParent: forksOn && canPublish, needsPull, pullReason, unsaved, decisions: deciding ? decisions : null,
    mergeInPart, canDecide: !!viewerCan?.decide, canApproveAll, listable, viewed, total, openThreads,
  }) : { items: [], primary: null }
  // A step to another change, or Finish your review, is the page's; the rest is done here.
  const act = (kind: ActionKind) => {
    switch (kind) {
      case 'next_unviewed': case 'next_undecided': case 'next_thread': return openPage()
      case 'finish': return openPage('?finish=1')
      case 'approve_all': return void approveAll(false)
      case 'approve_all_merge': return void approveAll(true)
      case 'merge': return void runMerge()
      case 'merge_accepted': return void runMerge(undefined, 'accepted')
      case 'resolve_conflicts': return void runMerge(undefined, mergeInPart ? 'accepted' : 'all')
      case 'pull': return runPull()
      case 'discard_rejected': return discardRejected()
      case 'accept_missing': return acceptMissing()
      case 'update_from_parent': return // its own button does it
    }
  }

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
                <HoverTip label="Edit its title and description" className="inline-flex shrink-0">
                  <button onClick={startEdit} aria-label="Edit title & description"
                    className="p-1 rounded-md text-ink-muted/60 hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </HoverTip>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <HoverTip label="Open this review on a page of its own" detail="Each change beside the list, the discussion, and what happened" className="inline-flex">
              <Link to={pageOnThread} onClick={onClose}
                className="inline-flex items-center gap-1 px-2.5 h-8 rounded-xl text-[12px] font-semibold text-accent-lineage hover:bg-accent-lineage/10">
                Open review <ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
              </Link>
            </HoverTip>
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] shrink-0">
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
              {focusThreadId && (
                <p className="text-[12px] text-ink-muted">
                  A thread on this review was linked.{' '}
                  <Link to={pageOnThread} onClick={onClose} className="font-semibold text-accent-lineage hover:underline">Open it on the review</Link>
                </p>
              )}

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
                </div>
                {/* Prominent, easy-to-find entry to browse the branch's actual changes on the canvas. */}
                {pr.originatingViewId && (
                  <HoverTip label="Open this branch in the canvas" detail="Browse and review its changes in context" className="flex mt-2.5">
                    <button
                      onClick={() => { onClose(); navigate(`/views/${pr.originatingViewId}?branch=${pr.sourceBranchId}`) }}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold text-accent-lineage border border-accent-lineage/30 bg-accent-lineage/[0.06] hover:bg-accent-lineage/[0.12] hover:border-accent-lineage/50 transition-colors"
                    >
                      <ArrowUpRight className="w-4 h-4" /> Browse this branch’s changes
                    </button>
                  </HoverTip>
                )}
              </Section>

              <WhatsNextPanel items={ready.items} onAct={act} busy={actions.busy}
                custom={{
                  update_from_parent: forksOn && canPublish
                    ? <UpdateFromParentButton wsId={wsId} forkGraphId={pr.graphId} onUpdated={clearForkBehind} /> : null,
                }} />

              {viewChanges && viewChangeCount > 0 && pr.sourceBranchId && (
                <Section icon={LayoutTemplate} title={`Views (${viewChangeCount})`}
                  right={<span className="text-[10px] normal-case font-normal">go live when this merges</span>}>
                  <DraftViewChanges changes={viewChanges} branchId={pr.sourceBranchId} onNavigate={onClose} />
                </Section>
              )}
            </>
          )}
        </div>

        {/* Merging what is accepted: the rejected ones can leave the draft in the same step. */}
        {pr && mergeInPart && rejected > 0 && canMerge && !sentBack && !needsPull && (
          <label className="mx-5 mb-1 flex items-center gap-2 text-[12px] text-ink-secondary cursor-pointer select-none">
            <input type="checkbox" checked={discardOnMerge} onChange={(e) => setDiscardOnMerge(e.target.checked)}
              className="rounded border-glass-border text-accent-lineage focus:ring-accent-lineage/40" />
            Also discard the {rejected.toLocaleString()} rejected change{rejected === 1 ? '' : 's'} from the draft
            <span className="text-ink-muted">— only what nobody decided stays on it</span>
          </label>
        )}

        {/* The next thing to do — none while a job merges it, which nothing may change meanwhile. */}
        {pr && !terminal && (ready.primary || actions.canFinish) && (
          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center justify-end">
            <ReviewPrimaryAction wsId={wsId} actions={actions} primary={ready.primary} approveAll={ready.approveAll}
              onAct={act} finish={{ to: `${page}?finish=1`, onGo: onClose }} />
          </div>
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
