/**
 * PrDetailDrawer — the review surface for one PR: overview + reviewers/approval, the
 * itemised Files Changed (unified ChangesPanel), a derived activity timeline, and the
 * Approve / Merge / Close actions. Merge is conflict-aware: a conflict opens the
 * ConflictResolver, whose resolutions feed straight back into a re-merge.
 *
 * Mounted only while a PR is selected (fresh queries per prId).
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, GitMerge, GitBranch, User, Clock, CheckCircle2, XCircle, Loader2, FileDiff, ShieldCheck,
  GitPullRequestArrow, Pencil, Check, ArrowDownToLine, ArrowUpRight, AlertTriangle, GitCommitHorizontal,
  Undo2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { timeAgo } from '@/lib/timeAgo'
import { MergeConflictError, NotUpToDateError, type ResolutionMap } from '@/services/versioningApiService'
import {
  useMergeRequest, usePullRequestDiff, usePullLatestDraft, useCommitLog,
  useApproveMergeRequest, useCloseMergeRequest, useMergeMergeRequest, useUpdateMergeRequest,
} from '../../versioning/hooks/useVersioning'
import { fromPrDiff } from '../../versioning/model/changeAdapters'
import { ChangesPanel, ChangeCountChips } from '../../versioning/components/ChangesPanel'
import { CommitRow } from '../../versioning/components/CommitRow'
import { RevertDialog } from '../../versioning/components/RollbackDialogs'
import { ownerName } from '../../versioning/model/branchVocab'
import { usePermission, useAuthStore } from '@/store/auth'
import { useFeature } from '@/store/features'
import { useBranchStore } from '@/store/branchStore'
import { useToast } from '@/components/ui/toast'
import { PrStatusBadge, ApprovalPill, PrKindIcon, derivePrTitle, isDraftMr } from './PrMeta'
import { ConflictResolver } from './ConflictResolver'

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

export function PrDetailDrawer({ wsId, prId, onClose }: { wsId: string; prId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const canManage = usePermission('workspace:datasource:manage', wsId)
  const user = useAuthStore((s) => s.user)
  const switchToMain = useBranchStore((s) => s.switchToMain)

  const prQ = useMergeRequest(wsId, prId)
  const diffQ = usePullRequestDiff(wsId, prId)
  const approve = useApproveMergeRequest(wsId)
  const closePr = useCloseMergeRequest(wsId)
  const merge = useMergeMergeRequest(wsId)
  const update = useUpdateMergeRequest(wsId)
  const pullLatest = usePullLatestDraft(wsId, prQ.data?.graphId ?? '')

  const pr = prQ.data

  // Pre-merge: the draft's individual commits (each with its author), expandable to per-commit diffs.
  // Draft MRs only — a fork PR's source branch lives on another graph (legacy), so leave it disabled.
  // Reviewers/managers are authorised to read these by the backend's PR-participant rule.
  const isDraftPr = !!pr && isDraftMr(pr)
  const commitsQ = useCommitLog(wsId, isDraftPr ? pr!.graphId : null, pr?.sourceBranchId ?? null)
  const commits = (commitsQ.data?.commits ?? []) as Array<Record<string, unknown>>
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
        onSuccess: () => { setEditing(false); showToast('success', 'Updated.') },
        onError: (e) => showToast('error', (e as Error).message),
      },
    )
  }
  const changeSet = useMemo(() => (diffQ.data ? fromPrDiff(diffQ.data, prId) : null), [diffQ.data, prId])
  // entityId → merged payload, the seed each conflict resolution starts from.
  const seeds = useMemo(() => {
    const out: Record<string, Record<string, unknown> | undefined> = {}
    const d = diffQ.data
    if (d) for (const e of [...d.added, ...d.modified]) out[e.entityId] = (e.after as Record<string, unknown>) ?? undefined
    return out
  }, [diffQ.data])

  const [conflicts, setConflicts] = useState<Array<Record<string, unknown>> | null>(null)
  const [resolverError, setResolverError] = useState<string | null>(null)
  const [needsPull, setNeedsPull] = useState(false)
  const [resolveMode, setResolveMode] = useState<'merge' | 'pull'>('merge')
  const [dismissing, setDismissing] = useState(false)
  // "Revert this merge" (merged PRs): the merge's squash commit is revertable
  // like any other main revision — the dialog owns the confirm + conflict UX.
  const versioningEnabled = useFeature('versioningEnabled')
  const [reverting, setReverting] = useState(false)

  const terminal = pr?.status === 'merged' || pr?.status === 'closed'
  const isAuthor = !!user && pr?.actor === user.id
  const alreadyApproved = !!user && (pr?.approvedBy ?? []).includes(user.id)
  const hasReviewers = (pr?.reviewers?.length ?? 0) > 0
  const showApprove = canManage && !terminal && !isAuthor && !alreadyApproved && hasReviewers
  const busy = approve.isPending || closePr.isPending || merge.isPending || pullLatest.isPending

  // Proactive gate: the server flags a draft MR that lags main head. Mirror it into needsPull so the
  // banner + Pull-latest show up front (the 409 catch in runMerge is the backstop). A clean pull
  // clears it and invalidates this PR, so pr.behind flips false and keeps it cleared.
  useEffect(() => { setNeedsPull(!terminal && !!pr?.behind) }, [pr?.behind, terminal])

  const runMerge = async (resolutions?: ResolutionMap) => {
    if (!pr) return
    try {
      await merge.mutateAsync({ prId, graphId: pr.graphId, message: `Merge: ${derivePrTitle(pr)}`, resolutions })
      setConflicts(null)
      setResolverError(null)
      showToast('success', `Merged into ${pr.targetBranch}.`)
      // Land on the freshly-merged main and close the drawer (mirror CommitDialog) so the canvas
      // reflects the merge; read-your-writes serves main even before the projection catches up.
      switchToMain()
      onClose()
    } catch (e) {
      if (e instanceof NotUpToDateError) {
        setNeedsPull(true)
        showToast('error', 'This draft is out of date — pull the latest changes before merging.')
        return
      }
      if (e instanceof MergeConflictError) {
        setConflicts(e.conflicts)
        setResolverError(resolutions ? 'Some fields still conflict — adjust and retry.' : null)
        return
      }
      const msg = (e as Error).message
      const friendly = /approval_required/i.test(msg)
        ? 'This PR needs approval from its reviewers before it can be merged.'
        : msg
      if (resolutions) setResolverError(friendly)
      else showToast('error', friendly)
    }
  }

  const runPull = (resolutions?: ResolutionMap) => {
    if (!pr) return
    pullLatest.mutate(
      { branchId: pr.sourceBranchId, resolutions },
      {
        onSuccess: (res) => {
          if (res.clean) {
            setConflicts(null); setResolverError(null); setResolveMode('merge'); setNeedsPull(false)
            showToast('success', 'Pulled the latest changes — you can merge now.')
          } else {
            setResolveMode('pull'); setConflicts(res.conflicts)
            setResolverError(resolutions ? 'Some fields still conflict — adjust and retry.' : null)
          }
        },
        onError: (e) => showToast('error', (e as Error).message),
      },
    )
  }

  const events = useMemo(() => {
    type Ev = { Icon: React.ComponentType<{ className?: string }>; text: string; time?: string; tint: string }
    if (!pr) return [] as Ev[]
    const evs: Ev[] = [{ Icon: GitPullRequestArrow, text: `Opened by ${ownerName(pr.actor, pr.userNames)}`, time: pr.createdAt, tint: 'bg-accent-lineage' }]
    for (const a of pr.approvedBy ?? []) evs.push({ Icon: CheckCircle2, text: `Approved by ${ownerName(a, pr.userNames)}`, time: pr.updatedAt, tint: 'bg-emerald-500' })
    if (pr.status === 'merged') evs.push({ Icon: GitMerge, text: `Merged by ${ownerName(pr.mergedBy, pr.userNames)}${pr.resultingCommitId ? ` · ${pr.resultingCommitId.slice(0, 8)}` : ''}`, time: pr.mergedAt ?? pr.updatedAt, tint: 'bg-violet-500' })
    if (pr.status === 'closed') evs.push({ Icon: XCircle, text: `Closed by ${ownerName(pr.closedBy, pr.userNames)}`, time: pr.closedAt ?? pr.updatedAt, tint: 'bg-ink-muted' })
    return evs
  }, [pr])

  return createPortal(
    <>
      <Backdrop open={true} onClick={onClose} zClassName="z-[60]" className="bg-black/40" />
      <AnimatePresence>
      <motion.aside
        className="fixed right-0 top-0 h-full w-[520px] max-w-[92vw] z-[61] bg-canvas border-l border-glass-border flex flex-col shadow-lg"
        initial={{ x: 520 }} animate={{ x: 0 }} exit={{ x: 520 }} transition={{ type: 'spring', damping: 30, stiffness: 300 }}
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
                      {pr.reviewers!.map((r) => (
                        <span key={r} className={cn('px-1.5 py-0.5 rounded text-[11px]', (pr.approvedBy ?? []).includes(r) ? 'bg-emerald-500/10 text-emerald-600' : 'bg-ink/5 text-ink-muted')}>
                          {ownerName(r, pr.userNames)}{(pr.approvedBy ?? []).includes(r) ? ' ✓' : ''}
                        </span>
                      ))}
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

              <Section icon={FileDiff} title="Files changed" right={changeSet ? <ChangeCountChips changeSet={changeSet} /> : undefined}>
                {diffQ.isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-ink-muted py-6 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" /> Computing diff…
                  </div>
                ) : changeSet ? (
                  <ChangesPanel changeSet={changeSet} emptyHint="No changes in this PR." />
                ) : (
                  <p className="text-xs text-ink-muted py-3">Diff unavailable.</p>
                )}
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
            <span>This draft is behind <strong>main</strong>{pr.behindBy ? ` by ${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'}` : ''}. Pull the latest changes (resolving any conflicts) before it can be merged.</span>
          </div>
        )}

        {/* Action bar */}
        {pr && !terminal && canManage && !dismissing && (
          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center gap-2">
            {showApprove && (
              <button
                onClick={() => approve.mutate({ prId, graphId: pr.graphId }, {
                  onSuccess: () => showToast('success', 'Approved.'),
                  onError: (e) => showToast('error', (e as Error).message),
                })}
                disabled={busy}
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
            ) : (
              <button
                onClick={() => runMerge()}
                disabled={busy}
                title="Apply these changes to main"
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
        {pr && !terminal && canManage && dismissing && (
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
                  onSuccess: () => { showToast('success', 'Request dismissed — no changes applied.'); onClose() },
                  onError: (e) => { showToast('error', (e as Error).message); setDismissing(false) },
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
        {pr && pr.status === 'merged' && canManage && versioningEnabled && pr.resultingCommitId && (
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
            graphId={pr.graphId}
            userNames={pr.userNames}
            onClose={() => setReverting(false)}
          />
        )}

        {conflicts && (
          <ConflictResolver
            conflicts={conflicts}
            seeds={seeds}
            busy={merge.isPending || pullLatest.isPending}
            error={resolverError}
            onCancel={() => { setConflicts(null); setResolverError(null); setResolveMode('merge') }}
            onResolve={(resolutions) => (resolveMode === 'pull' ? runPull(resolutions) : runMerge(resolutions))}
          />
        )}
      </motion.aside>
      </AnimatePresence>
    </>,
    document.body,
  )
}
