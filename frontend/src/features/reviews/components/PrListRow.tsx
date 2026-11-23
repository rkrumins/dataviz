/**
 * PrListRow — one merge request in the Review Center list. Premium, information-dense row:
 * who raised it (avatar + name, a dot while something on it is unread), the REAL source branch →
 * target, a lazy change-count chip (added/modified/removed via usePrDiffSummary), whether it changed
 * since you reviewed it, open threads, approvals and the reviewer avatar stack, staleness, data
 * source, and when it was last active. Click opens it (`onOpen`).
 */
import { useState } from 'react'
import { ChevronRight, GitMerge, AlertTriangle, Plus, Minus, PencilLine, XCircle, Check, X, Loader2, MessageSquare, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'
import { HoverTip } from '@/components/ui/HoverTip'
import { DateTime } from '@/components/ui/DateTime'
import type { PullRequest } from '@/services/versioningApiService'
import { usePrDiffSummary, useCloseMergeRequest, useChangeSummary } from '@/features/versioning/hooks/useVersioning'
import { ownerName } from '@/features/versioning/model/branchVocab'
import { OwnerAvatar } from '@/features/versioning/components/BranchStatusBits'
import { PrStatusBadge, PrKindIcon, ApprovalPill, derivePrTitle, isDraftMr } from './PrMeta'

const COUNTED_STATUSES = new Set(['open', 'mergeable', 'approved', 'conflicts', 'merging'])

/** Lazy per-row change-count chip. Only fetches for active PRs (a merged/closed PR's diff is
 *  historical); React Query dedups + caches so pagination re-renders are free. A draft's review is
 *  counted from its change index (cached, one row per change) — never a merge per inbox row; a
 *  fork's from its capped summary. */
function ChangeCount({ wsId, pr }: { wsId: string; pr: PullRequest }) {
  // Its own separator, so a row with no count (a merged review, a summary that didn't load)
  // doesn't read "· ·".
  const dot = <span className="text-ink-muted/40">·</span>
  const enabled = COUNTED_STATUSES.has(pr.status)
  const draft = isDraftMr(pr)
  const draftQ = useChangeSummary(enabled && draft ? wsId : undefined, pr.graphId,
    enabled && draft ? { branchId: pr.sourceBranchId } : null)
  const forkQ = usePrDiffSummary(enabled && !draft ? wsId : undefined, enabled && !draft ? pr.prId : undefined, 1)
  const q = draft ? draftQ : forkQ
  if (!enabled) return null
  const c = q.data?.counts
  if (!c) {
    return q.isLoading ? <>{dot}<span className="text-[11px] text-ink-muted/50 tabular-nums">…</span></> : null
  }
  const total = c.added + c.modified + c.removed
  if (total === 0) return <>{dot}<span className="text-[11px] text-ink-muted/60">no changes</span></>
  return (<>
    {dot}
    <HoverTip label={`${c.added} added · ${c.modified} modified · ${c.removed} removed`}
      className="inline-flex items-center gap-2 text-[11px] font-medium tabular-nums">
      <span className="text-ink-muted">{total} change{total === 1 ? '' : 's'}</span>
      <span className="inline-flex items-center gap-1.5">
        {c.added > 0 && <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"><Plus className="w-2.5 h-2.5" strokeWidth={3} />{c.added}</span>}
        {c.modified > 0 && <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"><PencilLine className="w-2.5 h-2.5" strokeWidth={2.6} />{c.modified}</span>}
        {c.removed > 0 && <span className="inline-flex items-center gap-0.5 text-rose-500"><Minus className="w-2.5 h-2.5" strokeWidth={3} />{c.removed}</span>}
      </span>
    </HoverTip>
  </>)
}

/** Up to 3 reviewer avatars, overlapping, +N overflow. Each names itself on hover; how far the
 *  approvals are is the ApprovalPill beside it. */
function ReviewerStack({ pr }: { pr: PullRequest }) {
  const reviewers = pr.reviewers ?? []
  if (reviewers.length === 0) return null
  const shown = reviewers.slice(0, 3)
  const overflow = reviewers.length - shown.length
  const approved = new Set(pr.approvedBy ?? [])
  return (
    <span className="flex items-center">
      <span className="flex -space-x-1.5">
        {shown.map((r) => (
          <span key={r} className={cn('rounded-full ring-2 ring-canvas-elevated', approved.has(r) && 'ring-emerald-400/70')}>
            <OwnerAvatar owner={r} userNames={pr.userNames} size="sm" />
          </span>
        ))}
      </span>
      {overflow > 0 && <span className="ml-1 text-[10px] font-semibold text-ink-muted tabular-nums">+{overflow}</span>}
    </span>
  )
}

export function PrListRow({
  wsId,
  pr,
  sourceLabel,
  workspace,
  onOpen,
}: {
  wsId: string
  pr: PullRequest
  /** Which data source this PR belongs to (shown in the workspace inbox). */
  sourceLabel?: string
  /** Which workspace it lives in — shown when the list spans workspaces. */
  workspace?: { id: string; name: string }
  onOpen: () => void
}) {
  const branchName = pr.sourceBranchName?.trim() || (isDraftMr(pr) ? 'draft' : pr.sourceBranchId?.slice(0, 8)) || 'fork'
  const author = ownerName(pr.actor, pr.userNames)
  const behind = (pr.pullRequired ?? pr.behind) && (pr.behindBy ?? 0) > 0
  const openThreads = pr.review?.threads.open ?? 0
  const closePr = useCloseMergeRequest(wsId)
  const [confirming, setConfirming] = useState(false)
  // Only an active PR can be dismissed — never one a job is merging, which the server refuses.
  const canDismiss = COUNTED_STATUSES.has(pr.status) && pr.status !== 'merging'

  return (
    // A clickable <div> (not <button>) so the inline Dismiss controls can be real nested buttons.
    <div
      role="button"
      tabIndex={0}
      data-pr-row={pr.prId}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className={cn(
        'group w-full flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-2xl border border-glass-border bg-canvas-elevated/50 px-4 py-3 text-left cursor-pointer',
        'hover:border-accent-lineage/40 hover:bg-canvas-elevated/80 hover:shadow-sm transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
      )}
    >
      {/* Identity — who raised it, with the PR kind as a corner badge, and a dot while something
          someone else did on it is unread */}
      <span className="relative shrink-0">
        <OwnerAvatar owner={pr.actor} userNames={pr.userNames} size="md" />
        <span className="absolute -bottom-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-canvas-elevated border border-glass-border">
          <PrKindIcon pr={pr} className="w-2.5 h-2.5 text-ink-muted" />
        </span>
        {pr.unread && (
          <span role="img" aria-label="Unread"
            className="absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />
        )}
      </span>

      <div className="min-w-[12rem] flex-1">
        {/* Title + status */}
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <p className="text-[14px] font-semibold text-ink truncate">{derivePrTitle(pr)}</p>
          <PrStatusBadge status={pr.status} />
          {behind && (
            <HoverTip label={`Behind main by ${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'} — pull latest before merging`}
              className="inline-flex shrink-0">
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">
                <AlertTriangle className="w-2.5 h-2.5" /> behind {pr.behindBy}
              </span>
            </HoverTip>
          )}
          {pr.review?.you?.updatedSinceReviewed && (
            <HoverTip label="Look again: your verdict was on an earlier version" className="inline-flex shrink-0">
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                <RefreshCw className="w-2.5 h-2.5" aria-hidden /> Updated since you reviewed
              </span>
            </HoverTip>
          )}
        </div>

        {/* Meta line: branch → target · source · changes · by author · time */}
        <div className="flex items-center gap-2 mt-1 text-[11.5px] text-ink-muted min-w-0 flex-wrap">
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink/70 min-w-0">
            <HoverTip label={branchName} className="truncate max-w-[180px]">{branchName}</HoverTip>
            <GitMerge className="w-3 h-3 text-ink-muted/60 shrink-0" />
            <span className="text-ink-muted">{pr.targetBranch}</span>
          </span>
          {workspace && (
            <span className={cn('inline-flex items-center rounded-full border px-1.5 py-px text-[10.5px] font-semibold truncate max-w-[160px]',
              workspaceColor(workspace.id).bg, workspaceColor(workspace.id).text, workspaceColor(workspace.id).border)}>
              {workspace.name}
            </span>
          )}
          {sourceLabel && (<><span className="text-ink-muted/40">·</span><span className="truncate max-w-[160px]">{sourceLabel}</span></>)}
          <ChangeCount wsId={wsId} pr={pr} />
          <span className="text-ink-muted/40">·</span>
          <span>by <span className="text-ink/70 font-medium">{author}</span></span>
          <span className="text-ink-muted/40">·</span>
          <DateTime at={pr.lastActivityAt ?? pr.createdAt} prefix={pr.lastActivityAt ? 'active ' : 'opened '} />
        </div>
      </div>

      {openThreads > 0 && (
        <HoverTip label={`${openThreads} open thread${openThreads === 1 ? '' : 's'}`}
          detail={pr.review?.threads.holdMerge ? 'They hold the merge until resolved' : undefined}
          className="inline-flex shrink-0">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted tabular-nums">
            <MessageSquare className="w-3.5 h-3.5" aria-hidden /> {openThreads}
          </span>
        </HoverTip>
      )}
      <ApprovalPill pr={pr} />
      <ReviewerStack pr={pr} />

      {/* Dismiss — reject the PR (close without merging; no changes are taken). Inline confirm. */}
      {canDismiss && (
        confirming ? (
          <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            <span className="text-[11px] text-ink-muted mr-0.5 hidden sm:inline">Dismiss?</span>
            <HoverTip label="Close the request without merging" className="inline-flex">
              <button
                onClick={(e) => { e.stopPropagation(); closePr.mutate({ prId: pr.prId, graphId: pr.graphId }, { onSuccess: () => setConfirming(false) }) }}
                disabled={closePr.isPending}
                aria-label="Confirm dismiss"
                className="p-1.5 rounded-lg bg-rose-500/15 text-rose-500 hover:bg-rose-500/25 transition-colors disabled:opacity-60"
              >{closePr.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" strokeWidth={2.6} />}</button>
            </HoverTip>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirming(false) }}
              aria-label="Cancel"
              className="p-1.5 rounded-lg text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            ><X className="w-3.5 h-3.5" /></button>
          </span>
        ) : (
          <HoverTip label="Reject these changes without merging" detail="Nothing is applied to main" className="inline-flex shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setConfirming(true) }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-ink-muted/60 border border-transparent hover:bg-rose-500/10 hover:text-rose-500 hover:border-rose-500/20 transition-all"
            ><XCircle className="w-3.5 h-3.5" /> Dismiss</button>
          </HoverTip>
        )
      )}

      <ChevronRight className="w-4 h-4 text-ink-muted/40 group-hover:text-accent-lineage transition-colors shrink-0" />
    </div>
  )
}
